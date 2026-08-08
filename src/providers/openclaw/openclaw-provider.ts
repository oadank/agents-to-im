/**
 * Reasonix Provider — ACP 协议接入 Reasonix CLI
 *
 * 通过 ACP (Agent Client Protocol) 与 `openclaw acp` 进程通信，
 * 获得完整的 Reasonix 能力：
 * - 内置工具（Read/Write/Bash/Glob 等）
 * - MCP 服务器支持
 * - 原生记忆系统
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
  // 继承父进程 PATH（含用户配置）并补充关键系统目录，
  // 否则 reasonix acp 内 powershell.exe（hook）/ git / 其他工具会找不到
  const parentPath = process.env.PATH ? process.env.PATH.split(';').filter(Boolean) : [];
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
    // openclaw acp 环境
    OPENCLAW_STATE_DIR: process.env.CTI_OPENCLAW_ACP_STATE_DIR || 'C:\\Users\\oadan\\.openclaw',
  };
}

function resolveOpenClawExecutable(): { command: string; args: string[] } {
  const command = 'C:\\Users\\oadan\\AppData\\Roaming\\npm\\openclaw.exe';
  if (!fs.existsSync(command)) {
    console.warn(`[openclaw-provider] openclaw.exe not found at ${command}, spawn may fail`);
  }
  return { command, args: ['acp'] };
}

// ── Reasonix MCP 配置加载 ──

interface ReasonixMcpServer {
  name: string;
  url: string;
  type: string;
}

/** 从 reasonix.json 加载 Reasonix 的 MCP 服务器配置 */
function loadReasonixMcpServers(): ReasonixMcpServer[] {
  const configDir = process.env.CTI_OPENCLAW_ACP_CWD || '';
  const configPath = configDir
    ? path.join(configDir, '.reasonix/config/reasonix.json')
    : path.join(os.homedir(), '.openclaw', 'config', 'reasonix.json');
  try {
    if (!fs.existsSync(configPath)) return [];
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const mcp = raw.mcp || {};
    return Object.entries(mcp).map(([name, cfg]: [string, any]) => ({
      name,
      url: cfg.url || '',
      type: cfg.type || 'remote',
    }));
  } catch (err) {
    console.warn(`[openclaw-provider] 加载 reasonix.json 失败:`, err);
    return [];
  }
}

// ── 记忆注入 ──

