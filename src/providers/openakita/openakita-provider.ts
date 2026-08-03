/**
 * OpenAkita Provider — CLI 单任务模式桥接
 *
 * 调用 openakita.exe run "<task>" 执行单次任务，解析其 NDJSON 事件流输出。
 * 复用 C:\D\opt\openakita\multica-wrapper\openakita_wrapper.py 的调用逻辑。
 *
 * OpenAkita 交互模式有 asyncio 事件循环 bug（Executor shutdown），
 * 因此这里只用 run 单任务模式，由 agents-to-im 负责会话管理和消息桥接。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LLMProvider, StreamChatParams } from '../../bridge/host.js';
import { emitCanonicalTurnEvent } from '../../infra/sse-utils.js';
import { LARK_CLI_INSTRUCTIONS } from '../../config/runtime-configs.js';

/** 实时调试日志 */
const DEBUG_LOG = `C:\\D\\opt\\agents-to-im\\debug_realtime_openakita.log`;
function rtLog(msg: string): void {
  const time = new Date().toISOString();
  try {
    fs.appendFileSync(DEBUG_LOG, `[${time}] ${msg}\n`, 'utf-8');
  } catch {}
}

export interface OpenAkitaConfig {
  executable?: string;
  workspace?: string;
}

/** OpenAkita 可执行文件路径 */
function resolveExecutable(): string {
  return (
    process.env.CTI_OPENAKITA_EXE ||
    'C:\\D\\opt\\openakita\\venv\\Scripts\\openakita.exe'
  );
}

/** OpenAkita workspace 目录 */
function resolveWorkspace(): string {
  return (
    process.env.CTI_OPENAKITA_WORKSPACE ||
    'C:\\Users\\oadan\\.openakita\\workspaces\\default'
  );
}

interface OpenAkitaNdjsonEvent {
  type?: string;
  sessionID?: string;
  part?: {
    id?: string;
    type?: string;
    text?: string;
    delta?: string;
  };
  properties?: {
    part?: {
      id?: string;
      sessionID?: string;
      messageID?: string;
      type?: string;
      text?: string;
    };
    delta?: string;
    status?: { type?: string };
    info?: { id?: string };
  };
  delta?: string;
}

export class OpenAkitaProvider implements LLMProvider {
  private executable: string;
  private workspace: string;

  constructor(config?: OpenAkitaConfig) {
    this.executable = config?.executable || resolveExecutable();
    this.workspace = config?.workspace || resolveWorkspace();
  }

  async prepare(): Promise<void> {
    if (!fs.existsSync(this.executable)) {
      throw new Error(`OpenAkita executable not found: ${this.executable}`);
    }
    if (!fs.existsSync(this.workspace)) {
      rtLog(`[openakita-provider] prepare: workspace missing, creating ${this.workspace}`);
      fs.mkdirSync(this.workspace, { recursive: true });
    }
    rtLog(`[openakita-provider] prepare OK: exe=${this.executable}`);
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;
    return new ReadableStream<string>({
      async start(controller) {
        try {
          await self.runTask(controller, params);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error('[openakita-provider] streamChat error:', e);
          rtLog(`[openakita-provider] streamChat CAUGHT ERROR: ${message}`);
          emitCanonicalTurnEvent(controller, { type: 'error', data: message });
          emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
          controller.close();
        }
      },
    });
  }

  /** 执行一次 OpenAkita run 任务 */
  private runTask(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
  ): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      // 构造任务 prompt：注入 lark-cli 指令 + 用户消息
      const userPrompt = params.prompt || '';
      const task = `${LARK_CLI_INSTRUCTIONS}\n\n用户消息：\n${userPrompt}`;

      const rawCwd = params.workingDirectory || process.cwd();
      const cwd = process.platform === 'win32' && !fs.existsSync(rawCwd)
        ? (process.env.USERPROFILE || 'C:\\Users\\oadan')
        : rawCwd;

      rtLog(`[openakita-provider] runTask: exe=${this.executable} cwd=${cwd}`);
      rtLog(`[openakita-provider] task length=${task.length}`);
      this.thinkingLines = [];

