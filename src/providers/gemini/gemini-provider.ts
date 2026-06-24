/**
 * Gemini Provider — LiteLLM API (OpenAI-compatible)
 *
 * Calls LiteLLM proxy at http://127.0.0.1:4000/v1/chat/completions
 * using standard OpenAI-compatible chat completions protocol with streaming.
 *
 * No dependency on Gemini CLI or ACP mode.
 */

import type { LLMProvider, StreamChatParams } from '../../bridge/host.js';
import { emitCanonicalTurnEvent } from '../../infra/sse-utils.js';

export interface GeminiConfig {
  apiBase?: string;
  apiKey?: string;
  model?: string;
}

const DEFAULT_API_BASE = 'http://127.0.0.1:4000/v1';
const DEFAULT_API_KEY = 'sk-200418';
const DEFAULT_MODEL = 'gemini-model';
const SYSTEM_PROMPT = `You are a helpful AI assistant running as a Feishu bot. You are connected via the Gemini bridge, using the gemini-model endpoint through LiteLLM.
You are helpful, harmless, and honest. You can help with writing, analysis, coding, math, and general questions.
When asked about your identity, say you are a Feishu AI assistant powered by the Gemini bridge.`;

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
    // Verify LiteLLM is reachable
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

    // Build messages array with system prompt and conversation history
    const messages: Array<{ role: string; content: string }> = [];

    // Add system prompt
    messages.push({ role: 'system', content: SYSTEM_PROMPT });

    // Inject conversation history (last 20 messages)
    if (conversationHistory && conversationHistory.length > 0) {
      const recent = conversationHistory.slice(-20);
      for (const msg of recent) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    messages.push({ role: 'user', content: prompt });

    const body = {
      model: this.model,
      messages,
      stream: true,
      max_tokens: 4096,
    };

    console.log(`[gemini-provider] POST ${this.apiBase}/chat/completions model=${this.model} msgs=${messages.length}`);

    try {
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
        const errMsg = `LiteLLM API error: ${res.status} ${errText.slice(0, 200)}`;
        console.error(`[gemini-provider] ${errMsg}`);
        emitCanonicalTurnEvent(controller, { type: 'error', data: errMsg });
        emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: true } });
        emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
        controller.close();
        return;
      }

      // Parse SSE stream
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let lineBuf = '';
      let textContent = '';

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
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
              textContent += delta.content;
              emitCanonicalTurnEvent(controller, { type: 'text', data: delta.content });
            }
          } catch {
            // Ignore malformed chunks
          }
        }
      }

      console.log(`[gemini-provider] Response complete: ${textContent.length} chars`);
      emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: false } });
      emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
      controller.close();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[gemini-provider] Request failed: ${errMsg}`);
      emitCanonicalTurnEvent(controller, { type: 'error', data: errMsg });
      emitCanonicalTurnEvent(controller, { type: 'result', data: { session_id: sdkSessionId || '', is_error: true } });
      emitCanonicalTurnEvent(controller, { type: 'done', data: '' });
      controller.close();
    }
  }
}

export function createGeminiProvider(config?: GeminiConfig): GeminiProvider {
  return new GeminiProvider(config);
}
