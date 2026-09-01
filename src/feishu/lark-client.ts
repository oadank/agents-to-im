import { randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
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

export class LarkClient {
  readonly outboundMessageQueues = new Map<string, Promise<void>>();
  readonly lastOutboundMessageAt = new Map<string, number>();

  private client: lark.Client | null = null;
  private appId = '';
  private appSecret = '';
  private domain = 'https://open.feishu.cn';

  constructor() {
    // Removed user token loading - now using lark-cli for user identity
  }

  getClient(): lark.Client | null {
    return this.client;
  }

  setClient(client: lark.Client | null, appId?: string, appSecret?: string, domain?: string): void {
    this.client = client;
    if (appId) this.appId = appId;
    if (appSecret) this.appSecret = appSecret;
    if (domain) this.domain = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
    if (!client) {
      this.outboundMessageQueues.clear();
      this.lastOutboundMessageAt.clear();
    }
  }

  getUserAccessToken(): string | null {
    // Now handled by lark-cli, always return null
    return null;
  }

  setUserAccessToken(token: string, refreshToken?: string, expiresIn?: number): void {
    // Now handled by lark-cli, do nothing
    console.warn('[lark-client] setUserAccessToken deprecated, use lark-cli for token management');
  }

  clearUserAccessToken(): void {
    // Now handled by lark-cli, do nothing
    console.warn('[lark-client] clearUserAccessToken deprecated, use lark-cli for token management');
  }

  private loadUserToken(): void {
    // Removed - now using lark-cli for token management
  }

  private saveUserToken(): void {
    // Removed - now using lark-cli for token management
  }

  async sendMessage(
    address: ChannelAddress,
    msgType: 'interactive' | 'post' | 'image' | 'media',
    content: string,
    replyToMessageId?: string,
    requestUuid?: string,
    useUserToken?: boolean,
  ): Promise<LarkMessageResponse> {
    // When useUserToken is true, delegate to lark-cli which manages its own token
    if (useUserToken) {
      return this.sendMessageViaLarkCli(address, msgType, content, replyToMessageId);
    }

    if (!this.client) {
      throw new Error('Feishu client not initialized');
    }

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
            undefined,
          );
        } catch (error) {
          const axiosError = error as { response?: { data?: { code?: number } } };
          if (axiosError.response?.data?.code === 230011) {
            console.warn('[feishu-adapter] Reply message was withdrawn, falling back to create new message');
            const receiveId = address.threadId || address.chatId;
            const receiveIdType = (address.threadId ? 'thread_id' : 'chat_id') as 'thread_id' | 'chat_id';
            return (this.client!.im.message.create as Function)(
              {
                params: { receive_id_type: receiveIdType as never },
                data: {
                  receive_id: receiveId,
                  msg_type: msgType,
                  content,
                  uuid: randomUUID().slice(0, 50),
                },
              },
              undefined,
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
        undefined,
      );
    });
  }

  private sendMessageViaLarkCli(
    address: ChannelAddress,
    msgType: 'interactive' | 'post' | 'image',
    content: string,
    replyToMessageId?: string,
  ): Promise<LarkMessageResponse> {
    return new Promise((resolve, reject) => {
      const chatId = address.threadId || address.chatId;
      // lark-cli supports --chat-id and --text. For interactive/post, we pass content as text.
      // For image, fall back to bot mode (lark-cli doesn't support image send easily)
      if (msgType === 'image') {
        reject(new Error('Image messages not supported via lark-cli, use bot mode'));
        return;
      }

      const escapedContent = content.replace(/"/g, '\\"');
      const cmd = `lark-cli im +messages-send --chat-id "${chatId}" --text "${escapedContent}"`;

      exec(cmd, { timeout: 15000, windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          console.warn('[lark-client] lark-cli send failed, falling back to SDK:', stderr?.slice(0, 500));
          // Fallback: send via bot mode if lark-cli fails
          this.sendMessage(address, msgType, content, replyToMessageId, undefined, false)
            .then(resolve)
            .catch(reject);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.ok && parsed.data?.message_id) {
            resolve({
              code: 0,
              msg: 'ok',
              data: {
                message_id: parsed.data.message_id,
                open_message_id: parsed.data.open_message_id || '',
              },
            });
          } else {
            reject(new Error(`lark-cli error: ${JSON.stringify(parsed)}`));
          }
        } catch {
          reject(new Error(`lark-cli returned non-JSON: ${stdout?.slice(0, 200)}`));
        }
      });
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
    // 原生 HTTP 直调飞书 API：SDK 的 im.message.patch 存在"返回 code=0 但卡片实际未更新"的兼容问题
    // （2026-08-06 实测：SDK patch 后 lark-cli 看卡片内容未变；原生 HTTP 同一请求成功）。
    if (!this.appId || !this.appSecret) {
      throw new Error('Feishu app credentials not configured for patchCard');
    }
    // 获取 tenant_access_token
    const authResp = await fetch(`${this.domain}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const authJson = await authResp.json() as { code?: number; tenant_access_token?: string; msg?: string };
    if (authJson.code !== 0 || !authJson.tenant_access_token) {
      throw new Error(`feishu token error: code=${authJson.code} msg=${authJson.msg}`);
    }
    const token = authJson.tenant_access_token;
    // PATCH 更新卡片：URL 直接放 message_id，不带 message_id_type query（实测必需）
    const resp = await fetch(`${this.domain}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ content: JSON.stringify(card) }),
    });
    const json = await resp.json() as { code?: number; msg?: string };
    console.log(`[feishu-adapter] patchCard(HTTP) id=${messageId} -> code=${json.code} msg=${json.msg || ''}`);
    assertLarkOk(json, 'im.message.patch(HTTP)');
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

  async uploadFile(filePath: string, fileType: string): Promise<string> {
    if (!this.client) {
      throw new Error('Feishu client not initialized');
    }
    const file = fs.readFileSync(filePath);
    const response = await this.client.im.file.create({
      data: {
        file_type: fileType,
        file,
      },
    });
    const fileKey = response?.file_key;
    if (!fileKey) {
      throw new Error('Feishu file upload succeeded without file_key');
    }
    return fileKey;
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
