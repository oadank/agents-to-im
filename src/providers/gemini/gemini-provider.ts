/**
 * Gemini Provider — Gemini CLI ACP (Agent Chat Protocol) integration
 *
 * 调用 gemini --acp --yolo 子进程，通过 JSON-RPC 2.0 over stdin/stdout 通信
 * 使用 GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL 指向 LiteLLM 代理
 *
 * ACP 协议（基于 Zed/Gemini 兼容）：
 * - initialize → authenticate(gateway) → session/new → session/prompt
 * - session/update notifications: agent_message_chunk, available_commands_update
 *
 * Session update 事件映射：
 * - agent_message_chunk → text
 * - available_commands_update → 忽略（命令列表，非对话内容）
 */

import { GeminiAppServerClient, type GeminiServerMessage } from './gemini-app-server-client.js';
import type { LLMProvider, StreamChatParams } from '../../bridge/host.js';
import { emitCanonicalTurnEvent } from '../../infra/sse-utils.js';

type JsonRecord = Record<string, unknown>;

// ── Gemini ACP types ────────────────────────────────────────────────────────

interface GeminiSessionNewResult {
  sessionId: string;
  modes?: {
    availableModes: Array<{ id: string; name: string; description: string }>;
    currentModeId: string;
  };
  models?: {
    availableModels: Array<{ modelId: string; name: string; description: string }>;
    currentModelId: string;
  };
}

