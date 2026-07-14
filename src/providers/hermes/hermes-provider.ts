/**
 * Hermes Provider — Hermes ACP (Agent Chat Protocol) integration
 *
 * 调用 hermes acp 子进程，通过 JSON-RPC 2.0 over stdin/stdout 通信
 * 使用 LiteLLM 的模型（codex-model）通过 Hermes CLI 内部转发
 *
 * ACP 协议（基于 Zed/Hermes 兼容）：
 * - initialize → 握手
 * - session/new → 创建会话
 * - session/prompt → 发送消息
 * - session/compact → 压缩上下文
 * - session/reset → 清空历史
 * - session/resume → 恢复会话
 *
 * Session update 事件映射：
 * - agent_message_chunk → text
 * - agent_thought_chunk → reasoning
 * - usage_update → context_usage
 */

import { HermesAppServerClient, type HermesServerMessage } from './hermes-app-server-client.js';
import type { LLMProvider, StreamChatParams } from '../../bridge/host.js';
import { emitCanonicalTurnEvent } from '../../infra/sse-utils.js';
import fs from 'node:fs';

function rtLog(msg: string): void {
  const DEBUG_LOG = `C:\\D\\opt\\agents-to-im\\debug_realtime_${process.env.CTI_BOT || 'unknown'}.log`;
  try {
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8');
  } catch {}
}

type JsonRecord = Record<string, unknown>;

// ── Hermes ACP types ────────────────────────────────────────────────────────

interface HermesInitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    loadSession: boolean;
    promptCapabilities: { image: boolean };
    sessionCapabilities: {
      fork: Record<string, unknown>;
      list: Record<string, unknown>;
      resume: Record<string, unknown>;
    };
  };
  agentInfo: { name: string; version: string };
  authMethods: Array<{
    id: string;
    name: string;
    description: string;
    type: string;
    args?: string[];
  }>;
}

interface HermesSessionNewResult {
  sessionId: string;
  models: {
    availableModels: Array<{ modelId: string; name: string; description: string }>;
  };
  _meta?: {
    hermes?: {
      sessionProvenance: {
        acpSessionId: string;
        currentHermesSessionId: string;
        rootHermesSessionId: string;
        parentHermesSessionId: string | null;
        sessionKind: string;
        compressionDepth: number;
      };
    };
  };
}

interface HermesPromptResult {
  stopReason: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens: number;
    thoughtTokens: number;
    totalTokens: number;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function extractSessionId(msg: HermesServerMessage): string {
  const params = typeof msg.params === 'object' && msg.params ? msg.params as JsonRecord : {};
  return typeof params.sessionId === 'string' ? params.sessionId : '';
}

function sessionUpdateType(params: JsonRecord): string {
  const update = params.update as JsonRecord | undefined;
  if (!update) return '';
  return typeof update.sessionUpdate === 'string' ? String(update.sessionUpdate) : '';
}

// ── HermesProvider ───────────────────────────────────────────────────────────

export interface HermesConfig {
  cliPath?: string;
  acpArgs?: string[];
  workingDirectory?: string;
}

export class HermesProvider implements LLMProvider {
  private client: HermesAppServerClient | null = null;
  private pidChanged = false;
  private readonly cliPath: string;
  private readonly acpArgs: string[];
  private readonly workingDirectory: string;

  constructor(config?: HermesConfig) {
    this.cliPath = config?.cliPath || process.env.CTI_HERMES_CLI_PATH || 'hermes';
    this.acpArgs = config?.acpArgs || this.buildAcpArgs();
    this.workingDirectory = config?.workingDirectory || process.env.CTI_HERMES_WORKING_DIR || '/opt';
  }

  private buildAcpArgs(): string[] {
    const base = ['acp', '--accept-hooks', '--yes'];
    const extra = process.env.CTI_HERMES_ACP_ARGS?.trim();
    if (extra) {
      base.push(...extra.split(/\s+/));
    }
    return base;
  }

