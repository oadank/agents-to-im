/**
 * OpenAkita Provider — ACP 协议接入 OpenAkita
 *
 * 通过 ACP (Agent Client Protocol) 与 openakita-acp-server.py 进程通信，
 * 获得流式思考/工具层事件（替代旧的 CLI run 单任务模式，解决"卡在 ⏳ 处理中"）。
 *
 * ACP 协议：JSON-RPC 2.0 over stdin/stdout（换行分隔）
 */

import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LARK_CLI_INSTRUCTIONS, buildAgentPersona } from '../../config/runtime-configs.js';
import type { LLMProvider, StreamChatParams } from '../../bridge/host.js';
import { emitCanonicalTurnEvent } from '../../infra/sse-utils.js';

// 实时日志：绕过 NSSM stdout 缓冲
function rtLog(msg: string): void {
  const DEBUG_LOG = `C:\\D\\opt\\agents-to-im\\debug_realtime_${process.env.CTI_BOT || 'unknown'}.log`;
  try {
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8');
  } catch {}
}

/**
 * 在 Windows 上，NSSM 服务环境的 PATH/ComSpec/SystemRoot 可能不完整，
 * 导致 CreateProcess 找不到 node.exe 或 cmd.exe。
 * 此函数确保 spawn 的 env 包含最少必需的系统变量。
 */
function buildSpawnEnv(): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return { ...process.env };
  // 继承父进程 PATH（含用户配置）并补充关键系统目录
  const parentPath = process.env.PATH ? process.env.PATH.split(';').filter(Boolean) : [];
  const workspace =
    process.env.CTI_OPENAKITA_WORKSPACE ||
    path.join(os.homedir(), '.openakita', 'workspaces', 'default');
  return {
    ...process.env,
    ComSpec: process.env.ComSpec || 'C:\\WINDOWS\\system32\\cmd.exe',
    SystemRoot: process.env.SystemRoot || 'C:\\WINDOWS',
    PATH: [
      ...parentPath,
      'C:\\WINDOWS\\system32',
      'C:\\WINDOWS',
      'C:\\WINDOWS\\System32\\Wbem',
      'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0',
      'C:\\Program Files\\nodejs',
      'C:\\Users\\oadan\\AppData\\Roaming\\npm',
    ].join(';'),
    // openakita ACP server 环境
    OPENAKITA_ACP_WORKSPACE: workspace,
    LLM_ENDPOINTS_CONFIG: path.join(workspace, 'data', 'llm_endpoints.json'),
    OPENAKITA_AUTO_CONFIRM: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };
}

function resolveOpenAkitaExecutable(): { command: string; args: string[] } {
  const server = 'C:\\D\\opt\\agents-to-im\\scripts\\openakita-acp-server.py';
  if (!fs.existsSync(server)) {
    console.warn(`[openakita-provider] acp server not found at ${server}, spawn may fail`);
  }
  return { command: 'C:\\D\\opt\\openakita\\venv\\Scripts\\python.exe', args: [server] };
}

// ── 记忆注入 ──