interface GeminiPromptResult {
  stopReason: string;
  _meta?: {
    quota?: {
      token_count?: {
        input_tokens?: number;
        output_tokens?: number;
      };
      model_usage?: unknown[];
    };
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function extractSessionId(msg: GeminiServerMessage): string {
  const params = typeof msg.params === 'object' && msg.params ? msg.params as JsonRecord : {};
  return typeof params.sessionId === 'string' ? params.sessionId : '';
}

function sessionUpdateType(params: JsonRecord): string {
  const update = params.update as JsonRecord | undefined;
  if (!update) return '';
  return typeof update.sessionUpdate === 'string' ? String(update.sessionUpdate) : '';
}

// ── GeminiProvider ───────────────────────────────────────────────────────────

export interface GeminiConfig {
  cliPath?: string;
  acpArgs?: string[];
  apiKey?: string;
  baseUrl?: string;
  workingDirectory?: string;
}

export class GeminiProvider implements LLMProvider {
  private client: GeminiAppServerClient | null = null;
  private pidChanged = false;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly cliPath: string;
  private readonly acpArgs: string[];
  private readonly workingDirectory: string;
  // 累积缓冲区：用于处理跨 chunk 的 <think> 标签
  private thinkingBuffer = '';

  constructor(config?: GeminiConfig) {
    this.apiKey = config?.apiKey || process.env.CTI_GEMINI_API_KEY || process.env.LITELLM_API_KEY || 'sk-200418';
    this.baseUrl = config?.baseUrl || process.env.CTI_GEMINI_BASE_URL || 'http://127.0.0.1:4000';
    this.cliPath = config?.cliPath || process.env.CTI_GEMINI_CLI_PATH || 'gemini';
    // 添加 --include-directories 让 gemini-cli 可以访问更多目录
    const includeDirs = process.platform === 'win32'
      ? '--include-directories=C:\\,C:\\Users,C:\\D'
      : '--include-directories=/,/root,/opt,/tmp';
    this.acpArgs = config?.acpArgs || ['--acp', '--yolo', includeDirs];
    // Windows 上使用 Windows 路径，默认为用户目录
    const defaultWorkDir = process.platform === 'win32'
      ? (process.env.CTI_GEMINI_WORKING_DIR || 'C:\\Users\\oadan')
      : (process.env.CTI_GEMINI_WORKING_DIR || '/opt');
    this.workingDirectory = config?.workingDirectory || defaultWorkDir;
  }

  private async ensureClient(): Promise<GeminiAppServerClient> {
    if (this.client) {
      await this.client.prepare();
      return this.client;
    }
    const client = new GeminiAppServerClient({
      executable: this.cliPath,
      acpArgs: this.acpArgs,
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
    });
    if (client.checkPidChanged()) {
      this.pidChanged = true;
    }
    await client.prepare();
    this.client = client;
    return client;
  }

  async prepare(): Promise<void> {
    await this.ensureClient();
  }

  didPidChange(): boolean {
    return this.pidChanged;
  }

  resetPidChanged(): void {
    this.pidChanged = false;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;
    return new ReadableStream<string>({
      start(controller) {
        void self.run(controller, params);
      },
    });
  }

  private async run(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
  ): Promise<void> {
    // 清空思考缓冲区
    this.thinkingBuffer = '';
    const client = await this.ensureClient();
    let unsubscribe: (() => void) | null = null;
    const queue: GeminiServerMessage[] = [];
    let wakeQueue: (() => void) | null = null;

    try {
      // 创建会话
      const newSession = await client.call<GeminiSessionNewResult>('session/new', {
        cwd: params.workingDirectory || this.workingDirectory,
        mcpServers: [],
      });
      const sessionId = newSession.sessionId;
      console.log(`[gemini-provider] Session ${sessionId} created (model: ${newSession.models?.currentModelId || 'unknown'})`);

      // 订阅 server notifications
      unsubscribe = client.subscribe((message) => {
        if (extractSessionId(message) !== sessionId) return;
        queue.push(message);
        wakeQueue?.();
        wakeQueue = null;
      });

      emitCanonicalTurnEvent(controller, {
        type: 'status',
        data: { session_id: sessionId },
      });

      // 发送 prompt
      const promptInput = this.buildPrompt(params);
      const result = await client.call<GeminiPromptResult>('session/prompt', {
        sessionId,
        prompt: promptInput,
      });

      // 处理流式 notifications（result 返回后，队列里可能还有攒着的 notifications）
      const MAX_DRAIN_WAIT_MS = 3000;
      const drainStart = Date.now();
      while (true) {
        if (params.abortController?.signal.aborted) break;

        let message: GeminiServerMessage | null;
        try {
          message = await this.readNext(queue, () => {
            if (wakeQueue) return;
            wakeQueue = () => {};
          }, () => {
            // 队列空且 result 已回：用定时器确保在剩余时间内退出
            const elapsed = Date.now() - drainStart;
            if (elapsed >= MAX_DRAIN_WAIT_MS || queue.length > 0) {
              if (queue.length === 0) return Promise.reject(new Error('drain-done'));
              return; // 队列有数据，返回 undefined 让 readNext 重新检查
            }
            // 创建带超时的等待：剩余时间后自动 reject
            const remainingMs = MAX_DRAIN_WAIT_MS - elapsed;
            return new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('drain-done')), remainingMs);
              wakeQueue = () => {
                clearTimeout(timer);
                resolve();
              };
            });
          });
        } catch (e) {
          if ((e as Error)?.message === 'drain-done') break;
          throw e;
        }
        if (!message) continue;
        if (message.kind === 'request') continue; // 暂不支持 request

        const paramsRecord = (typeof message.params === 'object' && message.params ? message.params as JsonRecord : {});
        const updateType = sessionUpdateType(paramsRecord);
        const update = paramsRecord.update as JsonRecord | undefined;
        const content = update?.content as JsonRecord | undefined;
        console.log(`[gemini-provider] updateType=${updateType}`);

        switch (updateType) {
          case 'agent_message_chunk':
            if (content && typeof content.text === 'string') {
              const text = content.text;
              console.log(`[gemini-provider] agent_message_chunk len=${text.length} buffer_len=${this.thinkingBuffer.length}`);
              // 累积到缓冲区
              this.thinkingBuffer += text;

              // 尝试提取完整的 <think> 标签
              const thinkingMatch = this.thinkingBuffer.match(/<think>([\s\S]*?)<\/think>/);
              if (thinkingMatch) {
                // 有完整 <think> 标签：提取思考内容，发送为 reasoning_activity
                const thinkingText = thinkingMatch[1].trim();
                const bodyText = this.thinkingBuffer.replace(/<think>[\s\S]*?<\/think>/, '').trim();
                if (thinkingText) {
                  emitCanonicalTurnEvent(controller, {
                    type: 'activity_event',
                    data: {
                      kind: 'reasoning_activity',
                      turnId: sessionId,
                      status: 'completed',
                      text: thinkingText,
                    },
                  });
                }
                // 清空缓冲区，只保留 <think> 标签之后的文本
                this.thinkingBuffer = bodyText;
                // 发送 <think> 标签之后的普通文本
                if (bodyText) {
                  emitCanonicalTurnEvent(controller, { type: 'text', data: bodyText });
                }
              } else if (this.thinkingBuffer.includes('<think>') && !this.thinkingBuffer.includes('</think>')) {
                // 不完整的 <think> 标签（思考进行中）：提取思考内容发送，但不发送普通文本
                const partialThinking = this.thinkingBuffer.replace(/<think>/g, '').trim();
                if (partialThinking) {
                  emitCanonicalTurnEvent(controller, {
                    type: 'activity_event',
                    data: {
                      kind: 'reasoning_activity',
                      turnId: sessionId,
                      status: 'running',
                      text: partialThinking,
                    },
                  });
                }
              } else if (!this.thinkingBuffer.includes('<think>')) {
                // 没有 <think> 标签，清空缓冲区并发送普通文本
                this.thinkingBuffer = '';
                emitCanonicalTurnEvent(controller, { type: 'text', data: text });
              }
              // 如果有不完整的 <think> 标签，等待更多内容，不发送任何东西
            }
            break;
          case 'agent_thought_chunk':
            if (content && typeof content.text === 'string') {
              console.log(`[gemini-provider] agent_thought_chunk len=${content.text.length}`);
              emitCanonicalTurnEvent(controller, { type: 'status', data: { reasoning: content.text } });
            }
            break;
          case 'tool_call':
          case 'tool_call_update': {
            const toolInfo = update?.input ? `${update.title || 'tool'} ${JSON.stringify(update.input).slice(0, 100)}` : (update?.title || '工具');
            const toolStatus = (update?.status as string) || 'running';
            const toolCallId = String(update?.toolCallId || update?.callId || `gemini-tool:${update?.title || 'tool'}:${Date.now()}`);
            const toolName = String(update?.title || 'tool');
            console.log(`[gemini-provider] ACP tool_call: ${toolInfo} status=${toolStatus} id=${toolCallId}`);
            emitCanonicalTurnEvent(controller, {
              type: 'activity_event',
              data: {
                kind: 'tool_activity',
                toolUseId: toolCallId,
                toolName,
                status: toolStatus === 'failed' ? 'failed' : (toolStatus === 'completed' ? 'completed' : 'running'),
                inputPreview: update?.input && typeof update.input === 'object' ? JSON.stringify(update.input).slice(0, 220) : '',
                resultPreview: update?.output && typeof update.output === 'string' ? String(update.output).slice(0, 220) : '',
              },
            });
            break;
          }
          case 'available_commands_update':
            // 忽略命令列表
            break;
          case 'usage_update':
            // Gemini 的 quota 信息在 result 中返回，此处忽略
            break;
          default:
            // 忽略其他未处理的 update 类型
            break;
        }
      }

