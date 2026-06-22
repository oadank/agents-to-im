import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as lark from '@larksuiteoapi/node-sdk';

import type { ChannelAddress } from '../bridge/types.js';
import { CTI_HOME } from '../config/config.js';
import { findMissingAppScopes } from './constants.js';
import type {
  LarkMessageResponse,
  PatchCardOptions,
} from './types.js';
import {
  assertLarkOk,
  isNonEmptyString,
} from './utils.js';

const USER_TOKEN_PATH = path.join(CTI_HOME, 'user-token.json');

export class LarkClient {
  readonly outboundMessageQueues = new Map<string, Promise<void>>();
  readonly lastOutboundMessageAt = new Map<string, number>();

  private client: lark.Client | null = null;
  private userAccessToken: string | null = null;
  private userRefreshToken: string | null = null;
  private userTokenExpiresAt: number = 0;

  constructor() {
    this.loadUserToken();
  }

  getClient(): lark.Client | null {
    return this.client;
  }

  setClient(client: lark.Client | null): void {
    this.client = client;
    if (!client) {
      this.outboundMessageQueues.clear();
      this.lastOutboundMessageAt.clear();
    }
  }

  getUserAccessToken(): string | null {
    if (this.userAccessToken && Date.now() < this.userTokenExpiresAt) {
      return this.userAccessToken;
    }
    return null;
  }

  setUserAccessToken(token: string, refreshToken?: string, expiresIn?: number): void {
    this.userAccessToken = token;
    this.userRefreshToken = refreshToken || null;
    this.userTokenExpiresAt = Date.now() + (expiresIn || 7200) * 1000;
    this.saveUserToken();
  }

  clearUserAccessToken(): void {
    this.userAccessToken = null;
    this.userRefreshToken = null;
    this.userTokenExpiresAt = 0;
    this.saveUserToken();
  }

  private loadUserToken(): void {
    try {
      const data = JSON.parse(fs.readFileSync(USER_TOKEN_PATH, 'utf-8'));
      this.userAccessToken = data.accessToken || null;
      this.userRefreshToken = data.refreshToken || null;
      this.userTokenExpiresAt = data.expiresAt || 0;
    } catch {
      // Token file doesn't exist or is invalid
    }
  }

  private saveUserToken(): void {
    try {
      const dir = path.dirname(USER_TOKEN_PATH);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(USER_TOKEN_PATH, JSON.stringify({
        accessToken: this.userAccessToken,
        refreshToken: this.userRefreshToken,
        expiresAt: this.userTokenExpiresAt,
      }, null, 2), { mode: 0o600 });
    } catch (error) {
      console.error('[lark-client] Failed to save user token:', error);
    }
  }

  async sendMessage(
    address: ChannelAddress,
    msgType: 'interactive' | 'post' | 'image',
    content: string,
    replyToMessageId?: string,
    requestUuid?: string,
    useUserToken?: boolean,
  ): Promise<LarkMessageResponse> {
    if (!this.client) {
      throw new Error('Feishu client not initialized');
    }

    // Determine which token to use
    const userToken = useUserToken ? this.getUserAccessToken() : null;
    const requestOpts = userToken ? lark.withUserAccessToken(userToken) : undefined;

    return this.enqueueMessage(address.chatId, async () => {
      const uuid = requestUuid || randomUUID().slice(0, 50);
      if (replyToMessageId) {
        try {
          return await (this.client!.im.message.reply as Function)(
            {
              path: { message_id: replyToMessageId },
              data: {
                msg_type: msgType,
                content,
                uuid,
                ...(address.threadId ? { reply_in_thread: true } : {}),
              },
            },
            requestOpts,
          );
        } catch (error) {
          // Check if the error is "message withdrawn" (code 230011)
          const axiosError = error as { response?: { data?: { code?: number } } };
          if (axiosError.response?.data?.code === 230011) {
            console.warn('[feishu-adapter] Reply message was withdrawn, falling back to create new message');
            // Fall back to creating a new message without reply
            const receiveId = address.threadId || address.chatId;
            const receiveIdType = (address.threadId ? 'thread_id' : 'chat_id') as 'thread_id' | 'chat_id';
            return (this.client!.im.message.create as Function)(
              {
                params: { receive_id_type: receiveIdType as never },
                data: {
                  receive_id: receiveId,
                  msg_type: msgType,
                  content,
                  uuid: randomUUID().slice(0, 50), // New UUID to avoid conflict
                },
              },
              requestOpts,
            );
          }
          throw error;
        }
      }
      const receiveId = address.threadId || address.chatId;
      const receiveIdType = (address.threadId ? 'thread_id' : 'chat_id') as 'thread_id' | 'chat_id';
      return (this.client!.im.message.create as Function)(
        {
          params: { receive_id_type: receiveIdType as never },
          data: {
            receive_id: receiveId,
            msg_type: msgType,
            content,
            uuid,
          },
        },
        requestOpts,
      );
    });
  }

