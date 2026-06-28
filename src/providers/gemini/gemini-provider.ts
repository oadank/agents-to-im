/**
 * Gemini Provider — LiteLLM API (OpenAI-compatible) + tool_calls 支持
 *
 * 调用 LiteLLM 代理 http://127.0.0.1:4000/v1/chat/completions
 * 支持 function calling：模型可调用 7 个本地工具
 *
 * 工具循环上限 10 次，超过则报错终止（防无限循环）
 */

import type { LLMProvider, StreamChatParams } from '../../bridge/host.js';
import { emitCanonicalTurnEvent } from '../../infra/sse-utils.js';
import { GEMINI_TOOLS } from './tool-definitions.js';
import { executeTool, type ParsedToolCall } from './tool-executor.js';

export interface GeminiConfig {
  apiBase?: string;
  apiKey?: string;
  model?: string;
}

const DEFAULT_API_BASE = 'http://127.0.0.1:4000/v1';
const DEFAULT_API_KEY = 'sk-200418';
const DEFAULT_MODEL = 'gemini-model';
const MAX_TOOL_ROUNDS = 10;
const SYSTEM_PROMPT = `You are a helpful AI assistant running as a Feishu bot named "Gemini".
You are connected via the Gemini bridge through LiteLLM to the mimo-v2.5 model.

You have access to 7 tools:
- read_file / write_file / list_files / run_bash (file and command operations, cwd=/opt)
- send_feishu_message (send Feishu messages to any chat_id)
- memory_recall / memory_save (long-term memory via agentmemory)

When the user asks you to do something that requires reading files, running commands, or
sending messages, USE the appropriate tool. Do not just say "let me read..." and stop.

After tool execution, you will receive the result, then you can continue or give a final answer.

When asked about your identity, say you are Gemini, a Feishu AI assistant powered by mimo-v2.5
through LiteLLM, running on debian13.`;

/** OpenAI tool_call delta 累积器 */
interface ToolCallAccumulator {
  index: number;
  id: string;
  name: string;
  argsBuf: string;
}

