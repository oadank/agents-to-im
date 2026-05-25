/**
 * OpenHuman Provider — 使用 Socket.IO 监听流式事件
 *
 * 连接 OpenHuman Core Socket.IO，监听 text_delta/thinking_delta/tool_call 等事件
 * 将事件转换为 SSE 格式发送给飞书
 */

import { io, Socket } from 'socket.io-client';
import type { LLMProvider, StreamChatParams, ActivityEvent } from '../../bridge/host.js';

interface OpenHumanConfig {
  coreUrl?: string;
  coreToken?: string;
}

/**
 * Socket.IO 事件结构（与 OpenHuman WebChannelEvent 一致）
 */
interface WebChannelEvent {
  event: string;
  client_id: string;
  thread_id: string;
  request_id: string;
  full_response?: string;
  message?: string;
  error_type?: string;
  tool_name?: string;
  skill_id?: string;
  args?: Record<string, unknown>;
  output?: string;
  success?: boolean;
  round?: number;
  reaction_emoji?: string;
  segment_index?: number;
  segment_total?: number;
  delta?: string;
  delta_kind?: 'text' | 'thinking' | 'tool_args';
  tool_call_id?: string;
  subagent?: {
    agent_id?: string;
    mode?: string;
    iteration?: number;
    max_iterations?: number;
    status?: string;
    child_task_id?: string;
    child_agent_id?: string;
    child_tool_name?: string;
    total_tool_calls?: number;
    elapsed_seconds?: number;
  };
}

/**
 * OpenHumanProvider 实现 LLMProvider 接口
 * 使用 Socket.IO 监听流式事件
 */
export class OpenHumanProvider implements LLMProvider {
  private coreUrl: string;
  private coreToken: string;
  private socket: Socket | null = null;

  constructor(config?: OpenHumanConfig) {
    // 从 RPC URL 推导 Socket.IO URL
    const rpcUrl = config?.coreUrl || process.env.OPENHUMAN_CORE_URL || 'http://localhost:7788/rpc';
    this.coreUrl = rpcUrl.replace('/rpc', '');
    this.coreToken = config?.coreToken || process.env.OPENHUMAN_CORE_TOKEN || '';
  }