  async sendCard(
    address: ChannelAddress,
    card: Record<string, unknown> | lark.InteractiveCard,
    replyToMessageId?: string,
    requestUuid?: string,
    useUserToken?: boolean,
  ): Promise<{ messageId: string; openMessageId?: string; cardToken?: string }> {
    const response = await this.sendMessage(
      address,
      'interactive',
      JSON.stringify(card),
      replyToMessageId,
      requestUuid,
      useUserToken,
    );
    assertLarkOk(response, 'im.message.sendInteractiveCard');
    return {
      messageId: response.data?.message_id || '',
      openMessageId: response.data?.open_message_id,
    };
  }

  async patchCard(
    messageId: string,
    card: Record<string, unknown>,
    options?: PatchCardOptions,
  ): Promise<void> {
    if (!this.client) {
      throw new Error('Feishu client not initialized');
    }
    const response = await (this.client.im.message as {
      patch: (payload: {
        path: { message_id: string };
        data: { content: string };
        params?: { message_id_type: 'open_message_id' };
      }) => Promise<{ code?: number; msg?: string }>;
    }).patch({
      path: { message_id: messageId },
      ...(options?.messageIdType === 'open_message_id'
        ? { params: { message_id_type: 'open_message_id' as const } }
        : {}),
      data: {
        content: JSON.stringify(card),
      },
    });
    assertLarkOk(response, 'im.message.patch');
  }

  async deleteMessageQuietly(messageId: string): Promise<void> {
    const messageApi = this.client?.im?.message as {
      delete?: (payload: { path: { message_id: string } }) => Promise<{ code?: number; msg?: string }>;
    } | undefined;
    if (!messageApi?.delete) return;
    try {
      const response = await messageApi.delete({
        path: { message_id: messageId },
      });
      assertLarkOk(response, 'im.message.delete');
    } catch (error) {
      console.warn('[feishu-adapter] Failed to delete stale preview placeholder:', error);
    }
  }

  async uploadImage(filePath: string): Promise<string> {
    if (!this.client) {
      throw new Error('Feishu client not initialized');
    }
    const image = fs.readFileSync(filePath);
    const response = await this.client.im.image.create({
      data: {
        image_type: 'message',
        image,
      },
    });
    const imageKey = response?.image_key;
    if (!imageKey) {
      throw new Error('Feishu image upload succeeded without image_key');
    }
    return imageKey;
  }