function loadMemoryContent(agentName?: string): string {
  const parts: string[] = [];
  const memBase = process.env.CTI_AGENTS_MEMORY || path.join(os.homedir(), 'agents-memory');
  const agent = agentName || 'openclaw';

  // 1. Agent-specific memory
  try {
    const agentMemDir = `${memBase}/${agent}`;
    if (fs.existsSync(agentMemDir)) {
      const memFile = agentMemDir + '/MEMORY.md';
      if (fs.existsSync(memFile)) {
        parts.push(fs.readFileSync(memFile, 'utf-8'));
      }
      // Load additional memory files
      const files = fs.readdirSync(agentMemDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
      for (const file of files) {
        const fp = agentMemDir + '/' + file;
        const content = fs.readFileSync(fp, 'utf-8').trim();
        if (content) parts.push(`\n=== ${file} ===\n${content}`);
      }
    }
  } catch { /* ignore */ }

  // 2. Shared memory (read-only)
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
  if (memory) console.log(`[openclaw-provider] Memory loaded (${memory.length} chars, agent=${agentName || 'openclaw'})`);
  else console.log('[openclaw-provider] No memory loaded');
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
  /** abort 兜底定时器：session/interrupt 后 ACP 无响应时的强制 settle（正常 settle 会清理） */
  abortKillTimer?: ReturnType<typeof setTimeout> | null;
  pendingRetryAbortController: AbortController | undefined;
}

// ── OpenClawProvider ──

export class OpenClawProvider implements LLMProvider {
  private acpCache = new Map<string, CachedAcpSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private static IDLE_TIMEOUT_MS = parseInt(process.env.CTI_OPENCLAW_IDLE_TIMEOUT_MS || '900000'); // 默认 15 分钟
  private static SESSION_DIR = path.join(os.homedir(), '.openclaw', 'sessions');

  constructor() {
    this.startCleanupTimer();
  }

  /** 清除 ACP 会话缓存，下次请求时会重启 reasonix 进程（用于 /new 时重新读取配置） */
  clearCache(): void {
    for (const [key, cached] of this.acpCache) {
      console.log(`[openclaw-provider] Clear cache: ${cached.sessionId}`);
      this.saveSession(key, cached.sessionId, cached.cwd);
      cached.alive = false;
      try { cached.child.kill('SIGTERM'); } catch {}
      this.acpCache.delete(key);
    }
  }

  async prepare(): Promise<void> {
    // Windows NSSM环境下 --version 会挂死（openclaw.exe可能有网络/配置初始化），直接跳过版本检查
    // 手动测试确认 openclaw.exe acp 可用
    if (process.platform === 'win32') {
      rtLog(`[openclaw-provider] prepare: Windows environment, skipping --version check`);
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const { command, args } = resolveOpenClawExecutable();
      rtLog(`[openclaw-provider] prepare: spawning "${command}" with args: ${JSON.stringify(args)}`);
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
        rtLog(`[openclaw-provider] prepare: process closed, code=${code}, stdout="${stdoutBuf.trim()}", stderr="${stderrBuf.trim()}"`);
        code === 0 ? resolve() : reject(new Error(`reasonix CLI not available (code=${code})`));
      });
      child.on('error', (error) => {
        rtLog(`[openclaw-provider] prepare: spawn ERROR: ${error.message}`);
        reject(new Error(`Failed to spawn reasonix: ${error.message}`));
      });
      setTimeout(() => {
        rtLog(`[openclaw-provider] prepare: TIMEOUT (10s), killing process`);
        child.kill();
        reject(new Error('reasonix prepare timeout (10s)'));
      }, 10000);
    });
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;
    return new ReadableStream<string>({
      async start(controller) {
        try {
          await self.runAcp(controller, params);
        } catch (e) {
          console.error('[openclaw-provider] streamChat error:', e);
          rtLog(`[openclaw-provider] streamChat CAUGHT ERROR: ${e}`);
          emitCanonicalTurnEvent(controller, { type: 'error', data: String(e) });
          emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
          controller.close();
        }
      },
    });
  }

  /**
   * 通过 ACP 协议与 reasonix acp 进程交互
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
      console.log(`[openclaw-provider] ACP reuse session: ${existing.sessionId}`);
      emitCanonicalTurnEvent(controller, {
        type: 'status', data: { session_id: existing.sessionId || sdkSessionId || '' },
      });
      return this.sendAcpPrompt(existing, prompt, controller, sdkSessionId, abortController, params.conversationHistory, params.fromAudio);
    }

    // 新建 session
    // Windows spawn 的 cwd 必须指向实际存在的目录，否则报 ENOENT
    const rawCwd = params.workingDirectory || process.cwd();
    const cwd = process.platform === 'win32' && !fs.existsSync(rawCwd)
      ? (process.env.USERPROFILE || 'C:\\Users\\oadan')
      : rawCwd;

    rtLog(`[openclaw-provider] ACP spawn: bin=openclaw cwd=${cwd}`);
    console.log(`[openclaw-provider] runAcp: sdkSessionId=${sdkSessionId || '(empty)'} cacheKey=${cacheKey}`);
    const configCwd = process.env.CTI_OPENCLAW_ACP_CWD || cwd;
    // session/new 必须传绝对路径，否则 reasonix 的信任列表检查可能不匹配
    const sessionNewCwd = process.platform === 'win32' ? cwd : configCwd;

    const saved = this.loadSavedSession(cacheKey);

    const { command, args } = resolveOpenClawExecutable();
    rtLog(`[openclaw-provider] ACP resolved: command="${command}" args=${JSON.stringify(args)}`);
    const env = buildSpawnEnv();
    const child = spawn(command, [...args], {
      cwd: configCwd, stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    });
    rtLog(`[openclaw-provider] ACP spawned successfully: pid=${child.pid}`);

    // 诊断日志：原始字节流监控
    child.stdout.on('data', (chunk: Buffer) => {
      rtLog(`[openclaw-provider] RAW STDOUT: ${chunk.length} bytes -> "${chunk.toString('utf-8')}"`);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      rtLog(`[openclaw-provider] RAW STDERR: ${chunk.length} bytes -> "${chunk.toString('utf-8')}"`);
    });
    child.on('error', (err) => {
      rtLog(`[openclaw-provider] SPAWN ERROR: ${err}`);
    });
    child.on('close', (code, signal) => {
      rtLog(`[openclaw-provider] PROCESS CLOSED: code=${code} signal=${signal}`);
    });

    // spawnError must be in outer scope — it is read after the Promise resolves.
    // esbuild may rename inner-only vars, causing ReferenceError on outer reference.
    let spawnError = '';
    // 捕获 openclaw acp 子进程的 stderr 尾部（如 "ACP bridge failed: connect ECONNREFUSED ..."）
    // 用于初始化失败时透出真实原因，替代笼统的 "Failed to initialize ACP session"
    let acpStderrTail = '';

    // 必须读 stderr，否则管道满了进程卡死
    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        rtLog(`[openclaw-provider] ACP stderr: ${text.slice(0, 500)}`);
        // 只保留最近一段，避免无限增长；优先记录连接类错误
        acpStderrTail = text.slice(0, 400);
      }
    });

    emitCanonicalTurnEvent(controller, {
      type: 'status', data: { session_id: sdkSessionId || '' },
    });

    // 等待 initialize 完成，然后 session/new
    const cached = await new Promise<CachedAcpSession | null>((resolve) => {
      let lineBuf = '';
      let sessionDone = false;
      let sessionId = '';
      const initId = 1;
      let sessionId2 = 2;
      let resolved = false;
      let resumeAttempted = false;

      const done = (c: CachedAcpSession | null) => {
        if (resolved) {
          console.warn(`[openclaw-provider] done 被二次触发！当前值 sessionId=${c?.sessionId} alive=${c?.alive}`);
          return;
        }
        resolved = true;
        console.log(`[openclaw-provider] done 触发，resolve 值 sessionId=${c?.sessionId} alive=${c?.alive}`);
        resolve(c);
      };

      const createCacheEntry = (sid: string) => {
        const cached: CachedAcpSession = {
          child, sessionId: sid, cwd, env,
          lineBuf: '', lastUsed: Date.now(),
          currentSettle: null, currentController: null, currentText: '', currentThinking: '', _inThinking: false, _textEmitted: false, _firstUpdateLogged: false,
          nextId: 100, currentPromptId: 0, alive: true,
          sessionRecoveryAttempts: 0, pendingRetryPrompt: null,
          pendingRetrySettle: null, pendingRetryController: null,
          pendingRetrySdkSessionId: undefined, pendingRetryAbortController: undefined,
        };

        child.stdout!.removeAllListeners('data');
        child.stdout!.on('data', (c: Buffer) => this.onAcpData(cached, c));

        child.on('close', (code) => {
          cached.alive = false;
          console.log(`[openclaw-provider] ACP process exited code=${code}`);
          this.acpCache.delete(cacheKey);
        });

        this.acpCache.set(cacheKey, cached);
        this.startCleanupTimer();
        this.saveSession(cacheKey, sid, cwd);

        return cached;
      };

      // session/new 的 cwd 必须是绝对路径（reasonix acp 校验）
      const sessionNewCwd = configCwd;

      const fallbackToNew = () => {
        console.log(`[openclaw-provider] Resume failed, falling back to session/new`);
        this.removeSavedSession(cacheKey);
        resumeAttempted = true;
        sessionId2 = 99;
        child.stdin!.write(JSON.stringify({
          jsonrpc: '2.0', id: sessionId2, method: 'session/new',
          params: { cwd: sessionNewCwd, mcpServers: [] },
        }) + '\n');
      };

      child.on('error', (err) => {
        spawnError = err.message; // writes outer-scope var
        console.error(`[openclaw-provider] ACP spawn error: ${err.message}`);
        done(null);
      });

      child.on('close', (code) => {
        if (!sessionDone) {
          console.error(`[openclaw-provider] ACP exited during init code=${code}`);
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
              console.log(`[openclaw-provider] ACP initialized`);
              if (saved) {
                console.log(`[openclaw-provider] Attempting session/load: ${saved.sessionId}`);
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
              console.log(`[openclaw-provider] ACP session (${action}): ${sessionId}`);
              const cached = createCacheEntry(sessionId);
              // 透出真实 openclaw sessionId，让 bridge 保存到 binding.sdkSessionId，
              // 下次消息才能复用同一个会话而不是每次新开
              emitCanonicalTurnEvent(controller, {
                type: 'status', data: { session_id: sessionId || sdkSessionId || '' },
              });
              done(cached);
              continue;
            }

            if (id === sessionId2 && msg.error && !resumeAttempted && saved) {
              console.log(`[openclaw-provider] session/load failed: ${JSON.stringify(msg.error)}`);
              fallbackToNew();
              continue;
            }

            if (id != null && (id === initId || id === sessionId2) && msg.error) {
              console.error(`[openclaw-provider] ACP init error:`, JSON.stringify(msg.error));
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
          clientInfo: { name: 'feishu-reasonix', version: '1.0' },
        },
      }) + '\n');

      setTimeout(() => { if (!sessionDone) { child.kill('SIGTERM'); done(null); } }, 60_000);
    });

    rtLog(`[openclaw-provider] runAcp cached = ${cached}`);
    if (!cached) {
      const err = spawnError || acpStderrTail || 'Failed to initialize ACP session';
      console.error(`[openclaw-provider] ACP init failed:`, err);
      emitCanonicalTurnEvent(controller, { type: 'error', data: err });
      emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: true } });
      emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
      controller.close();
      return;
    }

    return this.sendAcpPrompt(cached, prompt, controller, sdkSessionId, abortController, params.conversationHistory, params.fromAudio);
  }

  /** 处理 ACP 进程的 stdout 数据 */
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
            const isSessionNotFound = errMsg.includes('Session not found') || errDetails.includes('Session not found');
            if (isSessionNotFound && cached.sessionRecoveryAttempts < 1) {
              cached.sessionRecoveryAttempts++;
              console.log(`[openclaw-provider] ACP Session not found, recreating (attempt ${cached.sessionRecoveryAttempts})`);
              cached.pendingRetrySettle = cached.currentSettle;
              cached.currentSettle = null;
              const newSessionId = cached.nextId++;
              cached.currentPromptId = newSessionId;
              // session/new cwd 必须是绝对路径（reasonix acp 校验）
              const recoverCwd = configCwd;
              cached.child.stdin!.write(JSON.stringify({
                jsonrpc: '2.0', id: newSessionId, method: 'session/new',
                params: { cwd: recoverCwd, mcpServers: [] },
              }) + '\n');
              continue;
            }
            cached.currentSettle(`ACP error: ${errMsg}`);
          } else {
            console.log(`[openclaw-provider] ACP prompt done`);
            cached.currentSettle();
          }
          continue;
        }

        // session/update 通知
        if (msg.method === 'session/update') {
          if (!cached._firstUpdateLogged) {
            cached._firstUpdateLogged = true;
            console.log(`[openclaw-provider] ACP first update after ${Date.now() - cached.lastUsed}ms`);
          }
          const update = msg.params?.update;
          const updateType = (update?.sessionUpdate as string) || 'unknown';

          if (update?.sessionUpdate === 'agent_message_chunk' && update?.content?.type === 'text') {
            const chunk = update.content.text;
            // 解析 <think>...</think> 标签，分离思考和正文
            let remaining = chunk;
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
                  // 发送完整思考内容
                  if (cached.currentController && cached.currentThinking.trim()) {
                    emitCanonicalTurnEvent(cached.currentController, {
                      type: 'activity_event',
                      data: {
                        kind: 'reasoning_activity',
                        id: 'thinking:reasonix',
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
                  id: 'thinking:reasonix',
                  status: 'running',
                  text: cached.currentThinking,
                },
              });
            }
          }
          if (update?.sessionUpdate === 'tool_call') {
            const toolInfo = update.input ? `${update.title} ${JSON.stringify(update.input).slice(0, 100)}` : (update.title || '工具');
            const toolStatus = (update.status as string) || 'running';
            const toolCallId = String((update as any).toolCallId || (update as any).callId || `reasonix-tool:${update.title || 'tool'}:${Date.now()}`);
            const toolName = String(update.title || 'tool');
            console.log(`[openclaw-provider] ACP tool_call: ${toolInfo} status=${toolStatus} id=${toolCallId}`);
            // 只发 activity_event，不改 tool_use/tool_result（避免破坏现有的 block 格式）
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

        // 权限请求 → 自动批准
        if (msg.method === 'session/request_permission') {
          const options = msg.params?.options as Array<{ optionId: string }> | undefined;
          const allowOption = options?.find(o => o.optionId === 'proceed_always')
            || options?.find(o => o.optionId === 'allow')
            || options?.find(o => o.optionId === 'allow_project')
            || options?.find(o => o.optionId === 'proceed_once')
            || options?.[0];
          const optionId = allowOption?.optionId || 'proceed_always';
          console.log(`[openclaw-provider] ACP auto-approve perm reqId=${msg.id} optionId=${optionId}`);
          cached.child.stdin!.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { outcome: { outcome: 'selected', optionId } },
          }) + '\n');
          continue;
        }

        // init 阶段响应（已处理）
        if (id != null && id <= 2 && isResponse) continue;

        // Session recovery: new session + retry
        if (isResponse && cached.pendingRetryPrompt && cached.pendingRetrySettle && id != null && id === cached.currentPromptId) {
          if (msg.error) {
            console.error(`[openclaw-provider] ACP session recovery failed:`, JSON.stringify(msg.error));
            cached.pendingRetrySettle(`ACP error: Session recovery failed: ${msg.error.message || JSON.stringify(msg.error)}`);
            cached.pendingRetryPrompt = null;
            cached.pendingRetrySettle = null;
            cached.pendingRetryController = null;
            continue;
          }
          const r = msg.result as Record<string, unknown>;
          const newSessionId = r.sessionId as string;
          console.log(`[openclaw-provider] ACP session recovered: ${newSessionId}`);
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
          // session/new cwd 必须是绝对路径（reasonix acp 校验）
          const retrySessionNewCwd = configCwd;
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
    rtLog(`[openclaw-provider] sendAcpPrompt ENTERED, cached.alive=${cached?.alive}, cached.nextId=${cached?.nextId}, cached.sessionId=${cached?.sessionId}`);
    return new Promise<void>((resolve) => {
      const promptId = cached.nextId++;
      cached.currentPromptId = promptId;
      cached.currentText = '';
      cached.currentThinking = '';
      cached._inThinking = false;
      cached._textEmitted = false;
      cached.lastUsed = Date.now();
      // 先增强 prompt（加入 LARK_CLI_INSTRUCTIONS），再存入 pendingRetryPrompt 以便重试时携带
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
        console.log(`[openclaw-provider] ACP abort: sending session/interrupt (keep process alive)`);
        try {
          // interrupt 用当前 prompt 的 id：openclaw 会以该 id 返回 stop reason 响应，
          // 从而触发 currentSettle() 结束当前轮。若用 nextId++（自增 id），响应不匹配
          // currentPromptId，settle 永不触发 → 锁链卡死。
          cached.child.stdin!.write(JSON.stringify({
            jsonrpc: '2.0', id: cached.currentPromptId, method: 'session/interrupt',
            params: { sessionId: cached.sessionId },
          }) + '\n');
        } catch {}
        // 插队语义：中断当前 turn，但进程保持存活，新消息复用同一 session 继续处理。
        // 仅在 ACP 完全不响应（interrupt 后仍无 settle）时兜底 settle，避免锁链卡死。
        const killTimer = setTimeout(() => {
          if (cached.currentSettle) {
            console.warn(`[openclaw-provider] ACP interrupt unresponsive after 10s, force settling`);
            cached.currentSettle('Interrupted: ACP did not respond to session/interrupt');
          }
        }, 10_000);
        cached.abortKillTimer = killTimer;
      };
      abortController?.signal.addEventListener('abort', abortHandler, { once: true });

      cached.currentController = controller;
      cached.currentSettle = (err?: string) => {
        if (cached.abortKillTimer) { clearTimeout(cached.abortKillTimer); cached.abortKillTimer = null; }
        cached.currentSettle = null;
        cached.currentController = null;
        cached.pendingRetryPrompt = null;
        cached.pendingRetrySettle = null;
        cached.pendingRetryController = null;
        cached.pendingRetrySdkSessionId = undefined;
        cached.pendingRetryAbortController = undefined;
        abortController?.signal.removeEventListener('abort', abortHandler);

        if (err) {
          console.error(`[openclaw-provider] ACP error:`, err);
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
        } else {
          // 无文本也无思考（纯工具调用），正常结束
        }
        emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: cached.sessionId || sdkSessionId || '', is_error: !!err } });
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
        console.log(`[openclaw-provider] ACP injecting ${recentHistory.length} history messages`);
      }

      console.log(`[openclaw-provider] ACP prompt id=${promptId} session=${cached.sessionId}`);
      const promptSentAt = Date.now();
      cached.child.stdin!.write(JSON.stringify({
        jsonrpc: '2.0', id: promptId, method: 'session/prompt',
        params: {
          sessionId: cached.sessionId,
          prompt: [{ type: 'text', text: fullPrompt }],
        },
      }) + '\n');

      const timeoutMs = parseInt(process.env.CTI_OPENCLAW_TIMEOUT_MS || '300000', 10); // default 5 min (was 30 min)
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
    return path.join(OpenClawProvider.SESSION_DIR, `${safe}.json`);
  }

  private loadSavedSession(cacheKey: string): { sessionId: string; cwd: string } | null {
    try {
      const filePath = this.sessionFilePath(cacheKey);
      console.log(`[openclaw-provider] loadSavedSession: key=${cacheKey} path=${filePath} exists=${fs.existsSync(filePath)}`);
      if (!fs.existsSync(filePath)) return null;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data?.sessionId && data?.cwd) {
        console.log(`[openclaw-provider] Session loaded from disk: ${data.sessionId}`);
        return { sessionId: data.sessionId, cwd: data.cwd };
      }
    } catch (e) {
      console.log(`[openclaw-provider] Session load failed: ${e}`);
    }
    return null;
  }

  private saveSession(cacheKey: string, sessionId: string, cwd: string): void {
    try {
      fs.mkdirSync(OpenClawProvider.SESSION_DIR, { recursive: true });
      const data = { sessionId, cwd, savedAt: new Date().toISOString() };
      // 双写：cacheKey 名 + 真实 sessionId 名。
      // 因为 bridge 会把真实 openclaw sessionId 存进 binding.sdkSessionId，
      // 下次消息 cacheKey=真实sessionId，需要能按此读到
      const keys = new Set<string>([cacheKey, sessionId]);
      console.log(`[openclaw-provider] saveSession: cacheKey=${cacheKey} sessionId=${sessionId} dir=${OpenClawProvider.SESSION_DIR}`);
      for (const key of keys) {
        const filePath = this.sessionFilePath(key);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      }
      console.log(`[openclaw-provider] Session saved: ${sessionId}`);
    } catch (e) {
      console.log(`[openclaw-provider] Session save failed: ${e}`);
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
        if (now - cached.lastUsed > OpenClawProvider.IDLE_TIMEOUT_MS) {
          console.log(`[openclaw-provider] ACP idle cleanup: ${cached.sessionId}`);
          this.saveSession(key, cached.sessionId, cached.cwd);
          // 通知等待中的 prompt，避免干等到超时
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
    }, 60_000);
  }
}

export function createOpenClawProvider(): OpenClawProvider {
  return new OpenClawProvider();
}
