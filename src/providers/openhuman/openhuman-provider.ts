/**
 * OpenHuman Provider — Socket.IO 流式事件 + RPC 发送消息
 *
 * 连接 OpenHuman Core Socket.IO 接收流式事件
 * 用 RPC openhuman.channel_web_chat 发送消息（Core 用 client_id 路由事件）
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
 * Socket.IO 接收事件 + RPC 发送消息
 */
export class OpenHumanProvider implements LLMProvider {
  private coreUrl: string;
  private coreToken: string;
  private socket: Socket | null = null;

  constructor(config?: OpenHumanConfig) {
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
      path: '/socket.io/',           // 关键：显式路径
      auth: { token: this.coreToken },
      transports: ['websocket', 'polling'],  // polling fallback
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      forceNew: true,
      timeout: 5000,
    });

    // 调试：监听所有 Socket.IO 事件
    this.socket.onAny((eventName, ...args) => {
      console.log('[openhuman-provider] Socket.IO event:', eventName, 'args:', JSON.stringify(args).slice(0, 200));
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
   * 通过 RPC 发送消息到 OpenHuman Core
   * Core 用 client_id（socket.id）路由事件到对应 socket
   */
  private async sendChatViaRpc(
    clientId: string,
    threadId: string,
    message: string,
    modelOverride?: string,
    fromAudio?: boolean,
  ): Promise<void> {
    const response = await fetch(`${this.coreUrl}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.coreToken ? { 'Authorization': `Bearer ${this.coreToken}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'openhuman.channel_web_chat',
        params: {
          client_id: clientId,
          thread_id: threadId,
          message,
          model_override: modelOverride || null,
          profile_id: null,
          locale: null,
          // 传递语音标记，让 Core 知道消息来源
          ...(fromAudio ? { from_audio: true } : {}),
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`RPC HTTP error: ${response.status}`);
    }

    const result = await response.json() as { error?: { message: string } };
    if (result.error) {
      throw new Error(result.error.message);
    }

    console.log('[openhuman-provider] RPC chat sent, thread_id=', threadId, 'fromAudio=', fromAudio);
  }

  /**
   * 构建 chat 消息
   * OpenHuman 用 thread_id 自己管理对话历史，我们只发送用户当前输入
   */
  private buildChatMessage(prompt: string, _history?: Array<{ role: 'user' | 'assistant'; content: string }>): string {
    return prompt;
  }

  /**
   * 实现 LLMProvider.streamChat
   * Socket.IO 接收事件 + RPC 发送消息
   */
  streamChat(params: StreamChatParams): ReadableStream<string> {
    const { abortController, prompt, conversationHistory, model } = params;

    return new ReadableStream<string>({
      start: async (controller) => {
        try {
          const socket = await this.ensureSocket();
          const clientId = socket.id || '';

          if (!clientId) {
            console.warn('[openhuman-provider] No socket.id, falling back to RPC');
            await this.fallbackRpcChat(params, controller);
            return;
          }

          // 生成临时 thread_id（用于 RPC 调用，Core 可能会生成新的）
          const threadId = `thread_${Date.now()}_${Math.random().toString(36).slice(2)}`;

          console.log('[openhuman-provider] Starting chat, client_id=', clientId, 'thread_id=', threadId);

          // 检查是否是语音消息（从 params.files 判断）
          const fromAudio = params.files?.some(f => f.type.startsWith('audio/')) || false;

          // 状态变量
          let activeThreadId: string | null = null;  // 从第一个事件确定
          let accumulatedThinking = '';
          let accumulatedText = '';
          let thinkingSent = false;
          let done = false;

          // 监听的事件列表
          const eventNames = [
            'inference_start', 'iteration_start',
            'text_delta', 'thinking_delta', 'tool_call', 'tool_result',
            'chat_done', 'chat_segment', 'chat_error',
            'subagent_spawned', 'subagent_completed', 'subagent_iteration_start',
            'subagent_tool_call', 'subagent_tool_result',
          ];

          const handlers: Array<{ name: string; handler: (data: unknown) => void }> = [];

          for (const eventName of eventNames) {
            const handler = (data: unknown) => {
              const event = data as WebChannelEvent;

              // 等待第一个事件确定 thread_id
              if (!activeThreadId && event.thread_id) {
                activeThreadId = event.thread_id;
                console.log('[openhuman-provider] Active thread_id set:', activeThreadId);
              }

              // 只处理当前 thread 的事件
              if (activeThreadId && event.thread_id !== activeThreadId) {
                return;
              }

              console.log('[openhuman-provider] Event:', eventName, 'delta=', (event as any).delta?.slice?.(0, 50));

              let sse: string | null = null;

              switch (eventName) {
                case 'text_delta':
                  if ((event as any).delta) {
                    accumulatedText += (event as any).delta;
                  }
                  // 先发送累积的思维过程
                  if (accumulatedThinking.trim() && !thinkingSent) {
                    const thinkingSse = `data: ${JSON.stringify({
                      type: 'activity_event',
                      data: JSON.stringify({
                        kind: 'reasoning_activity',
                        id: `thinking:${event.request_id}`,
                        turnId: event.request_id,
                        status: 'completed',
                        text: accumulatedThinking.trim(),
                      } as ActivityEvent),
                    })}\n\n`;
                    try { controller.enqueue(thinkingSse); thinkingSent = true; } catch { }
                  }
                  if ((event as any).delta) {
                    sse = `data: ${JSON.stringify({ type: 'text', data: (event as any).delta })}\n\n`;
                  }
                  break;

                case 'thinking_delta':
                  if ((event as any).delta) {
                    accumulatedThinking += (event as any).delta;
                  }
                  sse = null;
                  break;

                case 'inference_start':
                  sse = `data: ${JSON.stringify({
                    type: 'activity_event',
                    data: JSON.stringify({
                      kind: 'lightweight_activity',
                      id: `inference:${event.thread_id}`,
                      status: 'running',
                      text: '正在思考...',
                    } as ActivityEvent),
                  })}\n\n`;
                  break;

                case 'iteration_start':
                  if ((event as any).round > 1) {
                    sse = `data: ${JSON.stringify({
                      type: 'activity_event',
                      data: JSON.stringify({
                        kind: 'lightweight_activity',
                        id: `iteration:${event.thread_id}`,
                        status: 'running',
                        text: `迭代 ${(event as any).round}...`,
                      } as ActivityEvent),
                    })}\n\n`;
                  }
                  break;

                case 'tool_call':
                  // 不显示工具调用，避免噪音
                  sse = null;
                  break;

                case 'tool_result':
                  // 只处理权限请求
                  if (event.output && event.output.includes('PERMISSION_REQUIRED:')) {
                    const permMatch = event.output.match(/PERMISSION_REQUIRED:(\w+):(.+)/);
                    if (permMatch) {
                      const permRequestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                      sse = `data: ${JSON.stringify({
                        type: 'permission_request',
                        data: JSON.stringify({
                          permissionRequestId: permRequestId,
                          toolName: event.tool_name || permMatch[1],
                          toolInput: { command: permMatch[2] },
                        }),
                      })}\n\n`;
                      (this as any)._pendingPermRequestId = permRequestId;
                    }
                  }
                  sse = null;
                  break;

                case 'chat_segment':
                  if ((event as any).full_response) {
                    sse = `data: ${JSON.stringify({ type: 'text_segment', data: (event as any).full_response })}\n\n`;
                  }
                  break;

                case 'chat_done':
                  if (accumulatedText.trim()) {
                    const textSegmentSse = `data: ${JSON.stringify({ type: 'text_segment', data: accumulatedText.trim() })}\n\n`;
                    try { controller.enqueue(textSegmentSse); } catch { }
                  }
                  if (accumulatedThinking.trim() && !thinkingSent) {
                    const thinkingSse = `data: ${JSON.stringify({
                      type: 'activity_event',
                      data: JSON.stringify({
                        kind: 'reasoning_activity',
                        id: `thinking:${event.request_id}`,
                        turnId: event.request_id,
                        status: 'completed',
                        text: accumulatedThinking.trim(),
                      } as ActivityEvent),
                    })}\n\n`;
                    try { controller.enqueue(thinkingSse); } catch { }
                  }
                  if (event.full_response && !accumulatedText.trim()) {
                    // 修复：发送 text_segment 而不是 text，确保桥接能正确处理并发送消息
                    const fallbackSegment = `data: ${JSON.stringify({ type: 'text_segment', data: event.full_response })}\n\n`;
                    try { controller.enqueue(fallbackSegment); } catch { }
                  }
                  controller.enqueue(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
                  done = true;
                  for (const h of handlers) {
                    socket.off(h.name, h.handler);
                  }
                  try { controller.close(); } catch { }
                  return;

                case 'chat_error':
                  sse = `data: ${JSON.stringify({ type: 'error', data: event.message || event.error_type || 'Unknown error' })}\n\n`;
                  done = true;
                  for (const h of handlers) {
                    socket.off(h.name, h.handler);
                  }
                  try { controller.close(); } catch { }
                  return;

                case 'subagent_spawned':
                case 'subagent_completed':
                case 'subagent_iteration_start':
                case 'subagent_tool_call':
                case 'subagent_tool_result':
                  // 不显示 subagent 活动，避免噪音
                  sse = null;
                  break;
              }

              if (sse) {
                try { controller.enqueue(sse); } catch { }
              }
            };

            handlers.push({ name: eventName, handler });
            socket.on(eventName, handler);
          }

          // 通过 RPC 发送消息
          const message = this.buildChatMessage(prompt, conversationHistory);
          await this.sendChatViaRpc(clientId, threadId, message, model, fromAudio);

          console.log('[openhuman-provider] RPC sent, waiting for events...');

          // 设置超时（5分钟）
          const timeout = setTimeout(() => {
            if (!done) {
              console.warn('[openhuman-provider] Response timeout');
              for (const h of handlers) {
                socket.off(h.name, h.handler);
              }
              try {
                controller.enqueue(`data: ${JSON.stringify({ type: 'error', data: 'Response timeout' })}\n\n`);
                controller.close();
              } catch { }
            }
          }, 300000);

          // 清理超时
          abortController?.signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            for (const h of handlers) {
              socket.off(h.name, h.handler);
            }
          });

        } catch (error) {
          console.warn('[openhuman-provider] Socket.IO failed, falling back to RPC:', error);
          await this.fallbackRpcChat(params, controller);
        }
      },
      cancel: () => {
        if (abortController) {
          abortController.abort();
        }
        if (this.socket) {
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
   */
  async sendPermissionResponse(permissionRequestId: string, approved: boolean): Promise<void> {
    try {
      const socket = await this.ensureSocket();
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