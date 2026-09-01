/**
 * DSH Provider — ACP 协议接入 DeepSeek Harness ACP 服务器
 *
 * 通过 ACP (Agent Client Protocol, JSON-RPC 2.0 over stdin/stdout) 与
 * `dsh-acp-demo` 进程通信，获得完整的 DeepSeek Harness 能力：
 * - 内置工具（Read/Write/Bash/Glob/Subagent/Workflow 等）
 * - 沙箱化的 bash + 文件系统栈
 * - 会话级 JSONL 持久化（服务端进程内）
 *
 * 与 ReasonixProvider 的协议差异（DSH ACP 服务器为"提交式"输出）：
 * - session/update 只推送 agent_message_chunk（已提交的文本块），
 *   不推送思考/工具事件 → 飞书卡片只显示最终正文（activityGranularity: basic）
 * - 不支持 session/load → 进程重启后会话归零（服务端持久化在进程内）
 * - session/new 必填 mcpServers: []（不接受非空）
 * - 权限：danger-full-access 下 approval=never，不会触发 request_permission
 */

import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { larkInstructions, buildAgentPersona } from '../../config/runtime-configs.js';
import type { LLMProvider, StreamChatParams, FileAttachment } from '../../bridge/host.js';
import { emitCanonicalTurnEvent } from '../../infra/sse-utils.js';

// 实时日志：绕过 NSSM stdout 缓冲
function rtLog(msg: string): void {
  const DEBUG_LOG = `C:\\D\\opt\\agents-to-im\\debug_realtime_${process.env.CTI_BOT || 'unknown'}.log`;
  try {
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8');
  } catch {}
}

/**
 * DSH usage 统计落盘（格式对齐 reasonix stats：stats/YYYY-MM-DD.jsonl，source=cli）。
 * 供 adapter 的 meta 行展示 Cache/平均/上下文。ACP 事件透传的 TokenUsage 是 disjoint
 * 计数（inputTokens=未缓存输入，cacheReadTokens=缓存命中），这里换算成 reasonix 口径：
 * prompt = inputTokens + cacheReadTokens，cache_hit = cacheReadTokens，cache_miss = inputTokens。
 */
export function recordDshUsageStats(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}): void {
  try {
    const input = Number(usage.inputTokens ?? 0);
    const cacheRead = Number(usage.cacheReadTokens ?? 0);
    const hit = cacheRead;
    const miss = input;
    if (hit + miss <= 0) return; // 无 token 记录（如空回复），跳过
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const statsDir = path.join(home, 'dsh-bot', 'stats');
    fs.mkdirSync(statsDir, { recursive: true });
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const file = path.join(statsDir, `${localDate}.jsonl`);
    const rec = {
      ts: now.toISOString(),
      model: 'deepseek-v4-flash',
      source: 'cli',
      prompt: input + cacheRead,
      completion: Number(usage.outputTokens ?? 0),
      reasoning: Number(usage.reasoningTokens ?? 0),
      cache_hit: hit,
      cache_miss: miss,
      total: input + cacheRead + Number(usage.outputTokens ?? 0),
      requests: 1,
    };
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf-8');
  } catch {}
}

/**
 * 在 Windows 上，NSSM 服务环境的 PATH/ComSpec/SystemRoot 可能不完整，
 * 导致 CreateProcess 找不到 node.exe 或 cmd.exe。
 * 此函数确保 spawn 的 env 包含最少必需的系统变量。
 *
 * ⚠️ 必须剥离宿主 DSH 会话环境变量（DSH_HOME / DSH_SESSION_ID / DSH_SESSION_JSONL /
 * DSH_SHELL / DSH_WEB_URL 等）：daemon 若在 DSH 会话里启动（pm2/NSSM 继承），
 * ACP 服务器会拿到宿主会话的路径，尝试挂到正在运行的会话存储/索引
 * （session-query SQLite 锁冲突），导致 session/prompt 后无声卡死（零 CPU、无网络）。
 */
function buildSpawnEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DSH_')) continue;
    clean[key] = value;
  }
  if (process.platform !== 'win32') return { ...clean, ...extra };
  const parentPath = (clean.PATH || '').split(';').filter(Boolean);
  return {
    ...clean,
    ...extra,
    ComSpec: clean.ComSpec || 'C:\\WINDOWS\\system32\\cmd.exe',
    SystemRoot: clean.SystemRoot || 'C:\\WINDOWS',
    PATH: [
      ...parentPath,
      'C:\\WINDOWS\\system32',
      'C:\\WINDOWS',
      'C:\\WINDOWS\\System32\\Wbem',
      'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0',
      'C:\\Program Files\\nodejs',
      'C:\\Users\\oadan\\AppData\\Roaming\\npm',
      // Git bash（dsh 的 bash 工具依赖 bash.exe；nssm 服务环境 PATH 不含 Git）
      'C:\\Program Files\\Git\\bin',
      'C:\\Program Files\\Git\\usr\\bin',
      'C:\\Program Files\\Git\\cmd',
    ].join(';'),
  };
}

/**
 * 读取 DeepSeek API Key：优先显式环境变量 CTI_DSH_DEEPSEEK_API_KEY，
 * 否则从 ~/.dsh/.credentials.yaml 读取（DSH 官方凭证文件）。
 */
function readDeepSeekApiKey(): string {
  const explicit = process.env.CTI_DSH_DEEPSEEK_API_KEY;
  if (explicit) return explicit;
  try {
    const cred = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    const txt = fs.readFileSync(cred, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)/);
      if (m) return m[1];
    }
  } catch {}
  return process.env.DEEPSEEK_API_KEY || '';
}

/** 解析 DSH ACP 服务器的启动命令（node + acp-demo bin + 部署配置）。 */
function resolveDshCommand(): { command: string; args: string[]; cwd: string } {
  const harness = process.env.CTI_DSH_HARNESS_PATH || 'C:\\D\\opt\\deepseek-harness\\deepseek-harness';
  const config = process.env.CTI_DSH_ACP_CONFIG || path.join(os.homedir(), '.dsh', 'dsh-bot', 'cordis.yml');
  const command = process.execPath; // 与 daemon 同款 node
  const args = ['--import', 'tsx/esm', 'packages/examples/acp-demo/src/bin.ts', '--config', config];
  return { command, args, cwd: harness };
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
  /** 思考层累计文本（agent_thought_chunk 增量） */
  currentThinking: string;
  _textEmitted: boolean;
  nextId: number;
  currentPromptId: number;
  alive: boolean;
  /** 该进程/会话是否已注入过人设（buildAgentPersona+larkInstructions()） */
  personaInjected: boolean;
  /** 空闲超时计时器：每次收到 ACP 输出都重置；连续 timeoutMs 无输出才判定卡死 */
  inactivityTimer: ReturnType<typeof setTimeout> | null;
  resetInactivityTimer?: () => void;
  /** abort 兜底定时器：session/cancel 后 ACP 无响应时的强制 settle */
  abortKillTimer?: ReturnType<typeof setTimeout> | null;
}

// ── DshProvider ──

export class DshProvider implements LLMProvider {
  private acpCache = new Map<string, CachedAcpSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private static IDLE_TIMEOUT_MS = parseInt(process.env.CTI_DSH_IDLE_TIMEOUT_MS || '900000', 10); // 默认 15 分钟

  constructor() {
    this.startCleanupTimer();
  }

  /** 清除 ACP 会话缓存（/new 用）：kill 全部引擎进程 + 清内存缓存。 */
  clearCache(): void {
    for (const [key, cached] of this.acpCache) {
      console.log(`[dsh-provider] Clear cache: ${cached.sessionId} (key=${key.slice(0, 8)})`);
      cached.alive = false;
      if (cached.currentSettle) {
        const settle = cached.currentSettle;
        cached.currentSettle = null;
        settle('Cache cleared by /new');
      }
      try { cached.child.kill('SIGTERM'); } catch {}
      this.acpCache.delete(key);
    }
  }

  /**
   * 重置 ACP 会话（/new 用）：kill 子进程 + 清内存缓存。
   * 与 clearCache 相同（DSH 不支持 session/load，无需归档指针文件），
   * 下次消息必然走 session/new 全新空白会话。
   */
  resetSession(cacheKey?: string): void {
    const keys = cacheKey ? [cacheKey] : [...this.acpCache.keys()];
    for (const key of keys) {
      const cached = this.acpCache.get(key);
      if (cached) {
        console.log(`[dsh-provider] Reset ACP session: ${cached.sessionId} (key=${key.slice(0, 8)})`);
        cached.alive = false;
        if (cached.currentSettle) {
          const settle = cached.currentSettle;
          cached.currentSettle = null;
          settle('Session reset by /new');
        }
        try { cached.child.kill('SIGTERM'); } catch {}
        this.acpCache.delete(key);
      }
    }
    console.log(`[dsh-provider] resetSession: reset ${keys.length} key(s)`);
    rtLog(`[dsh-provider] resetSession(${cacheKey || '(all)'}) done, keys=${keys.length}`);
  }

