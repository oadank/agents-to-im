import type { ChannelAddress, SendResult } from '../../bridge/types.js';
import { buildSimpleCard, buildStreamingCardSkeleton } from '../cards/index.js';
import { STREAM_ELEMENT_ID, STREAM_PLACEHOLDER_TEXT } from '../constants.js';
import { LarkClient } from '../lark-client.js';
import type { PreviewArtifact } from '../types.js';
import type { AgentDividerInfo } from '../../bridge/markdown/feishu.js';
import {
  assertLarkOk,
  previewKey,
  routeKeyForAddress,
} from '../utils.js';

export class PreviewService {
  readonly previewArtifacts = new Map<string, PreviewArtifact>();
  readonly activePreviewByRoute = new Map<string, string>();

  constructor(
    private readonly larkClient: LarkClient,
    private readonly getReplyToMessageId: (routeKey: string) => string | undefined,
    private readonly getDividerInfo?: (address: ChannelAddress) => AgentDividerInfo | undefined,
  ) {}

  reset(): void {
    this.previewArtifacts.clear();
    this.activePreviewByRoute.clear();
  }

  getActiveArtifact(address: ChannelAddress): PreviewArtifact | null {
    const key = this.activePreviewByRoute.get(routeKeyForAddress(address));
    return key ? this.previewArtifacts.get(key) || null : null;
  }

  async sendPreview(
    address: ChannelAddress,
    text: string,
    draftId: number,
  ): Promise<'sent' | 'skip' | 'degrade'> {
    const client = this.larkClient.getClient();
    if (!client) return 'skip';
    const routeKey = routeKeyForAddress(address);
    const key = previewKey(routeKey, draftId);
    let artifact = this.previewArtifacts.get(key);
    const dividerInfo = this.getDividerInfo?.(address);
    console.log(`[preview-service] sendPreview: key=${key}, exists=${!!artifact}, total=${this.previewArtifacts.size}`);
    if (!artifact) {
      const createdArtifact = await this.createPreviewArtifact(address, draftId, text);
      if (!createdArtifact) return 'degrade';
      artifact = createdArtifact;
      this.previewArtifacts.set(key, artifact);
      this.activePreviewByRoute.set(routeKey, key);
    }

    try {
      if (artifact.mode === 'cardkit' && artifact.cardId) {
        artifact.sequence += 1;
        const response = await client.cardkit.v1.cardElement.content({
          path: { card_id: artifact.cardId, element_id: STREAM_ELEMENT_ID },
          data: {
            content: text,
            sequence: artifact.sequence,
          },
        });
        assertLarkOk(response, 'cardkit.cardElement.content');
      } else if (artifact.messageId) {
        await this.larkClient.patchCard(artifact.messageId, buildSimpleCard(text, dividerInfo));
      }
      artifact.lastText = text;
      artifact.streamed = true;
      return 'sent';
    } catch (error) {
      if (artifact.mode === 'cardkit' && artifact.messageId) {
        artifact.mode = 'patch';
        try {
          await this.larkClient.patchCard(artifact.messageId, buildSimpleCard(text, dividerInfo));
          artifact.lastText = text;
          artifact.streamed = true;
          return 'sent';
        } catch {
          console.warn('[feishu-adapter] Preview degraded after CardKit failure:', error);
        }
      }
      return 'degrade';
    }
  }

  async primePreview(address: ChannelAddress, draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    if (!this.larkClient.getClient()) return 'skip';
    const routeKey = routeKeyForAddress(address);
    const key = previewKey(routeKey, draftId);
    if (this.previewArtifacts.has(key)) {
      return 'sent';
    }
    const createdArtifact = await this.createPreviewArtifact(address, draftId, '');
    if (!createdArtifact) return 'degrade';
    this.previewArtifacts.set(key, createdArtifact);
    this.activePreviewByRoute.set(routeKey, key);
    return 'sent';
  }

  endPreview(address: ChannelAddress, draftId: number, finalText?: string): void {
    const routeKey = routeKeyForAddress(address);
    const key = previewKey(routeKey, draftId);
    const artifact = this.previewArtifacts.get(key);
    this.previewArtifacts.delete(key);
    if (this.activePreviewByRoute.get(routeKey) === key) {
      this.activePreviewByRoute.delete(routeKey);
    }
    // Close streaming_mode and update summary with actual message preview text
    // so the chat list shows the message preview instead of "[生成中...]"
    if (artifact?.cardId && artifact.mode === 'cardkit') {
      const client = this.larkClient.getClient();
      if (client) {
        artifact.sequence += 1;
        const text = finalText || artifact.lastText || '';
        const summaryText = text.length > 120 ? text.slice(0, 120) : text;
        client.cardkit.v1.card.settings({
          path: { card_id: artifact.cardId },
          data: {
            settings: JSON.stringify({
              streaming_mode: false,
              summary: { content: summaryText || '✅ 回答完成' },
            }),
            sequence: artifact.sequence,
          },
        }).catch((err) => {
          console.warn('[feishu-adapter] Failed to close streaming mode:', err);
        });
      }
    }
  }