      // 构造命令参数，复用 wrapper 的调用方式
      const args = ['--auto-confirm'];
      if (cwd && fs.existsSync(cwd)) {
        args.push('--cwd', cwd);
      }
      args.push('run', task);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        OPENAKITA_WORKSPACE: this.workspace,
      };

      const child = spawn(this.executable, args, {
        cwd: this.workspace,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      });

      let settled = false;
      let stdoutBuf = '';
      let stderrBuf = '';
      let lineBuf = '';
      let sessionStarted = false;

      const settle = (err?: string) => {
        if (settled) return;
        settled = true;
        if (err) {
          rejectPromise(new Error(err));
        } else {
          resolvePromise();
        }
      };

      // 处理 OpenAkita 的 NDJSON / 混合输出
      const handleChunk = (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        stdoutBuf += text;
        lineBuf += text;

        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          // 尝试解析 NDJSON
          if (line.startsWith('{')) {
            try {
              const evt = JSON.parse(line) as OpenAkitaNdjsonEvent;
              this.handleNdjsonEvent(evt, controller, () => {
                sessionStarted = true;
              });
              continue;
            } catch {
              // 不是 JSON，按普通行处理
            }
          }

          // 日志行：优先解析 ReAct/IntentTag/Brain 等思考与工具痕迹
          const isLogLine = line.startsWith('2026-') || line.includes(' - INFO - ') || line.includes(' - ERROR - ') || line.includes(' - WARNING - ');
          if (isLogLine) {
            if (this.handleReActLogLine(line, controller)) continue;
            continue;
          }
          if (line.startsWith('┌') || line.startsWith('└') || line.startsWith('│') || line.startsWith('─')) {
            continue;
          }
          if (/^\d{4}-\d{2}-\d{2}/.test(line)) continue;
          if (line.startsWith('Traceback') || line.startsWith('  File') || line.startsWith('RuntimeError')) continue;

          // 解析思考过程（IntentTag / ReAct 决策 / text_preview）
          this.handleThinkingLine(line, controller);
        }
      };

      child.stdout!.on('data', handleChunk);

      child.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        stderrBuf += text;
        rtLog(`[openakita-provider] stderr: ${text.slice(0, 300)}`);
      });

      child.on('error', (err) => {
        rtLog(`[openakita-provider] spawn ERROR: ${err.message}`);
        settle(`Failed to spawn openakita: ${err.message}`);
      });

      child.on('close', (code) => {
        rtLog(`[openakita-provider] process closed, code=${code}`);
        // 完整记录 stdout（尾部 8000 字符）用于分析 thinking/tool/回复格式
        if (stdoutBuf.trim()) {
          const tail = stdoutBuf.length > 8000 ? stdoutBuf.slice(-8000) : stdoutBuf;
          rtLog(`[openakita-provider] STDOUT TAIL (${stdoutBuf.length} chars): ${tail}`);
        }
        if (stderrBuf.trim()) {
          rtLog(`[openakita-provider] STDERR TAIL: ${stderrBuf.slice(-1500)}`);
        }
        // 兜底：从 stdout 提取最终回复文本
        if (!sessionStarted && stdoutBuf.trim()) {
          const extracted = this.extractFallbackText(stdoutBuf);
          if (extracted) {
            emitCanonicalTurnEvent(controller, {
              type: 'text',
              data: extracted,
            });
          }
        }
        if (code !== 0) {
          const errMsg = stderrBuf.trim().slice(-500) || `openakita exited with code ${code}`;
          settle(errMsg);
        } else {
          settle();
        }
      });

      // 超时保护（OpenAkita 任务可能很长，默认 20 分钟）
      const timeoutMs = parseInt(process.env.CTI_OPENAKITA_TIMEOUT_MS || '1200000', 10);
      const timeout = setTimeout(() => {
        rtLog(`[openakita-provider] task TIMEOUT after ${timeoutMs}ms, killing`);
        try { child.kill('SIGTERM'); } catch {}
        settle(`OpenAkita task timed out after ${timeoutMs / 1000}s`);
      }, timeoutMs);

      params.abortController?.signal.addEventListener('abort', () => {
        rtLog(`[openakita-provider] abort requested, killing process`);
        try { child.kill('SIGTERM'); } catch {}
        emitCanonicalTurnEvent(controller, { type: 'error', data: 'aborted by user' });
        emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
        settle();
      });
    });
  }

  /** 解析 OpenAkita 日志行中的 ReAct 推理 / IntentTag 意图 / 工具调用痕迹 */
  private handleReActLogLine(
    line: string,
    controller: ReadableStreamDefaultController<string>,
  ): boolean {
    // [ReAct-Stream] Iter N — decision=X, tools=[...], tokens_in=..., tokens_out=...
    const reactMatch = line.match(/\[ReAct-Stream\]\s*Iter\s+(\d+)\s*[—\-–]\s*decision=([^,]+),\s*tools=\[([^\]]*)\]/);
    if (reactMatch) {
      const iter = reactMatch[1];
      const decision = reactMatch[2].trim();
      const tools = reactMatch[3].trim();
      let thought = `第 ${iter} 轮推理`;
      if (decision === 'final_answer') {
        thought += '：已得出结论，准备回复';
      } else if (decision) {
        thought += `：决策=${decision}`;
      }
      if (tools) {
        thought += `，调用工具 [${tools}]`;
        // 工具调用事件：先 running（加入工具列表）再 completed（标记完成）
        const toolNames = tools.split(',').map((t) => t.trim()).filter(Boolean);
        for (const toolName of toolNames) {
          const toolUseId = `openakita:${iter}:${toolName}`;
          emitCanonicalTurnEvent(controller, {
            type: 'activity_event',
            data: JSON.stringify({
              kind: 'tool_activity',
              toolUseId,
              toolName,
              status: 'running',
              inputPreview: `第 ${iter} 轮调用`,
              source: 'openakita',
            }),
          });
          emitCanonicalTurnEvent(controller, {
            type: 'activity_event',
            data: JSON.stringify({
              kind: 'tool_activity',
              toolUseId,
              toolName,
              status: 'completed',
              source: 'openakita',
            }),
          });
        }
      }
      this.emitReasoning(thought, controller);
      return true;
    }

    // [IntentTag] intent=..., has_tool_calls=..., tools_executed_in_task=..., text_preview="..."
    const intentMatch = line.match(/\[IntentTag\]\s*intent=([^,]+),\s*has_tool_calls=([^,]+)/);
    if (intentMatch) {
      const intent = intentMatch[1].trim();
      const hasTools = intentMatch[2].trim();
      // 工具调用痕迹：显示意图与工具状态
      let thought = `意图分析：${intent}`;
      if (hasTools === 'True') {
        thought += '，需要调用工具';
        // 尝试提取工具名
        const toolsInTask = line.match(/tools_executed_in_task=([^,]+)/);
        if (toolsInTask && toolsInTask[1].trim() !== '[]' && toolsInTask[1].trim() !== 'False') {
          thought += `，已执行工具 ${toolsInTask[1].trim()}`;
        }
      } else {
        thought += '，直接回复';
      }
      this.emitReasoning(thought, controller);
      return true;
    }

    // [ReAct] Trace saved: 完成一轮
    if (line.includes('[ReAct] Trace saved')) {
      this.emitReasoning('已完成一轮推理，保存轨迹', controller);
      return true;
    }

    // [TaskMonitor] Task completed — 任务完成
    const doneMatch = line.match(/\[TaskMonitor\]\s*Task completed:.*?duration=([\d.]+)s,\s*iterations=(\d+)/);
    if (doneMatch) {
      this.emitReasoning(`任务完成，耗时 ${doneMatch[1]}s，共 ${doneMatch[2]} 轮推理`, controller);
      return true;
    }

    return false;
  }

  /** 去重发送 reasoning 状态（累积完整思考链，preview 卡片只保留最后一条，需要发送全链才能看到过程） */
  private thinkingLines: string[] = [];

  private emitReasoning(
    thought: string,
    controller: ReadableStreamDefaultController<string>,
  ): void {
    if (!thought || thought.length < 2) return;
    const hash = this.simpleHash(thought);
    if (hash === this.lastThoughtHash) return;
    this.lastThoughtHash = hash;

    this.thinkingLines.push(thought);
    // 累积完整思考链：每次发送全部历史，preview 卡片刷新时显示完整过程
    const chain = this.thinkingLines.join('\n');
    rtLog(`[openakita-provider] reasoning: ${chain.slice(0, 200)}`);
    emitCanonicalTurnEvent(controller, {
      type: 'status',
      data: JSON.stringify({ reasoning: chain }),
    });
  }

  /** 从 OpenAkita 日志行提取思考过程并转发为 reasoning 状态 */
  private handleThinkingLine(
    line: string,
    controller: ReadableStreamDefaultController<string>,
  ): void {
    // 只处理包含思考标记的行
    const markers = ['[IntentTag]', 'text_preview=', 'decision=', 'Thought:', 'Action:', '正在思考'];
    if (!markers.some((m) => line.includes(m))) return;

    let thought: string | null = null;

    // 格式1: [IntentTag] ... text_preview="..."
    const previewMatch = line.match(/text_preview="([^"]*)"/);
    if (previewMatch) {
      thought = previewMatch[1];
    }
    // 格式2: IntentTag 行本身（去掉标记前缀）
    else if (line.includes('[IntentTag]')) {
      const tagIdx = line.indexOf('[IntentTag]');
      thought = line.slice(tagIdx + 10).trim();
    }
    // 格式3: ReAct Thought/Action
    else if (line.includes('Thought:')) {
      const tIdx = line.indexOf('Thought:');
      thought = line.slice(tIdx + 8).trim();
    }

    if (!thought || thought.length < 2) return;
    if (thought === '...' || thought === '思考中') return;

    // 去重：同一思考不重复发送（简单 hash 去重）
    const hash = this.simpleHash(thought);
    if (hash === this.lastThoughtHash) return;
    this.lastThoughtHash = hash;

    rtLog(`[openakita-provider] thinking: ${thought.slice(0, 120)}`);
    emitCanonicalTurnEvent(controller, {
      type: 'status',
      data: JSON.stringify({ reasoning: thought }),
    });
  }

  private lastThoughtHash = '';

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return String(hash);
  }

  /** 解析 OpenAkita 的 opencode-format NDJSON 事件 */
  private handleNdjsonEvent(
    evt: OpenAkitaNdjsonEvent,
    controller: ReadableStreamDefaultController<string>,
    onSessionStart: () => void,
  ): void {
    const type = evt.type || '';
    rtLog(`[openakita-provider] event: ${type}`);

    switch (type) {
      case 'server.connected':
      case 'session.created':
      case 'session.status':
      case 'session.idle':
        onSessionStart();
        break;
      case 'message.part.updated': {
        onSessionStart();
        const part = evt.part || evt.properties?.part;
        const text = part?.text || evt.properties?.delta || evt.delta || '';
        if (text) {
          // text 事件 data 必须是纯字符串（conversation-engine 直接拼接 event.data）
          emitCanonicalTurnEvent(controller, {
            type: 'text',
            data: text,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  /** 从混合输出中提取最终回复（wrapper 的 extract_response 逻辑简化版） */
  private extractFallbackText(raw: string): string {
    // 方法1：任务完成 box
    const lines = raw.split('\n');
    let inBox = false;
    const boxLines: string[] = [];
    for (const line of lines) {
      if (line.includes('任务完成') && line.includes('┌')) {
        inBox = true;
        continue;
      }
      if (inBox && line.includes('└')) {
        inBox = false;
        continue;
      }
      if (inBox && line.includes('│')) {
        const text = line.trim().replace(/^│/, '').replace(/│$/, '').trim();
        if (text) boxLines.push(text);
      }
    }
    if (boxLines.length > 0) return boxLines.join('\n');

    // 方法2：IntentTag text_preview
    for (const line of lines) {
      const m = line.match(/text_preview="([^"]*)"/);
      if (m) return m[1];
    }
    return '';
  }
}