  async runScopeDiagnostic(): Promise<void> {
    if (!this.client) return;
    try {
      const client = this.client as unknown as {
        request?: (payload: {
          method: string;
          url: string;
          params?: Record<string, string>;
        }) => Promise<{
          code?: number;
          msg?: string;
          data?: { app?: { scopes?: Array<{ scope?: string }> } };
        }>;
      };
      if (!client.request) return;
      const response = await client.request({
        method: 'GET',
        url: '/open-apis/application/v6/applications/me',
        params: { lang: 'zh_cn' },
      });
      if (response.code !== 0) {
        console.warn(`[feishu-adapter] Scope diagnostic unavailable: ${response.msg || response.code}`);
        return;
      }
      const scopes = response.data?.app?.scopes?.map((item) => item.scope).filter(isNonEmptyString) || [];
      const missingScopes = findMissingAppScopes(scopes);
      console.log(`[feishu-adapter] Scope diagnostic: ${scopes.length} app scope(s) visible`);
      if (missingScopes.length > 0) {
        console.warn(
          `[feishu-adapter] Missing recommended app scopes: ${missingScopes.join(', ')}. ` +
          '消息收发、群改名、流式卡片或 typing 可能受影响。',
        );
      }
    } catch (error) {
      console.warn('[feishu-adapter] Scope diagnostic failed:', error instanceof Error ? error.message : error);
    }
  }

  getAuthorizationUrl(appId: string, redirectUri: string, state?: string): string {
    const params = new URLSearchParams({
      app_id: appId,
      redirect_uri: redirectUri,
      state: state || 'agents-to-im',
      scope: 'im:message im:message:send_as_bot',
    });
    return `https://open.feishu.cn/open-apis/authen/v1/authorize?${params.toString()}`;
  }

  async exchangeCodeForToken(appId: string, appSecret: string, code: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    // First get app_access_token
    const appTokenResponse = await fetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const appTokenData = await appTokenResponse.json() as { app_access_token?: string };
    if (!appTokenData.app_access_token) {
      throw new Error('Failed to get app_access_token');
    }

    // Exchange code for user_access_token
    const response = await fetch('https://open.feishu.cn/open-apis/authen/v1/oidc/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appTokenData.app_access_token}`,
      },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });
    const data = await response.json() as {
      code?: number;
      data?: {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
    };
    if (data.code !== 0 || !data.data?.access_token) {
      throw new Error(`Failed to exchange code: ${data.code}`);
    }

    return {
      accessToken: data.data.access_token,
      refreshToken: data.data.refresh_token || '',
      expiresIn: data.data.expires_in || 7200,
    };
  }

  async refreshAccessToken(appId: string, appSecret: string, refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    // First get app_access_token
    const appTokenResponse = await fetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const appTokenData = await appTokenResponse.json() as { app_access_token?: string };
    if (!appTokenData.app_access_token) {
      throw new Error('Failed to get app_access_token');
    }

    const response = await fetch('https://open.feishu.cn/open-apis/authen/v1/oidc/refresh_access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appTokenData.app_access_token}`,
      },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    const data = await response.json() as {
      code?: number;
      data?: {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
    };
    if (data.code !== 0 || !data.data?.access_token) {
      throw new Error(`Failed to refresh token: ${data.code}`);
    }

    return {
      accessToken: data.data.access_token,
      refreshToken: data.data.refresh_token || refreshToken,
      expiresIn: data.data.expires_in || 7200,
    };
  }

  private async enqueueMessage<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.outboundMessageQueues.get(chatId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => {}).then(() => current);
    this.outboundMessageQueues.set(chatId, queued);

    await previous.catch(() => {});
    try {
      const lastSentAt = this.lastOutboundMessageAt.get(chatId) || 0;
      const elapsed = Date.now() - lastSentAt;
      const minIntervalMs = 50;
      if (elapsed < minIntervalMs) {
        await new Promise((resolve) => setTimeout(resolve, minIntervalMs - elapsed));
      }
      const result = await task();
      this.lastOutboundMessageAt.set(chatId, Date.now());
      return result;
    } finally {
      release();
      const pending = this.outboundMessageQueues.get(chatId);
      if (pending === queued) {
        this.outboundMessageQueues.delete(chatId);
      }
    }
  }
}
