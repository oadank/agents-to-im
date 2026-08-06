/**
 * Hermes ACP Client — JSON-RPC 2.0 Client over stdin/stdout
 *
 * 通过 hermes acp 子进程通信，支持流式响应和会话保持
 * 参考 codex/app-server-client.ts 的 ACP 协议实现
 *
 * Hermes ACP 差异：
 * - 启动参数为 ['acp']（而非 Codex 的 ['app-server', ...]）
 * - 不需要 --dangerously-bypass-* 等参数
 * - 不支持 collaborationMode 相关 API
 * - 使用 --accept-hooks 自动批准 shell hooks
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

// 实时日志：绕过 NSSM stdout 缓冲
function rtLog(msg: string): void {
  const DEBUG_LOG = `C:\\D\\opt\\agents-to-im\\debug_realtime_${process.env.CTI_BOT || 'unknown'}.log`;
  try {
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8');
  } catch {}
}

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

export type HermesServerMessage =
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown };

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface InitializeParams {
  protocolVersion: number;
  clientInfo: {
    name: string;
    title: string | null;
    version: string;
  };
  capabilities: {
    experimentalApi: boolean;
  } | null;
}

const CLIENT_INFO = {
  name: 'agents-to-im',
  title: 'Hermes ACP Client',
  version: '0.1.0',
} as const;

function buildInitializeParams(): InitializeParams {
  return {
    protocolVersion: 1,
    clientInfo: CLIENT_INFO,
    capabilities: {
      experimentalApi: true,
    },
  };
}

function resolveHermesHome(): string {
  return process.env.CTI_HERMES_HOME || path.join(os.homedir(), '.hermes');
}

function resolvePidFile(): string {
  const ctiHome = process.env.CTI_HOME;
  if (ctiHome) {
    return path.join(ctiHome, 'runtime', 'hermes-app-server.pid');
  }
  return path.join(resolveHermesHome(), 'runtime', 'hermes-app-server.pid');
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readSavedPid(): number | null {
  const pidFile = resolvePidFile();
  try {
    const content = fs.readFileSync(pidFile, 'utf8').trim();
    const pid = parseInt(content, 10);
    if (pid > 0) return pid;
  } catch {
    // file not found
  }
  return null;
}

function savePid(pid: number): void {
  const pidFile = resolvePidFile();
  const pidDir = path.dirname(pidFile);
  try {
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(pidFile, String(pid));
  } catch (error) {
    console.warn('[hermes-app-server] Failed to save PID file:', error);
  }
}

function jsonRpcError(method: string, error: JsonRpcFailure['error']): Error {
  const detail = typeof error.data === 'string' ? ` (${error.data})` : '';
  return new Error(`[hermes-app-server] ${method} failed: ${error.message}${detail}`);
}

export class HermesAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingCall>();
  private listeners = new Set<(message: HermesServerMessage) => void>();
  private startPromise: Promise<void> | null = null;

  constructor(
    private readonly executable = 'hermes',
    private readonly acpArgs: string[] = ['acp', '--accept-hooks'],
  ) {}

  subscribe(listener: (message: HermesServerMessage) => void): () => void {
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
   * 检查是否需要清空 Hermes thread id（因为 Hermes 进程重启了）
   */
  checkPidChanged(): boolean {
    const savedPid = readSavedPid();
    if (!savedPid) {
      console.log('[hermes-app-server] No saved PID found, will clear stale thread IDs');
      return true;
    }
    if (!isProcessRunning(savedPid)) {
      console.log(`[hermes-app-server] Previous PID ${savedPid} not running, Hermes process restarted`);
      return true;
    }
    return false;
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
      throw new Error('[hermes-app-server] Process not running');
    }
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    this.writePayload(payload);
    return promise;
  }

  private writePayload(payload: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (!this.proc) {
      throw new Error('[hermes-app-server] Process not running');
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
    // 启动 hermes acp
    const args = [...this.acpArgs];
    rtLog(`[hermes-app-server] bootstrap: spawning "${this.executable}" args=${JSON.stringify(args)}`);
    const proc = spawn(this.executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        HOME: os.homedir(),
        HERMES_HOME: resolveHermesHome(),
        USERPROFILE: os.homedir(),
        APPDATA: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-200418',
        OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || 'http://100.110.110.12:4000/v1',
        PYTHONUNBUFFERED: '1',
        // Skip dangerous command approval prompts in ACP mode (no TTY available).
        // _YOLO_MODE_FROZEN is read at import time from this env var.
        HERMES_YOLO_MODE: '1',
      },
      windowsHide: true,
    });
    rtLog(`[hermes-app-server] spawned HERMES_HOME=${resolveHermesHome()} OPENAI_BASE_URL=...:4000`);
    this.proc = proc;

    proc.once('error', (error) => {
      rtLog(`[hermes-app-server] spawn ERROR: ${error.message}`);
      this.failAllPending(error instanceof Error ? error : new Error(String(error)));
    });
    proc.once('exit', (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      rtLog(`[hermes-app-server] process EXIT: ${suffix}`);
      this.failAllPending(new Error(`[hermes-app-server] Process exited with ${suffix}`));
      this.proc = null;
      this.startPromise = null;
    });

    // 捕获原始 stdout 输出到日志（排查 buffering 问题）
    let stderrLog = '';
    proc.stdout.on('data', (chunk) => {
      rtLog(`[hermes-app-server] stdout: received ${chunk.length} bytes`);
    });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      stderrLog += text;
      if (text) {
        rtLog(`[hermes-app-server] stderr: ${text}`);
        console.warn(`[hermes-app-server][stderr] ${text}`);
      }
    });

    // readline 按行解析 ACP 协议
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      rtLog(`[hermes-app-server] stdout LINE: ${line.substring(0, 100)}`);
      this.handleLine(line);
    });

    // 30秒超时：initialize 握手
    rtLog(`[hermes-app-server] calling initialize...`);
    let initDone = false;
    const timeoutId = setTimeout(() => {
      if (!initDone) {
        rtLog(`[hermes-app-server] initialize TIMEOUT (30s), killing process`);
        proc.kill();
      }
    }, 30000);
    await this.callInternal('initialize', buildInitializeParams());
    initDone = true;
    clearTimeout(timeoutId);
    rtLog(`[hermes-app-server] initialize OK`);

    // 保存 Hermes 进程 PID
    if (proc.pid) {
      savePid(proc.pid);
      rtLog(`[hermes-app-server] Started with PID ${proc.pid}`);
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let parsed: JsonRpcNotification | JsonRpcResponse | JsonRpcRequest;
    try {
      parsed = JSON.parse(line) as JsonRpcNotification | JsonRpcResponse | JsonRpcRequest;
    } catch (error) {
      console.warn('[hermes-app-server] Ignoring invalid JSON-RPC frame:', error);
      return;
    }

    // Response to a pending call
    if ('id' in parsed && ('result' in parsed || 'error' in parsed)) {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      if ('error' in parsed) {
        pending.reject(jsonRpcError('response', parsed.error));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    // Notification or server request
    if (typeof parsed.method !== 'string') {
      return;
    }

    const envelope: HermesServerMessage = 'id' in parsed
      ? {
        kind: 'request',
        id: parsed.id,
        method: parsed.method,
        params: parsed.params,
      }
      : {
        kind: 'notification',
        method: parsed.method,
        params: parsed.params,
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