function loadMemoryContent(agentName?: string): string {
  const parts: string[] = [];
  const memBase = process.env.CTI_AGENTS_MEMORY || path.join(os.homedir(), 'agents-memory');
  const agent = agentName || 'openakita';

  try {
    const agentMemDir = `${memBase}/${agent}`;
    if (fs.existsSync(agentMemDir)) {
      const memFile = agentMemDir + '/MEMORY.md';
      if (fs.existsSync(memFile)) {
        parts.push(fs.readFileSync(memFile, 'utf-8'));
      }
      const files = fs.readdirSync(agentMemDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
      for (const file of files) {
        const fp = agentMemDir + '/' + file;
        const content = fs.readFileSync(fp, 'utf-8').trim();
        if (content) parts.push(`\n=== ${file} ===\n${content}`);
      }
    }
  } catch { /* ignore */ }

  try {
    const sharedMemFile = `${memBase}/shared/MEMORY.md`;
    if (fs.existsSync(sharedMemFile)) {
      const content = fs.readFileSync(sharedMemFile, 'utf-8').trim();
      if (content) parts.push(`\n=== Shared Memory ===\n${content}`);
    }
  } catch { /* ignore */ }

  return parts.join('\n---\n');
}

function getMemoryContent(agentName?: string): string {
  const memory = loadMemoryContent(agentName);
  if (memory) console.log(`[openakita-provider] Memory loaded (${memory.length} chars, agent=${agentName || 'openakita'})`);
  else console.log('[openakita-provider] No memory loaded');
  return memory;
}

// ── ACP 会话缓存 ──

interface CachedAcpSession {
  child: ChildProcess;
  sessionId: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  lineBuf: string;
  lastUsed: number;
  currentSettle: ((err?: string) => void) | null;
  currentController: ReadableStreamDefaultController<string> | null;
  currentText: string;
  currentThinking: string;
  _inThinking: boolean;
  _textEmitted: boolean;
  _firstUpdateLogged: boolean;
  nextId: number;
  currentPromptId: number;
  alive: boolean;
  sessionRecoveryAttempts: number;
  pendingRetryPrompt: string | null;
  pendingRetrySettle: ((err?: string) => void) | null;
  pendingRetryController: ReadableStreamDefaultController<string> | null;
  pendingRetrySdkSessionId: string | undefined;
  pendingRetryAbortController: AbortController | undefined;
}

// ── OpenAkitaProvider ──

export class OpenAkitaProvider implements LLMProvider {
  private acpCache = new Map<string, CachedAcpSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private static IDLE_TIMEOUT_MS = parseInt(process.env.CTI_OPENAKITA_IDLE_TIMEOUT_MS || '900000', 10); // 默认 15 分钟
  private static SESSION_DIR = path.join(os.homedir(), '.openakita', 'sessions');
  private workspace: string;

  constructor(config?: { workspace?: string }) {
    this.workspace =
      config?.workspace ||
      process.env.CTI_OPENAKITA_WORKSPACE ||
      path.join(os.homedir(), '.openakita', 'workspaces', 'default');
    this.startCleanupTimer();
  }

  /** 清除 ACP 会话缓存，下次请求时会重启 openakita 进程（用于 /new 时重新读取配置） */
  clearCache(): void {
    for (const [key, cached] of this.acpCache) {
      console.log(`[openakita-provider] Clear cache: ${cached.sessionId}`);
      this.saveSession(key, cached.sessionId, cached.cwd);
      cached.alive = false;
      try { cached.child.kill('SIGTERM'); } catch {}
      this.acpCache.delete(key);
    }
  }

  async prepare(): Promise<void> {
    // Windows 下跳过版本检查（openakita 初始化慢）
    if (process.platform === 'win32') {
      rtLog(`[openakita-provider] prepare: Windows environment, skipping --version check`);
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const { command, args } = resolveOpenAkitaExecutable();
      const child = spawn(command, [...args, '--version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildSpawnEnv(),
        windowsHide: true,
      });
      let stdoutBuf = '';
      let stderrBuf = '';
      child.stdout?.on('data', (chunk) => { stdoutBuf += chunk.toString(); });
      child.stderr?.on('data', (chunk) => { stderrBuf += chunk.toString(); });
      child.on('close', (code) => {
        code === 0 ? resolve() : reject(new Error(`openakita acp server not available (code=${code})`));
      });
      child.on('error', (error) => {
        reject(new Error(`Failed to spawn openakita acp server: ${error.message}`));
      });
      setTimeout(() => { child.kill(); reject(new Error('openakita prepare timeout (10s)')); }, 10000);
    });
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;
    return new ReadableStream<string>({
      async start(controller) {
        try {
          await self.runAcp(controller, params);
        } catch (e) {
          console.error('[openakita-provider] streamChat error:', e);
          emitCanonicalTurnEvent(controller, { type: 'error', data: String(e) });
          emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
          controller.close();
        }
      },
    });
  }

  /**
   * 通过 ACP 协议与 openakita acp server 交互
   * 支持进程缓存：首次 spawn 并缓存，后续消息复用同一 session
   */
  private async runAcp(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
  ): Promise<void> {
    const { prompt, sdkSessionId, abortController } = params;
    const cacheKey = sdkSessionId || 'default';
    const existing = this.acpCache.get(cacheKey);

    if (existing && existing.alive) {
      existing.lastUsed = Date.now();
      console.log(`[openakita-provider] ACP reuse session: ${existing.sessionId}`);
      emitCanonicalTurnEvent(controller, {
        type: 'status', data: { session_id: sdkSessionId || '' },
      });
      return this.sendAcpPrompt(existing, prompt, controller, sdkSessionId, abortController, params.conversationHistory, params.fromAudio);
    }

    // 新建 session
    const rawCwd = params.workingDirectory || process.cwd();
    const cwd = process.platform === 'win32' && !fs.existsSync(rawCwd)
      ? (process.env.USERPROFILE || 'C:\\Users\\oadan')
      : rawCwd;
    const configCwd = process.env.CTI_OPENAKITA_ACP_CWD || this.workspace;
    const sessionNewCwd = process.platform === 'win32' ? cwd : configCwd;

    const saved = this.loadSavedSession(cacheKey);

    const { command, args } = resolveOpenAkitaExecutable();
    rtLog(`[openakita-provider] ACP resolved: command="${command}" args=${JSON.stringify(args)}`);
    const env = buildSpawnEnv();
    const child = spawn(command, args, {
      cwd: this.workspace, stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    });
    rtLog(`[openakita-provider] ACP spawned successfully: pid=${child.pid}`);

    // 必须读 stderr，否则管道满了进程卡死
    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) rtLog(`[openakita-provider] ACP stderr: ${text.slice(0, 500)}`);
    });

    emitCanonicalTurnEvent(controller, {
      type: 'status', data: { session_id: sdkSessionId || '' },
    });

    let spawnError = '';

    // 等待 initialize 完成，然后 session/new
    const cached = await new Promise<CachedAcpSession | null>((resolve) => {
      let lineBuf = '';
      let sessionDone = false;
      let sessionId = '';
      const initId = 1;
      let sessionId2 = 2;
      let resolved = false;
      let resumeAttempted = false;
      // 内部可变引用：监听器在 init 阶段读取时为 null，session 就绪后为真实条目
      let entry: CachedAcpSession | null = null;

      const done = (c: CachedAcpSession | null) => {
        if (resolved) return;
        resolved = true;
        resolve(c);
      };

      const createCacheEntry = (sid: string) => {
        const cachedEntry: CachedAcpSession = {
          child, sessionId: sid, cwd, env,
          lineBuf: '', lastUsed: Date.now(),
          currentSettle: null, currentController: null, currentText: '', currentThinking: '', _inThinking: false, _textEmitted: false, _firstUpdateLogged: false,
          nextId: 100, currentPromptId: 0, alive: true,
          sessionRecoveryAttempts: 0, pendingRetryPrompt: null,
          pendingRetrySettle: null, pendingRetryController: null,
          pendingRetrySdkSessionId: undefined, pendingRetryAbortController: undefined,
        };
        entry = cachedEntry;
        return cachedEntry;
      };

      child.stdout!.removeAllListeners('data');
      child.stdout!.on('data', (c: Buffer) => this.onAcpData(entry, c));

      child.on('close', (code) => {
        const cur = this.acpCache.get(cacheKey);
        if (cur && cur.sessionId) {
          cur.alive = false;
          console.log(`[openakita-provider] ACP process exited code=${code}`);
          this.acpCache.delete(cacheKey);
        }
      });

      const fallbackToNew = () => {
        console.log(`[openakita-provider] Resume failed, falling back to session/new`);
        this.removeSavedSession(cacheKey);
        resumeAttempted = true;
        sessionId2 = 99;
        child.stdin!.write(JSON.stringify({
          jsonrpc: '2.0', id: sessionId2, method: 'session/new',
          params: { cwd: sessionNewCwd, mcpServers: [] },
        }) + '\n');
      };

      child.on('error', (err) => {
        spawnError = err.message;
        console.error(`[openakita-provider] ACP spawn error: ${err.message}`);
        done(null);
      });

      child.on('close', (code) => {
        if (!sessionDone) {
          console.error(`[openakita-provider] ACP exited during init code=${code}`);
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

            if (id === initId && msg.result) {
              console.log(`[openakita-provider] ACP initialized`);
              if (saved) {
                console.log(`[openakita-provider] Attempting session/load: ${saved.sessionId}`);
                child.stdin!.write(JSON.stringify({
                  jsonrpc: '2.0', id: sessionId2, method: 'session/load',
                  params: { sessionId: saved.sessionId, cwd: sessionNewCwd, mcpServers: [] },
                }) + '\n');
              } else {
                child.stdin!.write(JSON.stringify({
                  jsonrpc: '2.0', id: sessionId2, method: 'session/new',
                  params: { cwd: sessionNewCwd, mcpServers: [] },
                }) + '\n');
              }
              continue;
            }

            if (id === sessionId2 && msg.result) {
              const r = msg.result as Record<string, unknown>;
              sessionId = (r.sessionId as string) || (saved ? saved.sessionId : undefined) || '';
              sessionDone = true;
              const action = resumeAttempted || saved ? 'loaded' : 'new';
              console.log(`[openakita-provider] ACP session (${action}): ${sessionId}`);
              const cachedEntry = createCacheEntry(sessionId);
              this.acpCache.set(cacheKey, cachedEntry);
              done(cachedEntry);
              continue;
            }

            if (id === sessionId2 && msg.error && !resumeAttempted && saved) {
              console.log(`[openakita-provider] session/load failed: ${JSON.stringify(msg.error)}`);
              fallbackToNew();
              continue;
            }

            if (id != null && (id === initId || id === sessionId2) && msg.error) {
              console.error(`[openakita-provider] ACP init error:`, JSON.stringify(msg.error));
              done(null);
              continue;
            }
          } catch {}
        }
      });

      child.stdin!.write(JSON.stringify({
        jsonrpc: '2.0', id: initId, method: 'initialize',
        params: {
          protocolVersion: 1, capabilities: {},
          clientInfo: { name: 'feishu-openakita', version: '1.0' },
        },
      }) + '\n');

      setTimeout(() => { if (!sessionDone) { try { child.kill('SIGTERM'); } catch {} done(null); } }, 15_000);
    });

    if (!cached) {
      const err = spawnError || 'Failed to initialize ACP session';
      console.error(`[openakita-provider] ACP init failed:`, err);
      emitCanonicalTurnEvent(controller, { type: 'error', data: err });
      emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: true } });
      emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
      controller.close();
      return;
    }

    this.saveSession(cacheKey, cached.sessionId, cwd);
    return this.sendAcpPrompt(cached, prompt, controller, sdkSessionId, abortController, params.conversationHistory, params.fromAudio);
  }

  /** 处理 ACP 进程的 stdout 数据 */
  private onAcpData(cached: CachedAcpSession | null, chunk: Buffer): void {
    // init/session-new 阶段 cached 尚未就绪（由 init 监听器处理），直接忽略
    if (!cached) return;
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
            const isSessionNotFound = errMsg.includes('Session not found') || errDetails.includes('Session not found');
            if (isSessionNotFound && cached.sessionRecoveryAttempts < 1) {
              cached.sessionRecoveryAttempts++;
              console.log(`[openakita-provider] ACP Session not found, recreating (attempt ${cached.sessionRecoveryAttempts})`);
              cached.pendingRetrySettle = cached.currentSettle;
              cached.currentSettle = null;
              const newSessionId = cached.nextId++;
              cached.currentPromptId = newSessionId;
              cached.child.stdin!.write(JSON.stringify({
                jsonrpc: '2.0', id: newSessionId, method: 'session/new',
                params: { cwd: this.workspace, mcpServers: [] },
              }) + '\n');
              continue;
            }
            cached.currentSettle(`ACP error: ${errMsg}`);
          } else {
            console.log(`[openakita-provider] ACP prompt done`);
            cached.currentSettle();
          }
          continue;
        }

        // session/update 通知
        if (msg.method === 'session/update') {
          if (!cached._firstUpdateLogged) {
            cached._firstUpdateLogged = true;
            console.log(`[openakita-provider] ACP first update after ${Date.now() - cached.lastUsed}ms`);
          }
          const update = msg.params?.update;
          const updateType = (update?.sessionUpdate as string) || 'unknown';

          if (update?.sessionUpdate === 'agent_message_chunk' && update?.content?.type === 'text') {
            const chunkText = update.content.text;
            let remaining = chunkText;
            while (remaining.length > 0) {
              if (cached._inThinking) {
                const closeIdx = remaining.indexOf('</think>');
                if (closeIdx === -1) {
                  cached.currentThinking += remaining;
                  remaining = '';
                } else {
                  cached.currentThinking += remaining.slice(0, closeIdx);
                  remaining = remaining.slice(closeIdx + 8);
                  cached._inThinking = false;
                  if (cached.currentController && cached.currentThinking.trim()) {
                    emitCanonicalTurnEvent(cached.currentController, {
                      type: 'activity_event',
                      data: {
                        kind: 'reasoning_activity',
                        id: 'thinking:openakita',
                        status: 'running',
                        text: cached.currentThinking,
                      },
                    });
                  }
                }
              } else {
                const openIdx = remaining.indexOf('<think>');
                if (openIdx === -1) {
                  const delta = remaining;
                  cached.currentText += delta;
                  remaining = '';
                  if (cached.currentController && delta) {
                    cached._textEmitted = true;
                    emitCanonicalTurnEvent(cached.currentController, { type: 'text', data: delta });
                  }
                } else if (openIdx > 0) {
                  const delta = remaining.slice(0, openIdx);
                  cached.currentText += delta;
                  remaining = remaining.slice(openIdx);
                  if (cached.currentController && delta) {
                    cached._textEmitted = true;
                    emitCanonicalTurnEvent(cached.currentController, { type: 'text', data: delta });
                  }
                } else {
                  cached._inThinking = true;
                  remaining = remaining.slice(7);
                }
              }
            }
          }
          if (update?.sessionUpdate === 'agent_thought_chunk' && update?.content?.type === 'text') {
            cached.currentThinking += update.content.text;
            if (cached.currentController) {
              emitCanonicalTurnEvent(cached.currentController, {
                type: 'activity_event',
                data: {
                  kind: 'reasoning_activity',
                  id: 'thinking:openakita',
                  status: 'running',
                  text: cached.currentThinking,
                },
              });
            }
          }
          if (update?.sessionUpdate === 'tool_call') {
            const toolInfo = update.input ? `${update.title} ${JSON.stringify(update.input).slice(0, 100)}` : (update.title || '工具');
            const toolStatus = (update.status as string) || 'running';
            const toolCallId = String((update as any).toolCallId || (update as any).callId || `openakita-tool:${update.title || 'tool'}:${Date.now()}`);
            const toolName = String(update.title || 'tool');
            console.log(`[openakita-provider] ACP tool_call: ${toolInfo} status=${toolStatus} id=${toolCallId}`);
            if (cached.currentController) {
              emitCanonicalTurnEvent(cached.currentController, {
                type: 'activity_event',
                data: {
                  kind: 'tool_activity',
                  toolUseId: toolCallId,
                  toolName,
                  status: toolStatus === 'failed' ? 'failed' : (toolStatus === 'completed' ? 'completed' : 'running'),
                  inputPreview: update.input && typeof update.input === 'object' ? JSON.stringify(update.input).slice(0, 220) : '',
                  resultPreview: update.output && typeof update.output === 'string' ? update.output.slice(0, 220) : '',
                },
              });
            }
          }
          continue;
        }

        // init 阶段响应（已处理）
        if (id != null && id <= 2 && isResponse) continue;

        // Session recovery: new session + retry
        if (isResponse && cached.pendingRetryPrompt && cached.pendingRetrySettle && id != null && id === cached.currentPromptId) {
          if (msg.error) {
            console.error(`[openakita-provider] ACP session recovery failed:`, JSON.stringify(msg.error));
            cached.pendingRetrySettle(`ACP error: Session recovery failed: ${msg.error.message || JSON.stringify(msg.error)}`);
            cached.pendingRetryPrompt = null;
            cached.pendingRetrySettle = null;
            cached.pendingRetryController = null;
            continue;
          }
          const r = msg.result as Record<string, unknown>;
          const newSessionId = r.sessionId as string;
          console.log(`[openakita-provider] ACP session recovered: ${newSessionId}`);
          cached.sessionId = newSessionId;
          const retryPrompt = cached.pendingRetryPrompt!;
          const retrySettle = cached.pendingRetrySettle!;
          cached.pendingRetryPrompt = null;
          cached.pendingRetrySettle = null;
          cached.pendingRetryController = null;
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
    conversationHistory?: StreamChatParams['conversationHistory'],
    fromAudio?: boolean,
  ): Promise<void> {
    rtLog(`[openakita-provider] sendAcpPrompt ENTERED, cached.alive=${cached?.alive}`);
    return new Promise<void>((resolve) => {
      const promptId = cached.nextId++;
      cached.currentPromptId = promptId;
      cached.currentText = '';
      cached.currentThinking = '';
      cached._inThinking = false;
      cached._textEmitted = false;
      cached.lastUsed = Date.now();
      let enhancedPrompt = `${buildAgentPersona()}${LARK_CLI_INSTRUCTIONS}\n\n${prompt}`;
      if (!sdkSessionId) {
        const memory = getMemoryContent(process.env.CTI_AGENT_NAME);
        if (memory) {
          enhancedPrompt = '以下是你的记忆文件，请在回复时参考这些上下文信息。不要主动提及你读了记忆文件，除非用户问起。\n\n' + memory + '\n---\n\n' + `${buildAgentPersona()}${LARK_CLI_INSTRUCTIONS}\n\n用户消息：` + prompt;
        }
      }
      cached.pendingRetryPrompt = enhancedPrompt;
      cached.pendingRetryController = controller;
      cached.pendingRetrySdkSessionId = sdkSessionId;
      cached.pendingRetryAbortController = abortController;

      const abortHandler = () => {
        console.log(`[openakita-provider] ACP abort: sending session/interrupt first`);
        try {
          cached.child.stdin!.write(JSON.stringify({
            jsonrpc: '2.0', id: cached.nextId++, method: 'session/interrupt',
            params: { sessionId: cached.sessionId },
          }) + '\n');
        } catch {}
        setTimeout(() => {
          if (cached.alive) {
            console.log(`[openakita-provider] ACP interrupt timeout, force killing`);
            try { cached.child.kill('SIGTERM'); } catch {}
          }
        }, 3000);
      };
      abortController?.signal.addEventListener('abort', abortHandler, { once: true });

      cached.currentController = controller;
      cached.currentSettle = (err?: string) => {
        cached.currentSettle = null;
        cached.currentController = null;
        cached.pendingRetryPrompt = null;
        cached.pendingRetrySettle = null;
        cached.pendingRetryController = null;
        cached.pendingRetrySdkSessionId = undefined;
        cached.pendingRetryAbortController = undefined;
        abortController?.signal.removeEventListener('abort', abortHandler);

        if (err) {
          console.error(`[openakita-provider] ACP error:`, err);
          emitCanonicalTurnEvent(controller, { type: 'error', data: err });
          cached.alive = false;
          try { cached.child.kill('SIGTERM'); } catch {}
          this.acpCache.delete(sdkSessionId || 'default');
          this.removeSavedSession(sdkSessionId || 'default');
        } else if (cached._textEmitted) {
          // 文本已在流式阶段发出，不重复 emit
        } else if (cached.currentText.trim()) {
          emitCanonicalTurnEvent(controller, { type: 'text', data: cached.currentText.trim() });
        } else if (cached.currentThinking.trim()) {
          emitCanonicalTurnEvent(controller, { type: 'text', data: cached.currentThinking.trim() });
        }
        emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: !!err } });
        emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
        controller.close();
        resolve();
      };

      // 记忆注入
      const audioPrefix = fromAudio ? '[Audio] ' : '';
      let fullPrompt = `${buildAgentPersona()}${LARK_CLI_INSTRUCTIONS}\n\n${audioPrefix}${prompt}`;
      if (!sdkSessionId) {
        const memory = getMemoryContent(process.env.CTI_AGENT_NAME);
        if (memory) {
          fullPrompt = '以下是你的记忆文件，请在回复时参考这些上下文信息。不要主动提及你读了记忆文件，除非用户问起。\n\n' + memory + '\n---\n\n' + `${buildAgentPersona()}${LARK_CLI_INSTRUCTIONS}\n\n用户消息：` + audioPrefix + prompt;
        }
      }

      // 对话历史注入
      const history = conversationHistory;
      if (history && history.length > 0) {
        const recentHistory = history.slice(-20);
        const historyBlock = recentHistory
          .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
          .join('\n\n');
        fullPrompt = `[Previous conversation context]\n${historyBlock}\n\n[End of previous context]\n\n[Current message]\n${fullPrompt}`;
        console.log(`[openakita-provider] ACP injecting ${recentHistory.length} history messages`);
      }

      console.log(`[openakita-provider] ACP prompt id=${promptId} session=${cached.sessionId}`);
      cached.child.stdin!.write(JSON.stringify({
        jsonrpc: '2.0', id: promptId, method: 'session/prompt',
        params: {
          sessionId: cached.sessionId,
          prompt: [{ type: 'text', text: fullPrompt }],
        },
      }) + '\n');

      const timeoutMs = parseInt(process.env.CTI_OPENAKITA_TIMEOUT_MS || '300000', 10); // 默认 5 分钟
      setTimeout(() => {
        if (cached.currentSettle) {
          cached.currentSettle(`ACP prompt timeout after ${timeoutMs / 1000}s`);
        }
      }, timeoutMs);
    });
  }

  // ─── Session 持久化 ───

  private sessionFilePath(cacheKey: string): string {
    const safe = cacheKey.replace(/[^a-zA-Z0-9_:-]/g, '_');
    return path.join(OpenAkitaProvider.SESSION_DIR, `${safe}.json`);
  }

  private loadSavedSession(cacheKey: string): { sessionId: string; cwd: string } | null {
    try {
      const filePath = this.sessionFilePath(cacheKey);
      if (!fs.existsSync(filePath)) return null;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data?.sessionId && data?.cwd) {
        console.log(`[openakita-provider] Session loaded from disk: ${data.sessionId}`);
        return { sessionId: data.sessionId, cwd: data.cwd };
      }
    } catch (e) {
      console.log(`[openakita-provider] Session load failed: ${e}`);
    }
    return null;
  }

  private saveSession(cacheKey: string, sessionId: string, cwd: string): void {
    try {
      fs.mkdirSync(OpenAkitaProvider.SESSION_DIR, { recursive: true });
      const filePath = this.sessionFilePath(cacheKey);
      const data = { sessionId, cwd, savedAt: new Date().toISOString() };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      console.log(`[openakita-provider] Session saved: ${sessionId}`);
    } catch (e) {
      console.log(`[openakita-provider] Session save failed: ${e}`);
    }
  }

  private removeSavedSession(cacheKey: string): void {
    try {
      const filePath = this.sessionFilePath(cacheKey);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
  }

  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, cached] of this.acpCache) {
        if (now - cached.lastUsed > OpenAkitaProvider.IDLE_TIMEOUT_MS) {
          console.log(`[openakita-provider] ACP idle cleanup: ${cached.sessionId}`);
          this.saveSession(key, cached.sessionId, cached.cwd);
          if (cached.currentSettle) {
            cached.currentSettle('ACP process killed due to idle timeout');
          }
          cached.alive = false;
          try { cached.child.kill('SIGTERM'); } catch {}
          this.acpCache.delete(key);
        }
      }
      if (this.acpCache.size === 0 && this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }
    }, 30_000);
  }
}
