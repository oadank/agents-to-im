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
import { LARK_CLI_INSTRUCTIONS } from '../../config/runtime-configs.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

type JsonRecord = Record<string, unknown>;

function rtLog(msg: string): void {
  const DEBUG_LOG = `C:\\D\\opt\\agents-to-im\\debug_realtime_${process.env.CTI_BOT || 'gemini'}.log`;
  try {
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8');
  } catch {}
}

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
  modelGroup?: string;
  workingDirectory?: string;
}

export class GeminiProvider implements LLMProvider {
  private client: GeminiAppServerClient | null = null;
  private pidChanged = false;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly cliPath: string;
  private readonly acpArgs: string[];
  private readonly modelGroup: string;
  private readonly workingDirectory: string;
  // 累积缓冲区：用于处理跨 chunk 的  thinking 标签
  private thinkingBuffer = '';

  constructor(config?: GeminiConfig) {
    this.apiKey = config?.apiKey || process.env.CTI_GEMINI_API_KEY || process.env.LITELLM_API_KEY || 'sk-200418';
    this.baseUrl = config?.baseUrl || process.env.CTI_GEMINI_BASE_URL || 'http://127.0.0.1:4000';
    this.cliPath = config?.cliPath || process.env.CTI_GEMINI_CLI_PATH || 'gemini';
    // 优先从 settings.json 读取模型名，其次从环境变量，最后用默认值
    this.modelGroup = config?.modelGroup || this.readModelFromSettings() || process.env.CTI_BOT_GEMINI_MODEL_GROUP || 'gemini-model';
    // 添加 --include-directories 让 gemini-cli 可以访问更多目录
    const includeDirs = process.platform === 'win32'
      ? '--include-directories=C:\\,C:\\Users,C:\\D'
      : '--include-directories=/,/root,/opt,/tmp';
    this.acpArgs = config?.acpArgs || ['--acp', '--yolo', '--model', this.modelGroup, includeDirs];
    // Windows 上使用 Windows 路径，默认为用户目录
    const defaultWorkDir = process.platform === 'win32'
      ? (process.env.CTI_GEMINI_WORKING_DIR || 'C:\\Users\\oadan')
      : (process.env.CTI_GEMINI_WORKING_DIR || '/opt');
    this.workingDirectory = config?.workingDirectory || defaultWorkDir;
  }

  private readModelFromSettings(): string | undefined {
    try {
      const settingsPath = path.join(os.homedir(), '.gemini', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        return settings.model?.name;
      }
    } catch (e) {
      // ignore
    }
    return undefined;
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

    try {
      // 创建会话
      const newSession = await client.call<GeminiSessionNewResult>('session/new', {
        cwd: params.workingDirectory || this.workingDirectory,
        mcpServers: [],
      });
      const sessionId = newSession.sessionId;
      console.log(`[gemini-provider] Session ${sessionId} created (model: ${newSession.models?.currentModelId || 'unknown'})`);

      // 订阅 server notifications — 直接 emit 到流，不经过 queue（实时反馈）
      // ACP 协议保证：所有 agent_message_chunk 通知在 session/prompt RPC 响应之前到达
      unsubscribe = client.subscribe((message) => {
        if (extractSessionId(message) !== sessionId) return;

        // 立即处理 server request
        if (message.kind === 'request') {
          if (message.method === 'fs/read_text_file') {
            const reqParams = message.params as JsonRecord | undefined;
            const filePath = reqParams?.path ? String(reqParams.path) : '';
            rtLog(`[gemini-provider] Handling fs/read_text_file request: id=${message.id} path=${filePath}`);
            try {
              const content = fs.readFileSync(filePath, 'utf-8');
              client.respond(message.id, { content }).catch((err) => {
                console.error('[gemini-provider] Error responding to fs/read_text_file:', err);
              });
            } catch (err) {
              client.respondError(message.id, -32000, `Read failed: ${String(err)}`).catch(() => {});
            }
          } else {
            rtLog(`[gemini-provider] Unhandled server request: id=${message.id} method=${message.method}`);
            client.respondError(message.id, -32601, `Method not supported: ${message.method}`).catch(() => {});
          }
          return;
        }

        // 处理 notifications — 直接 emit 到流（实时反馈）
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

              // 兼容把思考内容嵌入标签的模型响应，避免在源码中写入字面 HTML 标签。
              const tagStart = String.fromCharCode(60) + 'think' + String.fromCharCode(62);
              const tagEnd = String.fromCharCode(60) + '/think' + String.fromCharCode(62);
              const startIndex = this.thinkingBuffer.indexOf(tagStart);
              const endIndex = this.thinkingBuffer.indexOf(tagEnd, Math.max(startIndex, 0));
              if (startIndex >= 0 && endIndex >= 0) {
                const thinkingText = this.thinkingBuffer
                  .slice(startIndex + tagStart.length, endIndex)
                  .trim();
                const bodyText = (
                  this.thinkingBuffer.slice(0, startIndex) +
                  this.thinkingBuffer.slice(endIndex + tagEnd.length)
                ).trim();
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
                this.thinkingBuffer = '';
                if (bodyText) {
                  emitCanonicalTurnEvent(controller, { type: 'text', data: bodyText });
                }
              } else if (startIndex >= 0) {
                const partialThinking = this.thinkingBuffer
                  .slice(startIndex + tagStart.length)
                  .trim();
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
              } else {
                this.thinkingBuffer = '';
                emitCanonicalTurnEvent(controller, { type: 'text', data: text });
              }
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
      });

      emitCanonicalTurnEvent(controller, {
        type: 'status',
        data: { session_id: sessionId },
      });

      // 发送 prompt（RPC 响应到达时，所有流式通知已通过订阅回调 emit）
      const promptInput = this.buildPrompt(params);
      const result = await client.call<GeminiPromptResult>('session/prompt', {
        sessionId,
        prompt: promptInput,
      });

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

    // 工具使用指令：强制使用 MCP run_bash 而非内置 run_shell_command
    // 原因：Gemini CLI 内置的 run_shell_command 使用 @lydell/node-pty，
    // 在 Windows 服务（Session 0）环境下 AttachConsole 失败（error code 5）。
    // mcp-shell（stdio MCP server，配置在 ~/.gemini/settings.json）提供 run_bash 工具，
    // 使用 child_process.exec + bash，在 Session 0 下正常工作。
    const toolInstruction =
      '【工具使用规则】执行 shell 命令时，必须使用 MCP 工具 `run_bash`，' +
      '禁止使用内置的 `run_shell_command`（当前 Windows 服务环境下会因 AttachConsole 失败而报错 code 5）。\n\n';

    // 注入语音标签（如果是语音消息）
    const audioPrefix = params.fromAudio ? '[Audio] ' : '';

    // 注入历史（如果需要）
    const history = params.conversationHistory;
    if (history && history.length > 0) {
      const historyText = history
        .slice(-20)
        .map((msg) => `${msg.role === 'user' ? '用户' : '助手'}：${msg.content}`)
        .join('\n\n');
      parts.push({
        type: 'text',
        text: `${toolInstruction}${LARK_CLI_INSTRUCTIONS}\n以下是之前的对话历史，请继续对话：\n\n${historyText}\n\n---\n用户最新消息：\n${audioPrefix}${params.prompt}`,
      });
    } else {
      parts.push({ type: 'text', text: `${toolInstruction}${LARK_CLI_INSTRUCTIONS}\n${audioPrefix}${params.prompt}` });
    }

    return parts;
  }
}

export function createGeminiProvider(config?: GeminiConfig): GeminiProvider {
  return new GeminiProvider(config);
}