      // 发送最终 result
      const isError = result.stopReason !== 'end_turn';
      const usage = result._meta?.quota?.token_count;
      emitCanonicalTurnEvent(controller, {
        type: 'result',
        data: {
          session_id: sessionId,
          is_error: isError,
          ...(usage ? {
            usage: {
              input_tokens: usage.input_tokens || 0,
              output_tokens: usage.output_tokens || 0,
            },
          } : {}),
        },
      });

      // 压缩上下文（下次更快）
      try {
        await client.notify('session/compact', { sessionId });
      } catch {
        // non-critical
      }

      controller.close();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[gemini-provider] Error:', msg);
      try {
        emitCanonicalTurnEvent(controller, { type: 'error', data: msg });
        controller.close();
      } catch {
        // already closed
      }
    } finally {
      unsubscribe?.();
    }
  }

  private buildPrompt(
    params: StreamChatParams,
  ): Array<{ type: string; text?: string }> {
    const parts: Array<{ type: string; text?: string }> = [];

    // 注入历史（如果需要）
    const history = params.conversationHistory;
    if (history && history.length > 0) {
      const historyText = history
        .slice(-20)
        .map((msg) => `${msg.role === 'user' ? '用户' : '助手'}：${msg.content}`)
        .join('\n\n');
      parts.push({
        type: 'text',
        text: `以下是之前的对话历史，请继续对话：\n\n${historyText}\n\n---\n\n用户最新消息：\n${params.prompt}`,
      });
    } else {
      parts.push({ type: 'text', text: params.prompt });
    }

    return parts;
  }

  private async readNext(
    queue: GeminiServerMessage[],
    _arm: () => void,
    wait: () => Promise<void> | undefined,
  ): Promise<GeminiServerMessage | null> {
    if (queue.length > 0) return queue.shift() || null;
    const w = wait();
    if (w) await w;
    return queue.shift() || null;
  }
}

export function createGeminiProvider(config?: GeminiConfig): GeminiProvider {
  return new GeminiProvider(config);
}
