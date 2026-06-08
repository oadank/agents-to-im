/**
 * ZCode Provider — 多 agent 路由
 *
 * 所有 agent 均通过 MiMo 网关运行：
 *   - glm (默认):     zcode-acp → MiMo (OpenAI 格式)
 *   - gemini:         gemini.js → mimo-gemini-proxy → MiMo (Google API ↔ OpenAI 格式转换)
 *   - opencode:       opencode → MiMo (原生 OpenAI 格式)
 *
 * 架构：
 *   gemini.js 发 Google API 格式 → mimo-gemini-proxy:8901 做格式转换 → MiMo
 *   opencode 直连 MiMo (OpenAI 兼容)
 *   zcode-acp (GLM) 直连 MiMo (OpenAI 兼容)
 *
 * params.model 编码规则：
 *   - "agent:gemini"  → gemini.js + MiMo proxy
 *   - "agent:opencode" → opencode + MiMo
 *   - "agent:glm"     → zcode-acp + MiMo
 *   - 其他/空         → 默认 glm
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { LLMProvider, StreamChatParams } from '../../bridge/host.js';
import { emitCanonicalTurnEvent } from '../../infra/sse-utils.js';

/**
 * 查找 ZCode agent 沙箱目录
 * 只选包含有效配置文件的目录，避免选到空目录
 */
function findSandboxDir(agent: string): string | null {
  const base = '/opt/.zcode/v2/acp-config';
  const agentDir = path.join(base, agent);
  try {
    const entries = fs.readdirSync(agentDir)
      .filter(e => {
        const dir = path.join(agentDir, e);
        if (!fs.statSync(dir).isDirectory()) return false;
        // gemini 需要 .gemini/settings.json
        if (agent === 'gemini') return fs.existsSync(path.join(dir, '.gemini', 'settings.json'));
        // opencode 需要 opencode.json
        if (agent === 'opencode') return fs.existsSync(path.join(dir, 'opencode.json'));
        return true;
      })
      .sort()
      .reverse();
    return entries.length > 0 ? path.join(agentDir, entries[0]) : null;
  } catch {
    return null;
  }
}

export interface ZCodeConfig {
  executable?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  defaultModel?: string;
}

interface ZCodeResponse {
  sessionId?: string;
  response?: string;
  usage?: {
    source?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
  error?: string;
}

type AgentName = 'glm' | 'gemini' | 'opencode';

interface AgentCliConfig {
  bin: string | ((agent: AgentName) => string);
  args: (msg: string) => string[];
  json: boolean;
  useSandboxCwd: boolean;
}

/** 缓存的 ACP 会话 — 保持进程存活以保留上下文 */
interface CachedAcpSession {
  child: import('node:child_process').ChildProcess;
  sessionId: string;
  agent: AgentName;
  cwd: string;
  env: NodeJS.ProcessEnv;
  lineBuf: string;
  lastUsed: number;
  /** 当前 prompt 的 settle 回调 */
  currentSettle: ((err?: string) => void) | null;
  /** 当前 prompt 的 responseText */
  currentText: string;
  /** 请求 ID 递增器 */
  nextId: number;
  /** 当前 prompt 的请求 ID（用于路由响应） */
  currentPromptId: number;
  /** 进程是否还活着 */
  alive: boolean;
  /** Session 重建重试计数（防止无限循环） */
  sessionRecoveryAttempts: number;
  /** 待重试的 prompt 文本（Session not found 恢复用） */
  pendingRetryPrompt: string | null;
  /** 待重试的 settle 回调 */
  pendingRetrySettle: ((err?: string) => void) | null;
  /** 待重试的 controller */
  pendingRetryController: ReadableStreamDefaultController<string> | null;
  /** 待重试的 sdkSessionId */
  pendingRetrySdkSessionId: string | undefined;
  /** 待重试的 abortController */
  pendingRetryAbortController: AbortController | undefined;
}

const AGENT_CLI: Record<AgentName, AgentCliConfig> = {
  glm: {
    // GLM 使用 ACP 协议（zcode-acp 自带 ACP 模式）
    bin: 'zcode-acp',
    args: () => ['acp'],
    json: false,
    useSandboxCwd: false,
  },
  gemini: {
    // Gemini CLI ACP 模式（和 GLM 同协议）
    bin: 'node',
    args: () => ['/opt/zcode/resources/gemini/gemini.js', '--acp'],
    json: false,
    useSandboxCwd: true,
  },
  opencode: {
    // OpenCode ACP 模式（和 GLM 同协议）
    bin: '/opt/zcode/resources/opencode/opencode',
    args: () => ['acp'],
    json: false,
    useSandboxCwd: true,
  },
};

function parseAgent(model?: string): AgentName {
  if (model?.startsWith('agent:')) {
    const name = model.slice(6) as AgentName;
    if (name in AGENT_CLI) return name;
  }
  return 'glm';
}

export class ZCodeProvider implements LLMProvider {
  private readonly openaiApiKey: string;
  private readonly openaiBaseUrl: string;
  /** ACP 进程缓存: key = `${sdkSessionId}:${agent}` */
  private acpCache = new Map<string, CachedAcpSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private static IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟
  /** session 持久化目录 — 存 sessionId 以支持跨进程恢复 */
  private static SESSION_DIR = '/opt/.zcode/sessions';

