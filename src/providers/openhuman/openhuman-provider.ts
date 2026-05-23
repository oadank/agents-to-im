/**
 * OpenHuman Provider — 调用 OpenHuman Core JSON-RPC
 *
 * 通过 HTTP POST 调用 localhost:7788/rpc 的 openhuman.agent_chat 方法
 */

import type { LLMProvider, StreamChatParams } from '../../bridge/host.js';

interface OpenHumanConfig {
  coreUrl?: string;  // OpenHuman Core JSON-RPC URL，默认 localhost:7788/rpc
  coreToken?: string; // 认证 token
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: {
    logs?: string[];
    result?: string;
  };
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Build prompt with history injection for OpenHuman.
 * OpenHuman has no session concept, so we inject history as context.
 */
function buildPromptWithHistory(
  prompt: string,
  history?: Array<{ role: 'user' | 'assistant'; content: string }> | undefined,
): string {
  if (!history || history.length === 0) return prompt;

  const historyText = history
    .map((msg) => `${msg.role === 'user' ? '用户' : '助手'}：${msg.content}`)
    .join('\n\n');

  return `以下是之前的对话历史，请继续对话：

${historyText}

---

用户最新消息：
${prompt}`;
}

/**
 * OpenHumanProvider 实现 LLMProvider 接口
 * 调用 OpenHuman Core 的 agent_chat RPC 方法
 */
export class OpenHumanProvider implements LLMProvider {
  private coreUrl: string;
  private coreToken: string;
  private nextId: number = 1;

  constructor(config?: OpenHumanConfig) {
    this.coreUrl = config?.coreUrl || process.env.OPENHUMAN_CORE_URL || 'http://localhost:7788/rpc';
    this.coreToken = config?.coreToken || process.env.OPENHUMAN_CORE_TOKEN || '';
  }

  /**
   * 调用 OpenHuman JSON-RPC
   */
  private async callRpc(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const response = await fetch(this.coreUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.coreToken ? { 'Authorization': `Bearer ${this.coreToken}` } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`OpenHuman RPC HTTP error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<JsonRpcResponse>;
  }

  /**
   * 实现 LLMProvider.streamChat
   * 返回 SSE 格式的 ReadableStream
   */
  streamChat(params: StreamChatParams): ReadableStream<string> {
    const { abortController, conversationHistory } = params;

    // Inject history as context (OpenHuman has no session concept)
    const effectivePrompt = buildPromptWithHistory(params.prompt, conversationHistory);
    if (conversationHistory && conversationHistory.length > 0) {
      console.log(`[openhuman-provider] Injecting ${conversationHistory.length} history messages`);
    }

    return new ReadableStream<string>({
      start: async (controller) => {
        try {
          // 调用 openhuman.agent_chat
          const result = await this.callRpc('openhuman.agent_chat', {
            message: effectivePrompt,
          });

          if (result.error) {
            // 错误响应 - 使用 consumeStream 期望的格式
            controller.enqueue(`data: ${JSON.stringify({ type: 'error', data: result.error.message })}\n\n`);
          } else if (result.result?.result) {
            // 成功响应 - 发送文本事件（格式与 consumeStream 期望一致）
            const text = result.result.result;
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: text })}\n\n`);
          }
          controller.enqueue(`data: ${JSON.stringify({ type: 'done' })}\n\n`);

          controller.close();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          controller.enqueue(`data: ${JSON.stringify({ type: 'error', data: message })}\n\n`);
          controller.close();
        }
      },
      cancel: () => {
        // 被取消时中止请求
        if (abortController) {
          abortController.abort();
        }
      },
    });
  }

  /**
   * 一次性调用 agent_chat（非流式）
   */
  async chat(message: string): Promise<string> {
    const result = await this.callRpc('openhuman.agent_chat', { message });

    if (result.error) {
      throw new Error(`OpenHuman error: ${result.error.message}`);
    }

    return result.result?.result || '';
  }
}

export function createOpenHumanProvider(config?: OpenHumanConfig): OpenHumanProvider {
  return new OpenHumanProvider(config);
}