  private async ensureClient(): Promise<HermesAppServerClient> {
    if (this.client) {
      await this.client.prepare();
      return this.client;
    }
    const client = new HermesAppServerClient(this.cliPath, this.acpArgs);
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
    const client = await this.ensureClient();
    let unsubscribe: (() => void) | null = null;

    try {
      // 创建会话
      const newSession = await client.call<HermesSessionNewResult>('session/new', {
        cwd: params.workingDirectory || this.workingDirectory,
        mcpServers: [],
        provider: 'custom:litellm',
        model: 'MiMogo',
      });
      const sessionId = newSession.sessionId;
      console.log(`[hermes-provider] Session ${sessionId} created`);

      // 订阅 server notifications — 直接 emit 到流，不经过 queue
      // ACP 协议保证：所有 agent_message_chunk 通知在 session/prompt RPC 响应之前到达
      unsubscribe = client.subscribe((message) => {
        if (extractSessionId(message) !== sessionId) return;
        if (message.kind === 'request') {
          rtLog(`[hermes-provider] REQUEST id=${message.id} method=${message.method}`);
          if (message.method && message.id !== undefined) {
            client.respond(message.id, { approved: true }).catch(() => {});
            rtLog(`[hermes-provider] Auto-approved request: ${message.method} id=${message.id}`);
          }
          return;
        }

        const paramsRecord = (typeof message.params === 'object' && message.params ? message.params as JsonRecord : {});
        const updateType = sessionUpdateType(paramsRecord);
        const update = paramsRecord.update as JsonRecord | undefined;
        const content = update?.content as JsonRecord | undefined;

        switch (updateType) {
          case 'agent_message_chunk':
            if (content && typeof content.text === 'string') {
              emitCanonicalTurnEvent(controller, { type: 'text', data: content.text });
            }
            break;
          case 'agent_thought_chunk':
            if (content && typeof content.text === 'string') {
              emitCanonicalTurnEvent(controller, { type: 'status', data: { reasoning: content.text } });
            }
            break;
          case 'usage_update':
            if (typeof (update as JsonRecord)?.size === 'number') {
              const used = typeof (update as JsonRecord)?.used === 'number' ? (update as JsonRecord).used as number : 0;
              emitCanonicalTurnEvent(controller, {
                type: 'activity_event',
                data: {
                  kind: 'context_usage',
                  id: `context:${sessionId}`,
                  inputTokens: used,
                  outputTokens: 0,
                  cacheReadInputTokens: 0,
                },
              });
            }
            break;
          case 'available_commands':
            break;
          default:
            break;
        }
      });

      emitCanonicalTurnEvent(controller, {
        type: 'status',
        data: { session_id: sessionId },
      });

      // 发送 prompt（RPC 响应到达时，所有流式通知已通过订阅回调 emit）
      const promptInput = this.buildPrompt(params);
      const result = await client.call<HermesPromptResult>('session/prompt', {
        sessionId,
        prompt: promptInput,
      });

      // RPC 已返回，所有文本已 emit → 发送 result 事件并关闭流
      const isError = result.stopReason !== 'end_turn';
      emitCanonicalTurnEvent(controller, {
        type: 'result',
        data: {
          session_id: sessionId,
          is_error: isError,
          ...(result.usage ? {
            usage: {
              input_tokens: result.usage.inputTokens,
              output_tokens: result.usage.outputTokens,
              cache_read_input_tokens: result.usage.cachedReadTokens,
            },
          } : {}),
        },
      });

      // 压缩上下文（异步，不阻塞流关闭）
      client.notify('session/compact', { sessionId }).catch(() => {});

      controller.close();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[hermes-provider] Error:', msg);
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
  ): Array<{ type: string; text?: string; image?: string; alt?: string }> {
    const parts: Array<{ type: string; text?: string; image?: string; alt?: string }> = [];

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

}

export function createHermesProvider(config?: HermesConfig): HermesProvider {
  return new HermesProvider(config);
}