  constructor(config?: ZCodeConfig) {
    this.openaiApiKey = config?.openaiApiKey
      || process.env.CTI_ZCODE_OPENAI_API_KEY
      || process.env.OPENAI_API_KEY
      || '';
    this.openaiBaseUrl = config?.openaiBaseUrl
      || process.env.CTI_ZCODE_OPENAI_BASE_URL
      || process.env.OPENAI_BASE_URL
      || '';
  }

  async prepare(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn('zcode-acp', ['--version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.on('close', (code) => {
        code === 0 ? resolve() : reject(new Error('zcode-acp not available'));
      });
      child.on('error', (error) => {
        reject(new Error(`Failed to spawn zcode-acp: ${error.message}`));
      });
    });
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
    const { prompt, sdkSessionId, abortController, workingDirectory } = params;
    const agent = parseAgent(params.model);

    // 所有 agent 都走 ACP 协议（统一处理）
    return this.runAcp(controller, params, agent);
  }

  /**
   * 所有 agent: 通过 ACP 协议交互
   * 支持进程缓存：首次 spawn 并缓存，后续消息复用同一 session（保留上下文）
   */
  private async runAcp(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
    agent: AgentName,
  ): Promise<void> {
    const { prompt, sdkSessionId, abortController } = params;
    const cacheKey = `${sdkSessionId || 'default'}:${agent}`;
    const existing = this.acpCache.get(cacheKey);

    if (existing && existing.alive) {
      // 复用已有 session
      existing.lastUsed = Date.now();
      console.log(`[zcode-provider] ACP reuse session: ${existing.sessionId} agent=${agent}`);
      emitCanonicalTurnEvent(controller, {
        type: 'status', data: { session_id: sdkSessionId || '', agent },
      });
      return this.sendAcpPrompt(existing, prompt, controller, sdkSessionId, abortController);
    }

    // 新建 session
    const agentCli = AGENT_CLI[agent];
    let cwd = process.cwd();
    if (agentCli.useSandboxCwd) {
      const sandbox = findSandboxDir(agent);
      if (sandbox) cwd = sandbox;
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (agent === 'gemini') {
      env.GOOGLE_GEMINI_BASE_URL = 'http://127.0.0.1:8901';
      env.GEMINI_API_KEY = 'proxy-passthrough';
    }

    const args = agentCli.args(prompt);
    console.log(`[zcode-provider] ACP spawn: agent=${agent} bin=${agentCli.bin} cwd=${cwd}`);

    // 检查磁盘是否有可恢复的 session
    const saved = this.loadSavedSession(cacheKey);

    const child = spawn(agentCli.bin, args, {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
    });

    emitCanonicalTurnEvent(controller, {
      type: 'status', data: { session_id: sdkSessionId || '', agent },
    });

    // 等待 initialize 完成，然后尝试 session/resume 或 session/new
    const cached = await new Promise<CachedAcpSession | null>((resolve) => {
      let lineBuf = '';
      let initDone = false;
      let sessionDone = false;
      let sessionId = '';
      let initId = 1;
      let sessionId2 = 2; // session/new 或 session/resume 的请求 ID
      let spawnError = '';
      let resolved = false;
      let resumeAttempted = false;

      const done = (c: CachedAcpSession | null) => {
        if (resolved) return;
        resolved = true;
        resolve(c);
      };

      /** 创建缓存条目并绑定后续 handler */
      const createCacheEntry = (sid: string) => {
        const cached: CachedAcpSession = {
          child, sessionId: sid, agent, cwd, env,
          lineBuf: '', lastUsed: Date.now(),
          currentSettle: null, currentText: '',
          nextId: 100, currentPromptId: 0, alive: true,
          sessionRecoveryAttempts: 0, pendingRetryPrompt: null,
          pendingRetrySettle: null, pendingRetryController: null,
          pendingRetrySdkSessionId: undefined, pendingRetryAbortController: undefined,
        };

        // 设置持久 stdout handler
        child.stdout!.removeAllListeners('data');
        child.stdout!.on('data', (c: Buffer) => this.onAcpData(cached, c));

        // 进程退出 → 清理缓存
        child.on('close', (code) => {
          cached.alive = false;
          console.log(`[zcode-provider] ACP process exited code=${code}`);
          this.acpCache.delete(cacheKey);
        });

        // 缓存
        this.acpCache.set(cacheKey, cached);
        this.startCleanupTimer();

        // 保存 sessionId 映射到磁盘（Gemini 自己也存了聊天记录到 ~/.gemini/tmp/）
        this.saveSession(cacheKey, sid, cwd);

        return cached;
      };

      /** 回退到 session/new（resume 失败时） */
      const fallbackToNew = () => {
        console.log(`[zcode-provider] Resume failed, falling back to session/new`);
        this.removeSavedSession(cacheKey);
        resumeAttempted = true;
        sessionId2 = 99; // 用新 ID 避免冲突
        child.stdin!.write(JSON.stringify({
          jsonrpc: '2.0', id: sessionId2, method: 'session/new',
          params: { cwd, mcpServers: [] },
        }) + '\n');
      };

      child.on('error', (err) => {
        spawnError = err.message;
        console.error(`[zcode-provider] ACP spawn error: ${err.message}`);
        done(null);
      });

      child.on('close', (code) => {
        if (!sessionDone) {
          console.error(`[zcode-provider] ACP exited during init code=${code}`);
          done(null);
        }
      });

      child.stdout!.on('data', (chunk: Buffer) => {
        lineBuf += chunk.toString();
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || '';
        for (const raw of lines) {
          const trimmed = raw.trim();
          if (!trimmed.startsWith('{')) continue;
          try {
            const msg = JSON.parse(trimmed);
            const id = msg.id as number | undefined;

            // initialize 响应 → 根据是否有 saved session 决定 resume 或 new
            if (id === initId && msg.result) {
              console.log(`[zcode-provider] ACP initialized:`, JSON.stringify((msg.result as Record<string, unknown>).agentInfo));
              initDone = true;

              if (saved) {
                // 尝试恢复旧 session
                console.log(`[zcode-provider] Attempting session/load: ${saved.sessionId}`);
                child.stdin!.write(JSON.stringify({
                  jsonrpc: '2.0', id: sessionId2, method: 'session/load',
                  params: { sessionId: saved.sessionId, cwd: saved.cwd, mcpServers: [] },
                }) + '\n');
              } else {
                // 无旧 session，直接新建
                child.stdin!.write(JSON.stringify({
                  jsonrpc: '2.0', id: sessionId2, method: 'session/new',
                  params: { cwd, mcpServers: [] },
                }) + '\n');
              }
              continue;
            }

            // session/resume 或 session/new 的响应
            if (id === sessionId2 && msg.result) {
              const r = msg.result as Record<string, unknown>;
              sessionId = r.sessionId as string;
              sessionDone = true;
              const action = resumeAttempted || saved ? 'loaded' : 'new';
              console.log(`[zcode-provider] ACP session (${action}): ${sessionId}`);

              const cached = createCacheEntry(sessionId);
              done(cached);
              continue;
            }

            // session/load 失败 → 回退到 session/new（只在首次尝试时）
            if (id === sessionId2 && msg.error && !resumeAttempted && saved) {
              console.log(`[zcode-provider] session/load failed: ${JSON.stringify(msg.error)}`);
              fallbackToNew();
              continue;
            }

            // init 或 session/new 失败
            if (id != null && (id === initId || id === sessionId2) && msg.error) {
              console.error(`[zcode-provider] ACP init error:`, JSON.stringify(msg.error));
              done(null);
              continue;
            }
          } catch {}
        }
      });

      // 发送 initialize
      child.stdin!.write(JSON.stringify({
        jsonrpc: '2.0', id: initId, method: 'initialize',
        params: {
          protocolVersion: 1, capabilities: {},
          clientInfo: { name: 'feishu-zcode', version: '1.0' },
        },
      }) + '\n');

      // 超时保护
      setTimeout(() => { if (!sessionDone) { child.kill('SIGTERM'); done(null); } }, 15_000);
    });

    if (!cached) {
      const err = spawnError || 'Failed to initialize ACP session';
      console.error(`[zcode-provider] ACP init failed:`, err);
      emitCanonicalTurnEvent(controller, { type: 'error', data: err });
      emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: true } });
      emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
      controller.close();
      return;
    }

    // 发送 prompt
    return this.sendAcpPrompt(cached, prompt, controller, sdkSessionId, abortController);
  }

  /** 处理缓存进程的 stdout 数据 */
  private onAcpData(cached: CachedAcpSession, chunk: Buffer): void {
    cached.lineBuf += chunk.toString();
    const lines = cached.lineBuf.split('\n');
    cached.lineBuf = lines.pop() || '';
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const msg = JSON.parse(trimmed);
        const id = msg.id as number | undefined;
        const isResponse = !msg.method && (msg.result || msg.error);

        // 路由响应到当前 prompt 的 settle
        if (isResponse && cached.currentSettle && id != null && id === cached.currentPromptId) {
          if (msg.error) {
            const errMsg = msg.error.message || JSON.stringify(msg.error);
            const errDetails = msg.error.data?.details || '';
            // Session not found → 自动重建 session 并重试（最多 1 次）
            // gemini.js 返回格式: message="Internal error", data.details="Session not found: xxx"
            const isSessionNotFound = errMsg.includes('Session not found') || errDetails.includes('Session not found');
            if (isSessionNotFound && cached.sessionRecoveryAttempts < 1) {
              cached.sessionRecoveryAttempts++;
              console.log(`[zcode-provider] ACP Session not found, recreating session (attempt ${cached.sessionRecoveryAttempts})`);
              // 保存 prompt 和 settle 用于重试（prompt 从 sendAcpPrompt 传入，这里通过 pendingRetry 传递）
              cached.pendingRetryPrompt = cached.pendingRetryPrompt; // 由 sendAcpPrompt 设置
              cached.pendingRetrySettle = cached.currentSettle;
              cached.pendingRetryController = null; // controller 在 sendAcpPrompt 的闭包里
              cached.currentSettle = null; // 阻止 settle 清理进程
              // 发送 session/new
              const newSessionId = cached.nextId++;
              cached.currentPromptId = newSessionId; // 临时占用，等 session/new 回来
              cached.child.stdin!.write(JSON.stringify({
                jsonrpc: '2.0', id: newSessionId, method: 'session/new',
                params: { cwd: cached.cwd, mcpServers: [] },
              }) + '\n');
              // 等 session/new 回来后自动重试 prompt（在下面的 session/new 响应处理中）
              continue;
            }
            cached.currentSettle(`ACP error: ${errMsg}`);
          } else {
            console.log(`[zcode-provider] ACP prompt done`);
            cached.currentSettle();
          }
          continue;
        }

        // session/update 通知
        if (msg.method === 'session/update') {
          const update = msg.params?.update;
          const updateType = (update?.sessionUpdate as string) || 'unknown';

          if (update?.sessionUpdate === 'agent_message_chunk' && update?.content?.type === 'text') {
            cached.currentText += update.content.text;
          }
          if (update?.sessionUpdate === 'tool_call') {
            console.log(`[zcode-provider] ACP tool_call: ${update.title} status=${update.status}`);
          }
          if (!['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_result', 'available_commands_update'].includes(updateType)) {
            console.log(`[zcode-provider] ACP update type=${updateType}: ${JSON.stringify(update).slice(0, 200)}`);
          }
          continue;
        }

        // 权限请求 → 自动批准
        if (msg.method === 'session/request_permission') {
          const options = msg.params?.options as Array<{ optionId: string }> | undefined;
          const allowOption = options?.find(o => o.optionId === 'proceed_always')
            || options?.find(o => o.optionId === 'allow')
            || options?.find(o => o.optionId === 'allow_project')
            || options?.find(o => o.optionId === 'proceed_once')
            || options?.[0];
          const optionId = allowOption?.optionId || 'proceed_always';
          console.log(`[zcode-provider] ACP auto-approve perm reqId=${msg.id} optionId=${optionId}`);
          cached.child.stdin!.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { outcome: { outcome: 'selected', optionId } },
          }) + '\n');
          continue;
        }

        // init 阶段的 id=1,2 响应（不应该到这里，但防御性处理）
        if (id != null && id <= 2 && isResponse) continue;

        // Session not found 恢复：session/new 响应回来后重试 prompt
        if (isResponse && cached.pendingRetryPrompt && cached.pendingRetrySettle && id != null && id === cached.currentPromptId) {
          if (msg.error) {
            console.error(`[zcode-provider] ACP session recovery failed:`, JSON.stringify(msg.error));
            // 恢复失败，走正常错误流程
            cached.pendingRetrySettle(`ACP error: Session recovery failed: ${msg.error.message || JSON.stringify(msg.error)}`);
            cached.pendingRetryPrompt = null;
            cached.pendingRetrySettle = null;
            cached.pendingRetryController = null;
            continue;
          }
          // session/new 成功，更新 sessionId
          const r = msg.result as Record<string, unknown>;
          const newSessionId = r.sessionId as string;
          console.log(`[zcode-provider] ACP session recovered: ${newSessionId} (was ${cached.sessionId})`);
          cached.sessionId = newSessionId;
          const retryPrompt = cached.pendingRetryPrompt;
          const retrySettle = cached.pendingRetrySettle;
          const retryController = cached.pendingRetryController;
          const retrySdkSessionId = cached.pendingRetrySdkSessionId;
          const retryAbortController = cached.pendingRetryAbortController;
          cached.pendingRetryPrompt = null;
          cached.pendingRetrySettle = null;
          cached.pendingRetryController = null;
          cached.pendingRetrySdkSessionId = undefined;
          cached.pendingRetryAbortController = undefined;
          // 清空 pendingRetry 后重试 prompt
          const retryId = cached.nextId++;
          cached.currentPromptId = retryId;
          cached.currentText = '';
          cached.currentSettle = retrySettle;
          cached.child.stdin!.write(JSON.stringify({
            jsonrpc: '2.0', id: retryId, method: 'session/prompt',
            params: {
              sessionId: newSessionId,
              prompt: [{ type: 'text', text: retryPrompt }],
            },
          }) + '\n');
          console.log(`[zcode-provider] ACP retry prompt id=${retryId} after session recovery`);
          continue;
        }

      } catch {}
    }
  }

  /** 发送 prompt 并等待响应 */
  private sendAcpPrompt(
    cached: CachedAcpSession,
    prompt: string,
    controller: ReadableStreamDefaultController<string>,
    sdkSessionId: string | undefined,
    abortController: AbortController | undefined,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const promptId = cached.nextId++;
      cached.currentPromptId = promptId;
      cached.currentText = '';
      cached.lastUsed = Date.now();
      // 保存 prompt/controller/sdkSessionId/abortController 用于 Session not found 恢复重试
      cached.pendingRetryPrompt = prompt;
      cached.pendingRetryController = controller;
      cached.pendingRetrySdkSessionId = sdkSessionId;
      cached.pendingRetryAbortController = abortController;

      const abortHandler = () => { cached.child.kill('SIGTERM'); };
      abortController?.signal.addEventListener('abort', abortHandler, { once: true });

      cached.currentSettle = (err?: string) => {
        cached.currentSettle = null;
        cached.pendingRetryPrompt = null;
        cached.pendingRetrySettle = null;
        cached.pendingRetryController = null;
        cached.pendingRetrySdkSessionId = undefined;
        cached.pendingRetryAbortController = undefined;
        abortController?.signal.removeEventListener('abort', abortHandler);

        if (err) {
          console.error(`[zcode-provider] ACP error:`, err);
          emitCanonicalTurnEvent(controller, { type: 'error', data: err });
          // 出错时销毁此 session
          cached.alive = false;
          try { cached.child.kill('SIGTERM'); } catch {}
          const key = `${sdkSessionId || 'default'}:${cached.agent}`;
          this.acpCache.delete(key);
          this.removeSavedSession(key);
        } else if (cached.currentText.trim()) {
          emitCanonicalTurnEvent(controller, { type: 'text', data: cached.currentText.trim() });
        } else {
          emitCanonicalTurnEvent(controller, { type: 'error', data: 'Empty response from zcode agent' });
        }
        emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: !!err } });
        emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
        controller.close();
        resolve();
      };

      // 对话传承：把 conversationHistory 注入 prompt 前面
      let fullPrompt = prompt;
      const history = params.conversationHistory;
      if (history && history.length > 0) {
        // 只取最近 20 条，避免 prompt 过长
        const recentHistory = history.slice(-20);
        const historyBlock = recentHistory
          .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
          .join('\n\n');
        fullPrompt = `[Previous conversation context]\n${historyBlock}\n\n[End of previous context]\n\n[Current message]\n${prompt}`;
        console.log(`[zcode-provider] ACP injecting ${recentHistory.length} history messages into prompt`);
      }

      console.log(`[zcode-provider] ACP prompt id=${promptId} session=${cached.sessionId}`);
      cached.child.stdin!.write(JSON.stringify({
        jsonrpc: '2.0', id: promptId, method: 'session/prompt',
        params: {
          sessionId: cached.sessionId,
          prompt: [{ type: 'text', text: fullPrompt }],
        },
      }) + '\n');

      // 单条 prompt 超时 300s（长对话需要更多时间）
      setTimeout(() => {
        if (cached.currentSettle) {
          cached.currentSettle('ACP prompt timeout after 300s');
        }
      }, 300_000);
    });
  }

  // ─── Session 持久化：支持跨进程恢复上下文 ───

  private sessionFilePath(cacheKey: string): string {
    // cacheKey 格式: "{sdkSessionId}:{agent}" — 做文件名安全化
    const safe = cacheKey.replace(/[^a-zA-Z0-9_:-]/g, '_');
    return path.join(ZCodeProvider.SESSION_DIR, `${safe}.json`);
  }

  /** 从磁盘加载已保存的 sessionId */
  private loadSavedSession(cacheKey: string): { sessionId: string; cwd: string } | null {
    try {
      const filePath = this.sessionFilePath(cacheKey);
      if (!fs.existsSync(filePath)) return null;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data?.sessionId && data?.cwd) {
        console.log(`[zcode-provider] Session loaded from disk: ${data.sessionId} (was saved ${data.savedAt || '?'})`);
        return { sessionId: data.sessionId, cwd: data.cwd };
      }
    } catch (e) {
      console.log(`[zcode-provider] Session load failed: ${e}`);
    }
    return null;
  }

  /** 保存 sessionId 到磁盘 */
  private saveSession(cacheKey: string, sessionId: string, cwd: string): void {
    try {
      fs.mkdirSync(ZCodeProvider.SESSION_DIR, { recursive: true });
      const filePath = this.sessionFilePath(cacheKey);
      const data = { sessionId, cwd, savedAt: new Date().toISOString(), agent: cacheKey.split(':').pop() };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      console.log(`[zcode-provider] Session saved to disk: ${sessionId} → ${filePath}`);
    } catch (e) {
      console.log(`[zcode-provider] Session save failed: ${e}`);
    }
  }

  /** 删除已保存的 sessionId（session 出错或过期时调用） */
  private removeSavedSession(cacheKey: string): void {
    try {
      const filePath = this.sessionFilePath(cacheKey);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
  }

  /** 启动空闲清理定时器 */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, cached] of this.acpCache) {
        if (now - cached.lastUsed > ZCodeProvider.IDLE_TIMEOUT_MS) {
          console.log(`[zcode-provider] ACP idle cleanup: ${cached.sessionId} agent=${cached.agent}`);
          // 先保存 sessionId 到磁盘，下次消息来时可通过 session/resume 恢复上下文
          this.saveSession(key, cached.sessionId, cached.cwd);
          cached.alive = false;
          try { cached.child.kill('SIGTERM'); } catch {}
          this.acpCache.delete(key);
        }
      }
      if (this.acpCache.size === 0 && this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }
    }, 60_000);
  }

  private handleJsonOutput(
    controller: ReadableStreamDefaultController<string>,
    stdout: string,
    sdkSessionId?: string,
  ): void {
    let result: ZCodeResponse;
    try {
      result = JSON.parse(stdout.trim()) as ZCodeResponse;
    } catch {
      emitCanonicalTurnEvent(controller, {
        type: 'error',
        data: `Failed to parse JSON: ${stdout.slice(0, 200)}`,
      });
      return;
    }

    if (result.error) {
      console.error(`[zcode-provider] ZCode error:`, result.error);
      emitCanonicalTurnEvent(controller, { type: 'error', data: result.error });
      return;
    }

    if (result.response) {
      emitCanonicalTurnEvent(controller, { type: 'text', data: result.response });
    }
    if (result.sessionId) {
      emitCanonicalTurnEvent(controller, {
        type: 'status',
        data: { session_id: result.sessionId },
      });
    }
    emitCanonicalTurnEvent(controller, {
      type: 'result',
      data: {
        session_id: result.sessionId || sdkSessionId || '',
        is_error: false,
        usage: result.usage
          ? { input_tokens: result.usage.inputTokens || 0, output_tokens: result.usage.outputTokens || 0 }
          : undefined,
      },
    });
  }

  private handleTextOutput(
    controller: ReadableStreamDefaultController<string>,
    stdout: string,
    sdkSessionId?: string,
  ): void {
    const text = stdout.trim();
    if (!text) {
      emitCanonicalTurnEvent(controller, { type: 'error', data: 'Empty response from agent' });
      return;
    }
    emitCanonicalTurnEvent(controller, { type: 'text', data: text });
    emitCanonicalTurnEvent(controller, {
      type: 'result',
      data: { session_id: sdkSessionId || '', is_error: false },
    });
  }
}

export function createZCodeProvider(config?: ZCodeConfig): ZCodeProvider {
  return new ZCodeProvider(config);
}