  /**
   * 初始化 Socket.IO 连接
   */
  private async ensureSocket(): Promise<Socket> {
    if (this.socket && this.socket.connected) {
      return this.socket;
    }

    this.socket = io(this.coreUrl, {
      auth: {
        token: this.coreToken,
      },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    return new Promise((resolve, reject) => {
      this.socket!.on('connect', () => {
        console.log('[openhuman-provider] Socket.IO connected, sid=', this.socket!.id);
        resolve(this.socket!);
      });

      this.socket!.on('connect_error', (err) => {
        console.warn('[openhuman-provider] Socket.IO connect error:', err.message);
        reject(err);
      });

      // 监听 ready 事件
      this.socket!.on('ready', (data: { sid: string }) => {
        console.log('[openhuman-provider] Socket.IO ready, sid=', data.sid);
      });

      // 10秒超时
      setTimeout(() => {
        if (!this.socket!.connected) {
          reject(new Error('Socket.IO connection timeout'));
        }
      }, 10000);
    });
  }

  /**
   * 构建 chat 消息（合并历史上下文）
   */
  private buildChatMessage(prompt: string, history?: Array<{ role: 'user' | 'assistant'; content: string }>): string {
    if (!history || history.length === 0) {
      return prompt;
    }

    const historyText = history
      .map(msg => `${msg.role === 'user' ? '用户' : '助手'}: ${msg.content}`)
      .join('\n\n');

    return `【之前的对话】\n${historyText}\n\n【当前问题】\n${prompt}`;
  }

  /**
   * 实现 LLMProvider.streamChat
   * 使用 Socket.IO 监听流式事件
   */
  streamChat(params: StreamChatParams): ReadableStream<string> {
    const { abortController, prompt, conversationHistory } = params;

    return new ReadableStream<string>({
      start: async (controller) => {
        try {
          const socket = await this.ensureSocket();
          const threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          const requestId = threadId;
          const clientId = socket.id || '';

          console.log('[openhuman-provider] Starting chat, thread_id=', threadId, 'client_id=', clientId);

          // 累积思维过程文本
          let accumulatedThinking = '';

          // 监听所有事件（OpenHuman 按房间发送）
          // 需要监听 client_id 对应的事件
          const eventNames = [
            'text_delta', 'thinking_delta', 'tool_call', 'tool_result',
            'chat_done', 'chat_message', 'chat_error',
            'subagent_spawned', 'subagent_completed', 'subagent_iteration_start',
            'subagent_tool_call', 'subagent_tool_result',
          ];

          const handlers: Array<{ name: string; handler: (data: WebChannelEvent) => void }> = [];

          for (const eventName of eventNames) {
            const handler = (data: WebChannelEvent) => {
              // 只处理当前请求的事件
              if (data.request_id !== requestId && data.thread_id !== threadId) {
                return;
              }

              console.log('[openhuman-provider] Received event:', data.event, 'delta=', data.delta?.slice(0, 50));

              // 处理不同事件类型
              let sse: string | null = null;
              // 标记是否已发送思维过程（让思维过程在文本之前）
              let thinkingSent = false;

              switch (data.event) {
                case 'text_delta':
                  // 文本流式输出：先发送累积的思维过程（如果有）
                  if (accumulatedThinking.trim() && !thinkingSent) {
                    const thinkingSse = `data: ${JSON.stringify({
                      type: 'activity_event',
                      data: JSON.stringify({
                        kind: 'reasoning_activity',
                        id: `thinking:${data.request_id}`,
                        turnId: data.request_id,
                        status: 'completed',
                        text: accumulatedThinking.trim(),
                      } as ActivityEvent),
                    })}\n\n`;
                    try {
                      controller.enqueue(thinkingSse);
                      thinkingSent = true;
                    } catch (e) {
                      // 忽略
                    }
                  }
                  // 然后发送文本
                  if (data.delta) {
                    sse = `data: ${JSON.stringify({ type: 'text', data: data.delta })}\n\n`;
                  }
                  break;

                case 'thinking_delta':
                  // 累积思维过程，不立即发送
                  if (data.delta) {
                    accumulatedThinking += data.delta;
                  }
                  // 不发送 SSE，等待 text_delta 或 chat_done 时发送
                  sse = null;
                  break;

                case 'tool_call':
                  // 工具调用卡片
                  sse = `data: ${JSON.stringify({
                    type: 'activity_event',
                    data: JSON.stringify({
                      kind: 'tool_activity',
                      id: `tool:${data.tool_call_id || data.request_id}`,
                      turnId: data.request_id,
                      toolUseId: data.tool_call_id || data.request_id,
                      toolName: data.tool_name || 'unknown',
                      status: 'running',
                      inputPreview: data.args ? JSON.stringify(data.args).slice(0, 200) : undefined,
                    } as ActivityEvent),
                  })}\n\n`;
                  break;

                case 'tool_result':
                  // 工具结果卡片
                  // 检查是否是权限请求错误消息
                  if (data.output && data.output.includes('PERMISSION_REQUIRED:')) {
                    // 解析权限请求信息: PERMISSION_REQUIRED:shell:<command>
                    const permMatch = data.output.match(/PERMISSION_REQUIRED:(\w+):(.+)/);
                    if (permMatch) {
                      const permKind = permMatch[1]; // 'shell'
                      const permCommand = permMatch[2]; // command
                      // 发送权限请求 SSE 事件
                      const permRequestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                      sse = `data: ${JSON.stringify({
                        type: 'permission_request',
                        data: JSON.stringify({
                          permissionRequestId: permRequestId,
                          toolName: data.tool_name || permKind,
                          toolInput: { command: permCommand },
                          kind: permKind,
                        }),
                      })}\n\n`;
                      // 存储权限请求 ID 用于后续响应
                      (this as any)._pendingPermRequestId = permRequestId;
                      (this as any)._pendingPermCommand = permCommand;
                      break;
                    }
                  }
                  sse = `data: ${JSON.stringify({
                    type: 'activity_event',
                    data: JSON.stringify({
                      kind: 'tool_activity',
                      id: `tool:${data.tool_call_id || data.request_id}`,
                      turnId: data.request_id,
                      toolUseId: data.tool_call_id || data.request_id,
                      toolName: data.tool_name || 'unknown',
                      status: data.success ? 'completed' : 'failed',
                      resultPreview: data.output ? data.output.slice(0, 500) : undefined,
                    } as ActivityEvent),
                  })}\n\n`;
                  break;

                case 'chat_done':
                  // 完成时，如果思维过程还没发送（比如只有思维没有文本），现在发送
                  if (accumulatedThinking.trim() && !thinkingSent) {
                    const thinkingSse = `data: ${JSON.stringify({
                      type: 'activity_event',
                      data: JSON.stringify({
                        kind: 'reasoning_activity',
                        id: `thinking:${data.request_id}`,
                        turnId: data.request_id,
                        status: 'completed',
                        text: accumulatedThinking.trim(),
                      } as ActivityEvent),
                    })}\n\n`;
                    try {
                      controller.enqueue(thinkingSse);
                    } catch (e) {
                      // 忽略
                    }
                  }
                  sse = `data: ${JSON.stringify({ type: 'done' })}\n\n`;
                  break;

                case 'chat_message':
                  // 完整消息
                  if (data.full_response) {
                    sse = `data: ${JSON.stringify({ type: 'text', data: data.full_response })}\n\n`;
                  } else if (data.message) {
                    sse = `data: ${JSON.stringify({ type: 'text', data: data.message })}\n\n`;
                  }
                  break;

                case 'chat_error':
                  sse = `data: ${JSON.stringify({ type: 'error', data: data.message || data.error_type || 'Unknown error' })}\n\n`;
                  break;

                case 'subagent_spawned':
                case 'subagent_completed':
                case 'subagent_iteration_start':
                case 'subagent_tool_call':
                case 'subagent_tool_result':
                  // Subagent 事件
                  if (data.subagent || data.tool_name) {
                    sse = `data: ${JSON.stringify({
                      type: 'activity_event',
                      data: JSON.stringify({
                        kind: 'tool_activity',
                        id: `subagent:${data.request_id}`,
                        turnId: data.request_id,
                        toolUseId: data.tool_call_id || data.request_id,
                        toolName: data.tool_name || 'subagent',
                        status: data.event === 'subagent_completed' ? 'completed' : 'running',
                        inputPreview: data.args ? JSON.stringify(data.args).slice(0, 200) : undefined,
                        resultPreview: data.output ? data.output.slice(0, 500) : undefined,
                      } as ActivityEvent),
                    })}\n\n`;
                  }
                  break;

                default:
                  // 其他事件，尝试提取 delta
                  if (data.delta) {
                    sse = `data: ${JSON.stringify({ type: 'text', data: data.delta })}\n\n`;
                  }
                  break;
              }

              if (sse) {
                try {
                  controller.enqueue(sse);
                } catch (e) {
                  console.warn('[openhuman-provider] Failed to enqueue:', e);
                }
              }

              // 完成或错误时关闭
              if (data.event === 'chat_done' || data.event === 'chat_error') {
                for (const h of handlers) {
                  socket.off(h.name, h.handler);
                }
                try {
                  controller.close();
                } catch (e) {
                  // 已经关闭了
                }
              }
            };
            handlers.push({ name: eventName, handler });
            socket.on(eventName, handler);
          }

          // 发送 chat:start 事件
          const message = this.buildChatMessage(prompt, conversationHistory);
          socket.emit('chat:start', {
            thread_id: threadId,
            message,
            model_override: null,
            temperature: null,
            profile_id: null,
            locale: null,
          });

          console.log('[openhuman-provider] Sent chat:start, message length=', message.length);

          // 设置超时（5分钟）
          const timeout = setTimeout(() => {
            for (const h of handlers) {
              socket.off(h.name, h.handler);
            }
            controller.enqueue(`data: ${JSON.stringify({ type: 'error', data: 'Response timeout' })}\n\n`);
            try {
              controller.close();
            } catch (e) {
              // 已经关闭了
            }
          }, 300000);

          // 清理超时当流关闭
          abortController?.signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            for (const h of handlers) {
              socket.off(h.name, h.handler);
            }
          });

        } catch (error) {
          // Socket.IO 连接失败，回退到 RPC
          console.warn('[openhuman-provider] Socket.IO failed, falling back to RPC:', error);
          await this.fallbackRpcChat(params, controller);
        }
      },
      cancel: () => {
        if (abortController) {
          abortController.abort();
        }
        if (this.socket) {
          // 移除所有监听器
          this.socket.removeAllListeners();
        }
      },
    });
  }

