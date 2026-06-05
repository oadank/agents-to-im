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

const AGENT_CLI: Record<AgentName, AgentCliConfig> = {
  glm: {
    // GLM 使用 ACP 协议（需要 'acp' 位置参数触发 ACP 模式）
    bin: 'zcode-acp',
    args: () => ['acp'],
    json: false,   // 使用自定义 ACP 协议处理
    useSandboxCwd: false,
  },
  gemini: {
    // gemini.js 通过 mimo-gemini-proxy 格式转换层连接 MiMo
    // proxy 将 Google API 格式 (generateContent) 转为 OpenAI 格式 (chat/completions)
    bin: 'node',
    args: (msg) => ['/opt/zcode/resources/gemini/gemini.js', '-p', msg, '--output-format', 'text'],
    json: false,
    useSandboxCwd: true,
  },
  opencode: {
    bin: '/opt/zcode/resources/opencode/opencode',
    args: (msg) => ['run', msg],
    json: false,
    useSandboxCwd: true,
  },
};

/**
 * 加载 ZCode 记忆文件（/root/.zcode/memory/MEMORY.md + 关键文件）
 */
function loadZCodeMemory(): string {
  const memDir = '/root/.zcode/memory';
  const lines: string[] = [];
  try {
    const memFile = path.join(memDir, 'MEMORY.md');
    if (fs.existsSync(memFile)) {
      lines.push(fs.readFileSync(memFile, 'utf8'));
    }
    for (const f of ['user_identity.md', 'user_profile.md', 'feedback_behavior_rules.md']) {
      const fp = path.join(memDir, f);
      if (fs.existsSync(fp)) {
        lines.push(`\n=== ${f} ===\n` + fs.readFileSync(fp, 'utf8'));
      }
    }
  } catch {}
  return lines.join('\n').trim();
}

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

    // 构建带历史的 prompt
    const history = params.conversationHistory;
    let enrichedPrompt = prompt;
    if (history && history.length > 0) {
      const historyText = history.map(m =>
        `${m.role === 'user' ? '用户' : '助手'}：${m.content}`
      ).join('\n');
      enrichedPrompt = `以下是之前的对话上下文：\n${historyText}\n\n---\n\n用户当前消息：${prompt}`;
    }

    // GLM 走 ACP 协议，独立处理
    if (agent === 'glm') {
      return this.runGlmAcp(controller, { ...params, prompt: enrichedPrompt });
    }

    const agentCli = AGENT_CLI[agent];

    // 构建 CLI 参数
    const args = agentCli.args(enrichedPrompt);

    // 确定工作目录：gemini/opencode 使用 ZCode 沙箱目录（含 MiMo 认证）
    let cwd = workingDirectory || process.cwd();
    if (agentCli.useSandboxCwd) {
      const sandbox = findSandboxDir(agent);
      if (sandbox) {
        cwd = sandbox;
        console.log(`[zcode-provider] Using sandbox cwd: ${sandbox}`);
      } else {
        console.warn(`[zcode-provider] No sandbox found for ${agent}, using default cwd`);
      }
    }

    // 环境变量：从 systemd 继承，zcode-acp 用 OPENAI_API_KEY，gemini/opencode 用沙箱配置
    const env: NodeJS.ProcessEnv = { ...process.env };

    // gemini: 通过 mimo-gemini-proxy 格式转换层连接 MiMo
    if (agent === 'gemini') {
      env.GOOGLE_GEMINI_BASE_URL = 'http://127.0.0.1:8901';
      env.GEMINI_API_KEY = 'proxy-passthrough';  // 只需通过验证，实际请求由 proxy 处理
    }

    // 发送初始状态
    emitCanonicalTurnEvent(controller, {
      type: 'status',
      data: { session_id: sdkSessionId || '', agent },
    });

    const bin = typeof agentCli.bin === 'function' ? agentCli.bin(agent) : agentCli.bin;
    console.log(`[zcode-provider] Spawning ${bin} with args:`, args.slice(0, 4), `cwd=${cwd}`);

    // 启动子进程
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 处理 abort
    const abortHandler = () => { child.kill('SIGTERM'); };
    abortController?.signal.addEventListener('abort', abortHandler, { once: true });

    let stdout = '';
    let stderr = '';
    let gotOutput = false;

    // 关闭 stdin — 非 JSON agent (opencode/gemini.js) 会等待 EOF 才处理 prompt
    child.stdin.end();

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      gotOutput = true;
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    // JSON agent (zcode-acp) 120s 超时；非 JSON agent 60s + 输出后 3s kill
    const agentTimeout = agentCli.json ? 120_000 : 60_000;
    const killTimer = setTimeout(() => {
      if (!child.killed) {
        console.log(`[zcode-provider] ${bin} timeout after ${agentTimeout}ms, killing`);
        child.kill('SIGTERM');
      }
    }, agentTimeout);

    let outputKillTimer: NodeJS.Timeout | null = null;
    if (!agentCli.json) {
      outputKillTimer = setInterval(() => {
        if (gotOutput && !child.killed) {
          console.log(`[zcode-provider] ${bin} got output, killing after 3s`);
          setTimeout(() => { if (!child.killed) child.kill('SIGTERM'); }, 3000);
          if (outputKillTimer) clearInterval(outputKillTimer);
        }
      }, 500);
    }

    await new Promise<void>((resolve) => {
      child.on('close', (code) => {
        abortController?.signal.removeEventListener('abort', abortHandler);
        clearTimeout(killTimer);
        if (outputKillTimer) clearInterval(outputKillTimer);

        console.log(`[zcode-provider] ${bin} exited with code ${code}, stdout length=${stdout.length}, stderr length=${stderr.length}`);

        try {
          if (code !== 0 && code !== null && !stdout.trim()) {
            console.error(`[zcode-provider] Error:`, stderr || `exit code ${code}`);
            emitCanonicalTurnEvent(controller, {
              type: 'error',
              data: stderr || `${bin} exited with code ${code}`,
            });
            emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
            controller.close();
            resolve();
            return;
          }

          if (agentCli.json) {
            this.handleJsonOutput(controller, stdout, sdkSessionId);
          } else {
            this.handleTextOutput(controller, stdout, sdkSessionId);
          }

          emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          emitCanonicalTurnEvent(controller, { type: 'error', data: message });
          emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
          controller.close();
        }
        resolve();
      });

      child.on('error', (error) => {
        abortController?.signal.removeEventListener('abort', abortHandler);
        console.error(`[zcode-provider] Spawn error:`, error.message);
        emitCanonicalTurnEvent(controller, {
          type: 'error',
          data: `Failed to spawn ${bin}: ${error.message}`,
        });
        emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
        controller.close();
        resolve();
      });
    });
  }

  /**
   * GLM agent: 通过 ACP 协议与 zcode-acp 交互
   * 流程: initialize → session/new → session/prompt → 解析 response
   */
  private async runGlmAcp(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
  ): Promise<void> {
    const { prompt, sdkSessionId, abortController } = params;
    const child = spawn('zcode-acp', ['acp'], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const abortHandler = () => { child.kill('SIGTERM'); };
    abortController?.signal.addEventListener('abort', abortHandler, { once: true });

    emitCanonicalTurnEvent(controller, {
      type: 'status',
      data: { session_id: sdkSessionId || '', agent: 'glm' },
    });

    // 立即发送 initialize — binary 等这个才开始响应
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: 1,
        capabilities: {},
        clientInfo: { name: 'feishu-zcode', version: '1.0' },
      },
    }) + '\n');

    // 收集 ACP 响应
    let lineBuf = '';
    let responseText = '';
    let initResult: Record<string, unknown> | null = null;
    let sessionId: string | null = null;
    let settled = false;

    const settle = (err?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      abortController?.signal.removeEventListener('abort', abortHandler);

      if (err) {
        console.error(`[zcode-provider] GLM ACP error:`, err);
        emitCanonicalTurnEvent(controller, { type: 'error', data: err });
      } else if (responseText.trim()) {
        emitCanonicalTurnEvent(controller, { type: 'text', data: responseText.trim() });
      } else {
        emitCanonicalTurnEvent(controller, { type: 'error', data: 'Empty response from zcode agent' });
      }
      emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: !!err } });
      emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
      controller.close();
      try { child.kill('SIGTERM'); } catch {}
    };

    const timeout = setTimeout(() => settle('GLM ACP timeout after 120s'), 120_000);

    // 解析 JSON-RPC 行
    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      try {
        const msg = JSON.parse(trimmed);
        const id = msg.id as number | undefined;
        console.log(`[zcode-provider] GLM ACP recv: id=${id} method=${msg.method || '-'} hasResult=${!!msg.result} hasError=${!!msg.error}`);

        // initialize 响应
        if (id === 1 && msg.result) {
          initResult = msg.result as Record<string, unknown>;
          console.log(`[zcode-provider] GLM ACP initialized:`, JSON.stringify((msg.result as Record<string, unknown>).agentInfo));
          // → session/new（附带 agentmemory MCP）
          child.stdin.write(JSON.stringify({
            jsonrpc: '2.0', id: 2, method: 'session/new',
            params: {
              cwd: process.cwd(),
              mcpServers: [
                {
                  type: 'stdio' as const,
                  name: 'agentmemory',
                  command: 'npx',
                  args: ['-y', '@agentmemory/mcp'],
                  env: [
                    { name: 'AGENTMEMORY_URL', value: 'http://127.0.0.1:3111' },
                    { name: 'AGENTMEMORY_TOOLS', value: 'memory_recall,memory_save,memory_smart_search' },
                  ],
                },
              ],
            },
          }) + '\n');
          return;
        }

        // session/new 响应
        if (id === 2 && msg.result) {
          const r = msg.result as Record<string, unknown>;
          sessionId = r.sessionId as string;
          console.log(`[zcode-provider] GLM ACP session: ${sessionId}`);

          // 注入 ZCode 记忆到 prompt
          const memoryContent = loadZCodeMemory();
          const fullPrompt = memoryContent
            ? `${memoryContent}\n\n---\n\n用户消息：${prompt}`
            : prompt;

          // → session/prompt
          child.stdin.write(JSON.stringify({
            jsonrpc: '2.0', id: 3, method: 'session/prompt',
            params: {
              sessionId,
              prompt: [{ type: 'text', text: fullPrompt }],
            },
          }) + '\n');
          return;
        }

        // session/prompt 响应 — 检查 error 或 stopReason
        if (id === 3) {
          if (msg.error) {
            settle(`GLM prompt error: ${msg.error.message || JSON.stringify(msg.error)}`);
            return;
          }
          if (msg.result?.stopReason) {
            console.log(`[zcode-provider] GLM ACP prompt done, stopReason=${msg.result.stopReason}`);
            settle();
            return;
          }
          return;
        }

        // 通知: agent_message_chunk → 提取文本
        if (msg.method === 'session/update') {
          const update = msg.params?.update;
          if (update?.sessionUpdate === 'agent_message_chunk' && update?.content?.type === 'text') {
            responseText += update.content.text;
            console.log(`[zcode-provider] GLM ACP text chunk: "${update.content.text}" total=${responseText.length}`);
          }
        }

        // 权限请求: 自动批准（bypass 模式）
        if (msg.method === 'session/request_permission') {
          const reqId = msg.id ?? msg.params?.requestId;
          console.log(`[zcode-provider] GLM ACP permission request, auto-approving id=${reqId}`);
          child.stdin.write(JSON.stringify({
            jsonrpc: '2.0', id: reqId ?? Date.now(),
            result: { outcome: { outcome: 'selected', optionId: 'allow_always' } },
          }) + '\n');
        }
      } catch {}
    };

    child.stdout.on('data', (chunk: Buffer) => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() || '';
      for (const line of lines) processLine(line);
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      console.log(`[zcode-provider] GLM ACP exited code=${code} stdout=${responseText.length}b`);
      if (!settled) settle(stderr || `GLM ACP exited with code ${code}`);
    });

    child.on('error', (err) => {
      if (!settled) settle(`GLM ACP spawn error: ${err.message}`);
    });
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