export class GeminiProvider implements LLMProvider {
  private readonly apiBase: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config?: GeminiConfig) {
    this.apiBase = config?.apiBase || process.env.CTI_GEMINI_API_BASE || DEFAULT_API_BASE;
    this.apiKey = config?.apiKey || process.env.CTI_GEMINI_API_KEY || DEFAULT_API_KEY;
    this.model = config?.model || process.env.CTI_GEMINI_MODEL || DEFAULT_MODEL;
  }

  async prepare(): Promise<void> {
    try {
      const res = await fetch(`${this.apiBase}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
      });
      if (!res.ok) {
        console.warn(`[gemini-provider] LiteLLM health check failed: ${res.status}`);
      }
    } catch (err) {
      console.warn(`[gemini-provider] LiteLLM not reachable: ${err}`);
    }
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;
    return new ReadableStream<string>({
      start(controller) {
        void self.runStream(controller, params);
      },
    });
  }

  private async runStream(
    controller: ReadableStreamDefaultController<string>,
    params: StreamChatParams,
  ): Promise<void> {
    const { prompt, sdkSessionId, abortController, conversationHistory } = params;

    // 构建初始 messages
    const messages: Array<{ role: string; content: string }> = [{ role: 'system', content: SYSTEM_PROMPT }];
    if (conversationHistory && conversationHistory.length > 0) {
      const recent = conversationHistory.slice(-20);
      for (const msg of recent) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
    messages.push({ role: 'user', content: prompt });

    // 工具调用循环（max 10 次）
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await this.callLLM(controller, messages, abortController, sdkSessionId, round);
      if (result.finishReason === 'stop' || result.finishReason === 'length') {
        // 正常结束
        emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: false } });
        emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
        controller.close();
        return;
      }
      if (result.finishReason === 'tool_calls') {
        if (!result.toolCalls || result.toolCalls.length === 0) {
          // 异常：finish_reason=tool_calls 但无 tool_calls
          console.error(`[gemini-provider] Round ${round}: finish_reason=tool_calls 但无 tool_calls`);
          emitCanonicalTurnEvent(controller, { type: 'error', data: 'LLM 返回 tool_calls 但未提供工具调用详情' });
          emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: true } });
          emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
          controller.close();
          return;
        }
        // 把 assistant 的 tool_calls 消息加入历史
        messages.push({
          role: 'assistant',
          content: result.textContent || '',
          // @ts-expect-error OpenAI 扩展字段
          tool_calls: result.toolCalls.map(tc => ({
            id: tc.id, type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        });
        // 依次执行工具，把结果作为 tool 消息加入历史
        for (const tc of result.toolCalls) {
          console.log(`[gemini-provider] Round ${round} tool: ${tc.name} args=${JSON.stringify(tc.args).slice(0, 200)}`);
          const toolResult = await executeTool(tc);
          console.log(`[gemini-provider] Round ${round} tool ${tc.name} result: ${toolResult.slice(0, 200)}`);
          messages.push({
            role: 'tool',
            // @ts-expect-error OpenAI 扩展字段
            tool_call_id: tc.id,
            content: toolResult,
          });
        }
        // 继续下一轮 LLM 调用
        continue;
      }
      // 其他 finish_reason（content_filter 等）
      console.error(`[gemini-provider] Round ${round}: 未知 finish_reason=${result.finishReason}`);
      emitCanonicalTurnEvent(controller, { type: 'error', data: `LLM 异常终止 (finish_reason=${result.finishReason})` });
      emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: true } });
      emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
      controller.close();
      return;
    }

    // 超过 MAX_TOOL_ROUNDS
    console.error(`[gemini-provider] 超过 ${MAX_TOOL_ROUNDS} 轮工具调用，强制终止`);
    emitCanonicalTurnEvent(controller, { type: 'error', data: `超过 ${MAX_TOOL_ROUNDS} 轮工具调用上限，终止` });
    emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: true } });
    emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
    controller.close();
  }

  /** 单次 LLM 调用 + SSE 流式解析 */
  private async callLLM(
    controller: ReadableStreamDefaultController<string>,
    messages: Array<{ role: string; content: string }>,
    abortController: AbortController | undefined,
    sdkSessionId: string | undefined,
    round: number,
  ): Promise<{ finishReason: string; textContent: string; toolCalls: ParsedToolCall[] }> {
    const body = {
      model: this.model,
      messages,
      stream: true,
      max_tokens: 4096,
      tools: GEMINI_TOOLS,
    };

    console.log(`[gemini-provider] Round ${round}: POST ${this.apiBase}/chat/completions model=${this.model} msgs=${messages.length}`);

    const res = await fetch(`${this.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: abortController?.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const errMsg = `LiteLLM API error: ${res.status} ${errText.slice(0, 300)}`;
      console.error(`[gemini-provider] ${errMsg}`);
      emitCanonicalTurnEvent(controller, { type: 'error', data: errMsg });
      emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: true } });
      emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
      controller.close();
      // 抛异常终止外层循环
      throw new Error(errMsg);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let lineBuf = '';
    let textContent = '';
    let finishReason = 'stop';
    const accumulators = new Map<number, ToolCallAccumulator>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuf += decoder.decode(value, { stream: true });
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const chunk = JSON.parse(data);
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};
          if (delta.content) {
            textContent += delta.content;
            emitCanonicalTurnEvent(controller, { type: 'text', data: delta.content });
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!accumulators.has(idx)) {
                accumulators.set(idx, {
                  index: idx,
                  id: tc.id || '',
                  name: tc.function?.name || '',
                  argsBuf: '',
                });
              }
              const acc = accumulators.get(idx)!;
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name = tc.function.name;
              if (tc.function?.arguments) acc.argsBuf += tc.function.arguments;
            }
          }
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
        } catch {
          // 忽略解析失败的 chunk
        }
      }
    }

    // 把累积的 tool_calls 解析为 ParsedToolCall[]
    const toolCalls: ParsedToolCall[] = [];
    for (const acc of accumulators.values()) {
      let args: Record<string, unknown> = {};
      if (acc.argsBuf) {
        try { args = JSON.parse(acc.argsBuf); } catch { args = { _raw: acc.argsBuf }; }
      }
      toolCalls.push({ id: acc.id || `tc_${Date.now()}_${acc.index}`, name: acc.name, args });
    }

    console.log(`[gemini-provider] Round ${round} done: finish=${finishReason} text=${textContent.length}chars tools=${toolCalls.length}`);
    return { finishReason, textContent, toolCalls };
  }
}

export function createGeminiProvider(config?: GeminiConfig): GeminiProvider {
  return new GeminiProvider(config);
}
