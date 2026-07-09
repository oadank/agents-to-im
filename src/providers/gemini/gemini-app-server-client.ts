/**
 * Gemini ACP Client — JSON-RPC 2.0 Client over stdin/stdout
 *
 * 通过 gemini --acp 子进程通信，支持流式响应和会话保持
 * 参考 hermes/hermes-app-server-client.ts 的 ACP 协议实现
 *
 * Gemini ACP 差异（相对 Hermes）：
 * - 启动参数为 ['--acp', '--yolo']（而非 Hermes 的 ['acp']）
 * - 使用 Zed 兼容的 initialize 握手（protocolVersion: 1）
 * - authenticate 步骤需要（methodId: 'gateway'）
 * - session/new 支持 mcpServers 参数
 * - 通过 GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL 走 gateway auth 到 LiteLLM
 */

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

export type GeminiServerMessage =
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown };

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: {
    fs: {
      readTextFile: boolean;
      writeTextFile: boolean;
    };
  };
}

function buildInitializeParams(): InitializeParams {
  return {
    protocolVersion: 1,
    clientCapabilities: {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    },
  };
}

function resolveGeminiHome(): string {
  return process.env.CTI_GEMINI_HOME || path.join(os.homedir(), '.gemini');
}

/**
 * PID 文件路径，用于检测 Gemini 进程是否重启
 */
function resolvePidFile(): string {
  const ctiHome = process.env.CTI_HOME;
  if (ctiHome) {
    return path.join(ctiHome, 'runtime', 'gemini-app-server.pid');
  }
  return path.join(resolveGeminiHome(), 'runtime', 'gemini-app-server.pid');
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
    console.warn('[gemini-app-server] Failed to save PID file:', error);
  }
}

function jsonRpcError(method: string, error: JsonRpcFailure['error']): Error {
  const detail = typeof error.data === 'string' ? ` (${error.data})` : '';
  return new Error(`[gemini-app-server] ${method} failed: ${error.message}${detail}`);
}

export interface GeminiAppServerOptions {
  executable?: string;
  acpArgs?: string[];
  apiKey?: string;
  baseUrl?: string;
  extraEnv?: Record<string, string>;
}

export class GeminiAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingCall>();
  private listeners = new Set<(message: GeminiServerMessage) => void>();
  private startPromise: Promise<void> | null = null;
  private readonly executable: string;
  private readonly acpArgs: string[];
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly extraEnv: Record<string, string>;

  constructor(options: GeminiAppServerOptions = {}) {
    this.executable = options.executable || 'gemini';
    this.acpArgs = options.acpArgs || ['--acp', '--yolo'];
    this.apiKey = options.apiKey || process.env.CTI_GEMINI_API_KEY || process.env.LITELLM_API_KEY || 'sk-200418';
    this.baseUrl = options.baseUrl || process.env.CTI_GEMINI_BASE_URL || 'http://127.0.0.1:4000';
    this.extraEnv = options.extraEnv || {};
  }

  subscribe(listener: (message: GeminiServerMessage) => void): () => void {
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
   * 检查是否需要清空 Gemini session id（因为 Gemini 进程重启了）
   */
  checkPidChanged(): boolean {
    const savedPid = readSavedPid();
    if (!savedPid) {
      console.log('[gemini-app-server] No saved PID found, will clear stale session IDs');
      return true;
    }
    if (!isProcessRunning(savedPid)) {
      console.log(`[gemini-app-server] Previous PID ${savedPid} not running, Gemini process restarted`);
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
      throw new Error('[gemini-app-server] Process not running');
    }
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    this.writePayload(payload);
    return promise;
  }

  private writePayload(payload: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (!this.proc) {
      throw new Error('[gemini-app-server] Process not running');
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
    // 启动 gemini --acp --yolo
    const args = [...this.acpArgs];
    const proc = spawn(this.executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: os.homedir(),
        GEMINI_HOME: resolveGeminiHome(),
        GEMINI_API_KEY: this.apiKey,
        GOOGLE_GEMINI_BASE_URL: this.baseUrl,
        ...this.extraEnv,
      },
    });
    this.proc = proc;

    proc.once('error', (error) => {
      this.failAllPending(error instanceof Error ? error : new Error(String(error)));
    });
    proc.once('exit', (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.failAllPending(new Error(`[gemini-app-server] Process exited with ${suffix}`));
      this.proc = null;
      this.startPromise = null;
    });

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      this.handleLine(line);
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text && !text.includes('YOLO mode is enabled') && !text.includes('MCP issues detected')) {
        console.warn(`[gemini-app-server][stderr] ${text}`);
      }
    });

    // 握手：initialize
    await this.callInternal('initialize', buildInitializeParams());

    // authenticate with gateway method
    try {
      await this.callInternal('authenticate', { methodId: 'gateway' });
    } catch (error) {
      console.warn('[gemini-app-server] authenticate failed:', error);
      // 有些认证方法会返回错误但仍可继续，不阻塞
    }

    // 保存 Gemini 进程 PID
    if (proc.pid) {
      savePid(proc.pid);
      console.log(`[gemini-app-server] Started with PID ${proc.pid}`);
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let parsed: JsonRpcNotification | JsonRpcResponse | JsonRpcRequest;
    try {
      parsed = JSON.parse(line) as JsonRpcNotification | JsonRpcResponse | JsonRpcRequest;
    } catch (error) {
      console.warn('[gemini-app-server] Ignoring invalid JSON-RPC frame:', error);
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

    const envelope: GeminiServerMessage = 'id' in parsed
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