  /**
   * 回退到 RPC 调用（当 Socket.IO 不可用时）
   */
  private async fallbackRpcChat(
    params: StreamChatParams,
    controller: ReadableStreamDefaultController<string>,
  ): Promise<void> {
    const { prompt, conversationHistory } = params;
    const message = this.buildChatMessage(prompt, conversationHistory);

    try {
      const response = await fetch(`${this.coreUrl}/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.coreToken ? { 'Authorization': `Bearer ${this.coreToken}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'openhuman.agent_chat',
          params: { message },
        }),
      });

      if (!response.ok) {
        throw new Error(`RPC HTTP error: ${response.status}`);
      }

      const result = await response.json() as { result?: { result?: string }; error?: { message: string } };

      if (result.error) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'error', data: result.error.message })}\n\n`);
      } else if (result.result?.result) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: result.result.result })}\n\n`);
      }
      controller.enqueue(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      controller.close();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      controller.enqueue(`data: ${JSON.stringify({ type: 'error', data: msg })}\n\n`);
      controller.close();
    }
  }

  /**
   * 关闭 Socket.IO 连接
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  /**
   * 发送审批结果给 OpenHuman
   * 当飞书用户点击审批按钮后调用此方法
   */
  async sendPermissionResponse(permissionRequestId: string, approved: boolean): Promise<void> {
    try {
      const socket = await this.ensureSocket();

      // 发送 permission_response 事件
      socket.emit('permission_response', {
        permission_request_id: permissionRequestId,
        approved,
        event: 'permission_response',
        client_id: socket.id || '',
        thread_id: '',
        request_id: permissionRequestId,
      });

      console.log('[openhuman-provider] Sent permission_response:', permissionRequestId, 'approved:', approved);
    } catch (error) {
      console.warn('[openhuman-provider] Failed to send permission_response:', error);
    }
  }
}

export function createOpenHumanProvider(config?: OpenHumanConfig): OpenHumanProvider {
  return new OpenHumanProvider(config);
}

export type { OpenHumanConfig };