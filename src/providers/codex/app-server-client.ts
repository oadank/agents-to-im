import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

type JsonRpcId = number | string;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export type CodexServerMessage =
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown };

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface CollaborationModeEntry {
  mode?: string;
  kind?: string;
  id?: string;
}

function extractCollaborationModes(result: unknown): CollaborationModeEntry[] {
  if (Array.isArray(result)) {
    return result as CollaborationModeEntry[];
  }
  if (typeof result !== 'object' || !result) {
    return [];
  }
  const record = result as {
    data?: CollaborationModeEntry[];
    modes?: CollaborationModeEntry[];
    items?: CollaborationModeEntry[];
  };
  if (Array.isArray(record.data)) {
    return record.data;
  }
  if (Array.isArray(record.modes)) {
    return record.modes;
  }
  if (Array.isArray(record.items)) {
    return record.items;
  }
  return [];
}

interface InitializeParams {
  clientInfo: {
    name: string;
    title: string | null;
    version: string;
  };
  capabilities: {
    experimentalApi: boolean;
    optOutNotificationMethods?: string[] | null;
  } | null;
}

const CLIENT_INFO = {
  name: 'agents-to-im',
  title: 'Agents to IM',
  version: '0.1.0',
} as const;

export function buildInitializeParams(): InitializeParams {
  return {
    clientInfo: CLIENT_INFO,
    capabilities: {
      experimentalApi: true,
    },
  };
}

export function buildInitializedNotification(): JsonRpcNotification {
  return {
    jsonrpc: '2.0',
    method: 'initialized',
  };
}

export { extractCollaborationModes };

function resolveCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * PID 文件路径，用于检测 Codex 进程是否重启
 * 保存在 CTI_HOME 目录下的 runtime 子目录
 */
function resolvePidFile(): string {
  const ctiHome = process.env.CTI_HOME;
  if (ctiHome) {
    return path.join(ctiHome, 'runtime', 'codex-app-server.pid');
  }
  // 默认路径
  return path.join(resolveCodexHome(), 'runtime', 'codex-app-server.pid');
}

/**
 * 检查指定 PID 的进程是否还在运行
 */
function isProcessRunning(pid: number): boolean {
  try {
    // 发送信号 0 检查进程是否存在（不会实际杀死进程）
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取之前保存的 PID
 */
function readSavedPid(): number | null {
  const pidFile = resolvePidFile();
  try {
    const content = fs.readFileSync(pidFile, 'utf8').trim();
    const pid = parseInt(content, 10);
    if (pid > 0) return pid;
  } catch {
    // 文件不存在或读取失败
  }
  return null;
}

/**
 * 保存当前 PID 到文件
 */
function savePid(pid: number): void {
  const pidFile = resolvePidFile();
  const pidDir = path.dirname(pidFile);
  try {
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(pidFile, String(pid));
  } catch (error) {
    console.warn('[codex-app-server] Failed to save PID file:', error);
  }
}

function jsonRpcError(method: string, error: JsonRpcFailure['error']): Error {
  const detail = typeof error.data === 'string' ? ` (${error.data})` : '';
  return new Error(`[codex-app-server] ${method} failed: ${error.message}${detail}`);
}

export class CodexAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingCall>();
  private listeners = new Set<(message: CodexServerMessage) => void>();
  private startPromise: Promise<void> | null = null;
  private capabilities = {
    collaborationModes: new Set<string>(),
  };

  constructor(private readonly executable = 'codex') {}

  subscribe(listener: (message: CodexServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async prepare(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.bootstrap();
    try {
      await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw error;
    }
  }

  /**
   * 检查是否需要清空 codexThreadId（因为 Codex 进程重启了）
   * 在 prepare() 之前调用，如果返回 true，需要清空所有 thread id
   */
  checkPidChanged(): boolean {
    const savedPid = readSavedPid();
    if (!savedPid) {
      // 没有保存的 PID，说明是首次启动或 PID 文件丢失
      // 需要清空所有 thread id，防止旧 thread id 残留
      console.log('[codex-app-server] No saved PID found, will clear stale thread IDs');
      return true;
    }
    // 检查保存的 PID 是否还在运行
    if (!isProcessRunning(savedPid)) {
      console.log(`[codex-app-server] Previous PID ${savedPid} not running, Codex process restarted`);
      return true;
    }
    return false;
  }

  supportsCollaborationMode(mode: string): boolean {
    return this.capabilities.collaborationModes.has(mode);
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    await this.prepare();
    return this.callInternal<T>(method, params);
  }

  private async callInternal<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const proc = this.proc;
    if (!proc) {
      throw new Error('[codex-app-server] Process not running');
    }
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    this.writePayload(payload);
    return promise;
  }

  private writePayload(payload: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (!this.proc) {
      throw new Error('[codex-app-server] Process not running');
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    await this.prepare();
    this.writePayload({ jsonrpc: '2.0', id, result });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.prepare();
    this.writePayload({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  async respondError(id: JsonRpcId, code: number, message: string, data?: unknown): Promise<void> {
    await this.prepare();
    this.writePayload({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this.startPromise = null;
    proc.kill();
  }

  private async bootstrap(): Promise<void> {
    // 启动 codex app-server 时自动添加 bypass 参数，跳过权限审批
    // 这样飞书调用时不会频繁申请权限审批
    const proc = spawn(this.executable, [
      'app-server',
      '-c', 'dangerously_bypass_approvals_and_sandbox=true',
      '-c', 'require_confirmation=false',
      '-c', 'approval_policy=never',
      '-c', 'sandbox_mode=danger-full-access',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: os.homedir(),
        CODEX_HOME: resolveCodexHome(),
      },
    });
    this.proc = proc;

    proc.once('error', (error) => {
      this.failAllPending(error instanceof Error ? error : new Error(String(error)));
    });
    proc.once('exit', (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.failAllPending(new Error(`[codex-app-server] Process exited with ${suffix}`));
      this.proc = null;
      this.startPromise = null;
    });

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      this.handleLine(line);
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        console.warn(`[codex-app-server][stderr] ${text}`);
      }
    });

    await this.callInternal('initialize', buildInitializeParams());
    this.writePayload(buildInitializedNotification());

    let modes: CollaborationModeEntry[] = [];
    try {
      const result = await this.callInternal<unknown>('collaborationMode/list', {});
      modes = extractCollaborationModes(result);
    } catch (error) {
      console.warn('[codex-app-server] Failed to list collaboration modes:', error);
    }

    this.capabilities.collaborationModes.clear();
    for (const entry of modes) {
      const mode = entry.mode || entry.kind || entry.id;
      if (typeof mode === 'string' && mode) {
        this.capabilities.collaborationModes.add(mode);
      }
    }

    // 保存 Codex 进程 PID，用于后续检测进程是否重启
    if (proc.pid) {
      savePid(proc.pid);
      console.log(`[codex-app-server] Started with PID ${proc.pid}`);
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let message: JsonRpcNotification | JsonRpcResponse | JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcNotification | JsonRpcResponse | JsonRpcRequest;
    } catch (error) {
      console.warn('[codex-app-server] Ignoring invalid JSON-RPC frame:', error);
      return;
    }

    if ('id' in message && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if ('error' in message) {
        pending.reject(jsonRpcError('response', message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== 'string') {
      return;
    }

    const envelope: CodexServerMessage = 'id' in message
      ? {
        kind: 'request',
        id: message.id,
        method: message.method,
        params: message.params,
      }
      : {
        kind: 'notification',
        method: message.method,
        params: message.params,
      };

    for (const listener of this.listeners) {
      listener(envelope);
    }
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