  async finalizePreview(address: ChannelAddress, _finalText: string, draftId?: number): Promise<SendResult | null> {
    const client = this.larkClient.getClient();
    const dividerInfo = this.getDividerInfo?.(address);
    // Find the correct artifact
    let artifact: PreviewArtifact | null = null;
    if (draftId) {
      const routeKey = routeKeyForAddress(address);
      const key = previewKey(routeKey, draftId);
      artifact = this.previewArtifacts.get(key) || null;
    }
    if (!artifact) artifact = this.getActiveArtifact(address);
    console.log(`[preview-service] finalizePreview: draftId=${draftId}, found=${!!artifact}, activeRoute=${this.activePreviewByRoute.get(routeKeyForAddress(address)) || 'none'}, total=${this.previewArtifacts.size}`);
    if (!client || !artifact?.messageId) return null;
    try {
      if (artifact.mode === 'cardkit' && artifact.cardId) {
        // Only close streaming mode — the card already has the accumulated text
        artifact.sequence += 1;
        const settingsResponse = await client.cardkit.v1.card.settings({
          path: { card_id: artifact.cardId },
          data: {
            settings: JSON.stringify({ streaming_mode: false }),
            sequence: artifact.sequence,
          },
        });
        assertLarkOk(settingsResponse, 'cardkit.card.settings');
      } else if (artifact.messageId) {
        // Fallback: patch card with final text
        await this.larkClient.patchCard(artifact.messageId, buildSimpleCard(_finalText, dividerInfo));
      }
      artifact.lastText = _finalText;
      artifact.streamed = true;
      return { ok: true, messageId: artifact.messageId, openMessageId: artifact.messageId };
    } catch (error) {
      console.warn('[feishu-adapter] Failed to finalize preview in place:', error);
      return null;
    }
  }

  private async createPreviewArtifact(
    address: ChannelAddress,
    draftId: number,
    text: string,
  ): Promise<PreviewArtifact | null> {
    const client = this.larkClient.getClient();
    if (!client) return null;
    const routeKey = routeKeyForAddress(address);
    const replyToMessageId = this.getReplyToMessageId(routeKey);
    const dividerInfo = this.getDividerInfo?.(address);
    console.log(`[preview-service] createPreviewArtifact: chatId=${address.chatId}, draftId=${draftId}, existingArtifacts=${this.previewArtifacts.size}`);
    try {
      const createResponse = await client.cardkit.v1.card.create({
        data: {
          type: 'card_json',
          data: JSON.stringify(buildStreamingCardSkeleton(dividerInfo)),
        },
      });
      assertLarkOk(createResponse, 'cardkit.card.create');
      const cardId = createResponse.data?.card_id;
      if (!cardId) throw new Error('CardKit create succeeded without card_id');
      const sendResponse = await this.larkClient.sendMessage(
        address,
        'interactive',
        JSON.stringify({
          type: 'card',
          data: { card_id: cardId },
        }),
        replyToMessageId,
      );
      assertLarkOk(sendResponse, 'im.message.sendCardByCardId');
      const messageId = sendResponse.data?.message_id;
      if (!messageId) throw new Error('CardKit send succeeded without message_id');
      return {
        key: previewKey(routeKey, draftId),
        routeKey,
        chatId: address.chatId,
        draftId,
        replyToMessageId,
        messageId,
        cardId,
        lastText: text,
        sequence: 0,
        mode: 'cardkit',
        streamed: false,
        streamStartedAt: Date.now(),
      };
    } catch (error) {
      console.warn('[feishu-adapter] CardKit preview unavailable, falling back to message patch:', error);
      try {
        const fallbackText = text.trim() ? text : STREAM_PLACEHOLDER_TEXT;
        const sendResult = await this.larkClient.sendCard(
          address,
          buildSimpleCard(fallbackText, dividerInfo),
          replyToMessageId,
        );
        return {
          key: previewKey(routeKey, draftId),
          routeKey,
          chatId: address.chatId,
          draftId,
          replyToMessageId,
          messageId: sendResult.messageId,
          lastText: text,
          sequence: 0,
          mode: 'patch',
          streamed: false,
          streamStartedAt: Date.now(),
        };
      } catch (fallbackError) {
        console.warn('[feishu-adapter] Preview fallback failed:', fallbackError);
        return null;
      }
    }
  }
}