  async prepare(): Promise<void> {
    // 检查 DSH ACP 服务器可启动性：node + 配置文件存在即可
    const { command, cwd } = resolveDshCommand();
    const config = process.env.CTI_DSH_ACP_CONFIG || path.join(os.homedir(), '.dsh', 'dsh-bot', 'cordis.yml');
    if (!fs.existsSync(config)) {
      throw new Error(`DSH ACP config not found: ${config}`);
    }
    if (!fs.existsSync(path.join(cwd, 'packages', 'examples', 'acp-demo', 'src', 'bin.ts'))) {
      throw new Error(`DSH harness not found at: ${cwd} (set CTI_DSH_HARNESS_PATH)`);
    }
    rtLog(`[dsh-provider] prepare OK: node=${command} harness=${cwd}`);
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;
    return new ReadableStream<string>({
      async start(controller) {
        try {
          await self.runAcp(controller, params);
        } catch (e) {
          console.error('[dsh-provider] streamChat error:', e);
          rtLog(`[dsh-provider] streamChat CAUGHT ERROR: ${e}`);
          emitCanonicalTurnEvent(controller, { type: 'error', data: String(e) });
          emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
          controller.close();
        }
      },
    });
  }

  /**
   * 通过 ACP 协议与 DSH ACP 服务器交互。
   * 支持进程缓存：首次 spawn 并缓存，后续消息复用同一 session。
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
      console.log(`[dsh-provider] ACP reuse session: ${existing.sessionId}`);
      emitCanonicalTurnEvent(controller, { type: 'status', data: { session_id: sdkSessionId || '' } });
      return this.sendAcpPrompt(existing, prompt, controller, sdkSessionId, abortController, params.fromAudio, params.files);
    }

    // 新建 session：cwd 必须是实际存在的绝对路径
    const rawCwd = params.workingDirectory || process.env.CTI_DEFAULT_WORKDIR || process.cwd();
    const cwd = process.platform === 'win32' && !fs.existsSync(rawCwd)
      ? (process.env.USERPROFILE || 'C:\\Users\\oadan')
      : rawCwd;

    rtLog(`[dsh-provider] ACP spawn: cwd=${cwd}`);
    const { command, args, cwd: harnessCwd } = resolveDshCommand();

    const key = readDeepSeekApiKey();
    const env = buildSpawnEnv({
      DEEPSEEK_API_KEY: key,
      DSH_PERMISSION_MODE: 'danger-full-access',
    });

    const child = spawn(command, args, {
      cwd: harnessCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    });
    rtLog(`[dsh-provider] ACP spawned: pid=${child.pid} cmd=${command} args=${JSON.stringify(args)}`);

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) rtLog(`[dsh-provider] ACP stderr: ${text.slice(0, 500)}`);
    });
    child.on('error', (err) => {
      rtLog(`[dsh-provider] SPAWN ERROR: ${err.message}`);
    });

    emitCanonicalTurnEvent(controller, { type: 'status', data: { session_id: sdkSessionId || '' } });

    // 等待 initialize 完成，然后 session/new
    const cached = await new Promise<CachedAcpSession | null>((resolve) => {
      let lineBuf = '';
      let initDone = false;
      let sessionDone = false;
      let sessionId = '';
      const initId = 1;
      const sessionId2 = 2;
      let resolved = false;
      let spawnError = '';

      const done = (c: CachedAcpSession | null) => {
        if (resolved) return;
        resolved = true;
        resolve(c);
      };

      const createCacheEntry = (sid: string) => {
        const cached: CachedAcpSession = {
          child, sessionId: sid, cwd, env,
          lineBuf: '', lastUsed: Date.now(),
          currentSettle: null, currentController: null, currentText: '', currentThinking: '', _textEmitted: false,
          nextId: 100, currentPromptId: 0, alive: true, personaInjected: false,
          inactivityTimer: null, resetInactivityTimer: undefined, abortKillTimer: null,
        };
        child.stdout!.removeAllListeners('data');
        child.stdout!.on('data', (c: Buffer) => this.onAcpData(cached, c));
        child.on('close', (code) => {
          cached.alive = false;
          console.log(`[dsh-provider] ACP process exited code=${code}`);
          this.acpCache.delete(cacheKey);
          if (cached.currentSettle) {
            const settle = cached.currentSettle;
            cached.currentSettle = null;
            settle('ACP process exited unexpectedly');
          }
        });
        this.acpCache.set(cacheKey, cached);
        this.startCleanupTimer();
        return cached;
      };

      child.on('error', (err) => {
        spawnError = err.message;
        console.error(`[dsh-provider] ACP spawn error: ${err.message}`);
        done(null);
      });
      child.on('close', (code) => {
        if (!sessionDone) {
          console.error(`[dsh-provider] ACP exited during init code=${code}`);
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
              console.log(`[dsh-provider] ACP initialized`);
              initDone = true;
              child.stdin!.write(JSON.stringify({
                jsonrpc: '2.0', id: sessionId2, method: 'session/new',
                params: { cwd, mcpServers: [] },
              }) + '\n');
              continue;
            }

            if (id === sessionId2 && msg.result) {
              const r = msg.result as Record<string, unknown>;
              sessionId = (r.sessionId as string) || '';
              sessionDone = true;
              console.log(`[dsh-provider] ACP session new: ${sessionId}`);
              const cached = createCacheEntry(sessionId);
              done(cached);
              continue;
            }

            if (id === sessionId2 && msg.error) {
              console.error(`[dsh-provider] session/new error:`, JSON.stringify(msg.error));
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
          clientInfo: { name: 'feishu-dsh', version: '1.0' },
        },
      }) + '\n');

      // DSH 首次启动含 tsx 编译 + 组合加载，给足 120s
      setTimeout(() => {
        if (!sessionDone) {
          try { child.kill('SIGTERM'); } catch {}
          done(null);
        }
      }, 120_000);
    });

    rtLog(`[dsh-provider] runAcp cached = ${!!cached}`);
    if (!cached) {
      const err = 'Failed to initialize DSH ACP session';
      console.error(`[dsh-provider] ACP init failed:`, err);
      emitCanonicalTurnEvent(controller, { type: 'error', data: err });
      emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: true } });
      emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
      controller.close();
      return;
    }

    return this.sendAcpPrompt(cached, prompt, controller, sdkSessionId, abortController, params.fromAudio, params.files);
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
        // 任何 ACP stdout 输出都视为活动：重置空闲超时
        cached.resetInactivityTimer?.();
        const id = msg.id as number | undefined;
        const isResponse = !msg.method && (msg.result || msg.error);

        // 路由响应到当前 prompt 的 settle
        if (isResponse && cached.currentSettle && id != null && id === cached.currentPromptId) {
          if (msg.error) {
            const errMsg = msg.error.message || JSON.stringify(msg.error);
            cached.currentSettle(`ACP error: ${errMsg}`);
          } else {
            console.log(`[dsh-provider] ACP prompt done`);
            cached.currentSettle();
          }
          continue;
        }

        // session/update 通知：DSH 只推送提交后的文本块
        if (msg.method === 'session/update') {
          const update = msg.params?.update;
          // 思考层：agent_thought_chunk → reasoning_activity
          if (update?.sessionUpdate === 'agent_thought_chunk' && update?.content?.type === 'text') {
            cached.currentThinking = (cached.currentThinking || '') + update.content.text;
            if (cached.currentController) {
              emitCanonicalTurnEvent(cached.currentController, {
                type: 'activity_event',
                data: {
                  kind: 'reasoning_activity',
                  id: 'thinking:dsh',
                  status: 'running',
                  text: cached.currentThinking,
                },
              });
            }
            continue;
          }
          // 正文（流式增量；整块提交的 agent_message_chunk 也走这里）
          if (update?.sessionUpdate === 'agent_message_chunk' && update?.content?.type === 'text') {
            const delta = update.content.text;
            // 解析 ACP 透传的 usage（_meta.usage，见 harness acp bridge 的透传）
            const metaUsage = (update as { _meta?: { usage?: unknown } })._meta?.usage as
              | { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
              | undefined;
            if (metaUsage) {
              recordDshUsageStats(metaUsage);
              rtLog(`[dsh-provider] usage: in=${metaUsage.inputTokens ?? 0} out=${metaUsage.outputTokens ?? 0} cacheRead=${metaUsage.cacheReadTokens ?? 0}`);
            }
            if (cached.currentController && delta) {
              cached.currentText += delta;
              cached._textEmitted = true;
              emitCanonicalTurnEvent(cached.currentController, { type: 'text', data: delta });
            }
            continue;
          }
          // 工具层：tool_call（开始）/ tool_call_update（完成）→ tool_activity
          if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
            const u = update as any;
            const toolCallId = String(u.toolCallId || u.callId || `dsh-tool:${Date.now()}`);
            const toolName = String(u.title || 'tool');
            const toolStatus = String(u.status || (u.sessionUpdate === 'tool_call' ? 'in_progress' : 'running'));
            const rawInput = u.rawInput ?? u.input;
            const rawOutput = u.rawOutput ?? u.output;
            console.log(`[dsh-provider] ACP tool: ${toolName} status=${toolStatus} id=${toolCallId}`);
            if (cached.currentController) {
              emitCanonicalTurnEvent(cached.currentController, {
                type: 'activity_event',
                data: {
                  kind: 'tool_activity',
                  toolUseId: toolCallId,
                  toolName,
                  status: toolStatus === 'failed' ? 'failed' : (toolStatus === 'completed' ? 'completed' : 'running'),
                  inputPreview: rawInput && typeof rawInput === 'object'
                    ? JSON.stringify(rawInput).slice(0, 220)
                    : (typeof rawInput === 'string' ? rawInput.slice(0, 220) : ''),
                  resultPreview: typeof rawOutput === 'string' ? rawOutput.slice(0, 220) : '',
                },
              });
            }
            continue;
          }
          continue;
        }

        // 权限请求 → 自动批准（danger-full-access 下 approval=never 不会触发，防御性兜底）
        if (msg.method === 'session/request_permission') {
          const options = msg.params?.options as Array<{ optionId: string }> | undefined;
          const allowOption = options?.find(o => o.optionId === 'allow-once')
            || options?.find(o => o.optionId === 'allow_once')
            || options?.find(o => o.optionId === 'allow')
            || options?.[0];
          const optionId = allowOption?.optionId || 'allow-once';
          console.log(`[dsh-provider] ACP auto-approve perm reqId=${msg.id} optionId=${optionId}`);
          cached.child.stdin!.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { outcome: { outcome: 'selected', optionId } },
          }) + '\n');
          continue;
        }

        // init/session-new 阶段的响应（已在 runAcp 内处理）
        if (id != null && id <= 2 && isResponse) continue;
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
    fromAudio?: boolean,
    files?: FileAttachment[],
  ): Promise<void> {
    rtLog(`[dsh-provider] sendAcpPrompt ENTERED, alive=${cached?.alive}, nextId=${cached?.nextId}`);
    return new Promise<void>((resolve) => {
      const promptId = cached.nextId++;
      cached.currentPromptId = promptId;
      cached.currentText = '';
      cached._textEmitted = false;
      cached.lastUsed = Date.now();

      // 仅首次发消息时注入人设（buildAgentPersona + larkInstructions）。
      // DSH 服务端在进程内持久化完整 transcript，重复注入会导致上下文膨胀。
      const audioPrefix = fromAudio ? '[Audio] ' : '';
      let fullPrompt = `${audioPrefix}${prompt}`;
      if (!cached.personaInjected) {
        fullPrompt = `${buildAgentPersona()}${larkInstructions()}\n\n${audioPrefix}${prompt}`;
        cached.personaInjected = true;
      }

      // DSH harness 的 ACP 协议不支持 image content（promptCapabilities.image=false），
      // 图片附件无法直接传给模型。改为：把图片 base64 落盘到固定目录，并把路径注入
      // 文本 prompt，模型侧用 visionqa MCP（look 工具，Ollama qwen3-vl）查看图片。
      if (files && files.length > 0) {
        try {
          const imgDir = process.env.CTI_DSH_IMAGE_DIR || 'C:\\D\\opt\\feishu-images';
          fs.mkdirSync(imgDir, { recursive: true });
          const savedPaths: string[] = [];
          for (const f of files) {
            if (!f.data || !f.type?.startsWith('image/')) continue;
            const safeName = path.basename(f.name || `image-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_');
            const filePath = path.join(imgDir, `${Date.now()}-${cached.nextId}-${safeName}`);
            fs.writeFileSync(filePath, Buffer.from(f.data, 'base64'));
            savedPaths.push(filePath);
          }
          if (savedPaths.length > 0) {
            const imgHint =
              `\n\n【用户发来图片，共 ${savedPaths.length} 张，已保存到本机】\n` +
              savedPaths.map((p) => `- ${p}`).join('\n') +
              `\n请用 visionqa MCP 的 look 工具逐张查看（look(image_path="<上面某个路径>", task="general")），` +
              `反推可用于生图的提示词；若图片是文字/代码/界面截图，task 改用 "text" 或 "ui"。`;
            fullPrompt = `${fullPrompt}${imgHint}`;
          }
        } catch (err) {
          console.error('[dsh-provider] Failed to persist inbound images:', err);
          rtLog(`[dsh-provider] persist inbound images error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const abortHandler = () => {
        if (cached.inactivityTimer) { clearTimeout(cached.inactivityTimer); cached.inactivityTimer = null; }
        console.log(`[dsh-provider] ACP abort: sending session/cancel`);
        rtLog(`[dsh-provider] ACP abort: promptId=${cached.currentPromptId} settle=${!!cached.currentSettle}`);
        try {
          cached.child.stdin!.write(JSON.stringify({
            jsonrpc: '2.0', method: 'session/cancel',
            params: { sessionId: cached.sessionId },
          }) + '\n');
        } catch {}
        // 插队语义：取消当前 turn，进程保持存活；ACP 不响应时兜底 settle
        const killTimer = setTimeout(() => {
          if (cached.currentSettle) {
            console.warn(`[dsh-provider] ACP cancel unresponsive after 10s, force settling`);
            cached.currentSettle('Interrupted: ACP did not respond to session/cancel');
          }
        }, 10_000);
        cached.abortKillTimer = killTimer;
      };
      abortController?.signal.addEventListener('abort', abortHandler, { once: true });

      cached.currentController = controller;
      cached.currentSettle = (err?: string) => {
        if (cached.inactivityTimer) { clearTimeout(cached.inactivityTimer); cached.inactivityTimer = null; }
        if (cached.abortKillTimer) { clearTimeout(cached.abortKillTimer); cached.abortKillTimer = null; }
        cached.resetInactivityTimer = undefined;
        cached.currentSettle = null;
        cached.currentController = null;
        abortController?.signal.removeEventListener('abort', abortHandler);

        if (err) {
          console.error(`[dsh-provider] ACP error:`, err);
          emitCanonicalTurnEvent(controller, { type: 'error', data: err });
          // 真实错误才杀进程；插队中断（正常 cancel 响应）走无 err 路径
          if (cached.alive) {
            cached.alive = false;
            try { cached.child.kill('SIGTERM'); } catch {}
          }
          this.acpCache.delete(sdkSessionId || 'default');
        } else if (cached._textEmitted) {
          // 文本已在流式阶段发出，不重复 emit
        } else if (cached.currentText.trim()) {
          emitCanonicalTurnEvent(controller, { type: 'text', data: cached.currentText.trim() });
        } else {
          // 无文本（纯工具调用/空回复），正常结束
        }
        emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: !!err } });
        emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
        controller.close();
        resolve();
      };

      console.log(`[dsh-provider] ACP prompt id=${promptId} session=${cached.sessionId}`);
      cached.child.stdin!.write(JSON.stringify({
        jsonrpc: '2.0', id: promptId, method: 'session/prompt',
        params: {
          sessionId: cached.sessionId,
          prompt: [{ type: 'text', text: fullPrompt }],
        },
      }) + '\n');

      // 空闲超时：从 prompt 发出起，只要 ACP 持续有输出就不断重置计时器；
      // 连续 timeoutMs 无任何输出才判定卡死。
      const timeoutMs = parseInt(process.env.CTI_DSH_TIMEOUT_MS || '300000', 10); // 默认 5 分钟
      const resetTimer = () => {
        if (cached.inactivityTimer) clearTimeout(cached.inactivityTimer);
        cached.inactivityTimer = setTimeout(() => {
          if (cached.currentSettle) {
            cached.currentSettle(`ACP inactivity timeout: no output for ${timeoutMs / 1000}s`);
          }
        }, timeoutMs);
      };
      cached.resetInactivityTimer = resetTimer;
      resetTimer();
    });
  }

  private startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, cached] of this.acpCache) {
        if (now - cached.lastUsed > DshProvider.IDLE_TIMEOUT_MS) {
          console.log(`[dsh-provider] ACP idle cleanup: ${cached.sessionId}`);
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

export function createDshProvider(): DshProvider {
  return new DshProvider();
}
