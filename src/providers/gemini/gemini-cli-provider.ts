/**
 * Gemini CLI Provider — 使用 gemini CLI 的 -p 参数
 *
 * 通过 `gemini -p <prompt>` 直接调用 Gemini CLI，
 * 获得完整的 Gemini CLI 能力：
 * - 内置工具（Read/Write/Bash/Glob 等）
 * - MCP 服务器支持
 * - 原生记忆系统
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { LLMProvider, StreamChatParams } from '../../bridge/host.js';
import { emitCanonicalTurnEvent } from '../../infra/sse-utils.js';

// ── 记忆注入 ──

function loadMemoryContent(agentName?: string): string {
  const parts: string[] = [];
  const memBase = '/opt/agents-memory';
  const agent = agentName || 'gemini';

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
  if (memory) console.log(`[gemini-cli-provider] Memory loaded (${memory.length} chars, agent=${agentName || 'gemini'})`);
  else console.log('[gemini-cli-provider] No memory loaded');
  return memory;
}

// ── GeminiCliProvider ──

export class GeminiCliProvider implements LLMProvider {

  constructor() {}

  async prepare(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn('gemini', ['--version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.on('close', (code) => {
        code === 0 ? resolve() : reject(new Error('gemini CLI not available'));
      });
      child.on('error', (error) => {
        reject(new Error(`Failed to spawn gemini: ${error.message}`));
      });
    });
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;
    return new ReadableStream<string>({
      start(controller) {
        void self.runPrompt(controller, params);
      },
    });
  }

  /**
   * 使用 gemini -p 参数直接调用
   */
  private async runPrompt(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
  ): Promise<void> {
    const { prompt, sdkSessionId, conversationHistory } = params;

    // Inject memory content
    const memory = getMemoryContent(process.env.CTI_AGENT_NAME);
    let enrichedPrompt = prompt;
    if (memory) {
      enrichedPrompt = `${memory}\n\n---\n\n${prompt}`;
    }

    // Inject conversation history
    if (conversationHistory && conversationHistory.length > 0) {
      const recent = conversationHistory.slice(-20);
      const historyText = recent.map(m => `[${m.role}]: ${m.content}`).join('\n');
      enrichedPrompt = `以下是之前的对话记录：\n${historyText}\n\n---\n\n用户: ${enrichedPrompt}`;
    }

    const cwd = params.workingDirectory || process.cwd();
    const env: NodeJS.ProcessEnv = { ...process.env };

    // 设置 Gemini API 配置（通过 mimo-gemini-proxy）
    env.GOOGLE_GEMINI_BASE_URL = process.env.CTI_GEMINI_BASE_URL || 'http://127.0.0.1:8901';
    env.GEMINI_API_KEY = process.env.CTI_GEMINI_API_KEY || 'proxy-passthrough';
    env.GEMINI_CLI_TRUST_WORKSPACE = 'true';

    console.log(`[gemini-cli-provider] Spawn: bin=gemini cwd=${cwd}`);

    const child = spawn('gemini', ['-p', enrichedPrompt], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    emitCanonicalTurnEvent(controller, { type: 'status', data: { session_id: sdkSessionId || '' } });

    let textContent = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      textContent += text;
      emitCanonicalTurnEvent(controller, { type: 'text', data: text });
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      // Only log significant errors, not debug output
      if (text.includes('Error') || text.includes('error')) {
        console.error(`[gemini-cli-provider] stderr: ${text}`);
      }
    });

    child.on('close', (code) => {
      console.log(`[gemini-cli-provider] Process exited code=${code} output=${textContent.length} chars`);
      if (code === 0) {
        emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: false } });
      } else {
        const errMsg = `gemini process exited with code ${code}`;
        emitCanonicalTurnEvent(controller, { type: 'error', data: errMsg });
        emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: true } });
      }
      emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
      controller.close();
    });

    child.on('error', (err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[gemini-cli-provider] Spawn error: ${errMsg}`);
      emitCanonicalTurnEvent(controller, { type: 'error', data: errMsg });
      emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: true } });
      emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
      controller.close();
    });
  }
}

export function createGeminiCliProvider(): GeminiCliProvider {
  return new GeminiCliProvider();
}
