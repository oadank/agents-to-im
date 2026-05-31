import type { InboundMessage } from '../../bridge/types.js';
import { loadConfig } from '../../config/config.js';
import { compactConversation, applyCompactResult } from '../../bridge/compact.js';
import type {
  AdapterContext,
  FeishuMessageEventData,
  SenderIdentity,
} from '../types.js';
import { buildRouteKey, parseImageResourceKey, parseTextContent, parseAudioFileKey } from '../utils.js';
import { pendingInboundImageKey } from '../utils.js';

export async function handleIncomingEvent(
  ctx: AdapterContext,
  data: FeishuMessageEventData,
): Promise<void> {
  const messageId = data.message.message_id;
  if (data.sender.sender_type === 'app') return;
  if (!ctx.markSeenMessage(messageId)) return;

  const sender = extractSenderIdentity(data);
  if (!sender || !ctx.isAuthorized(sender.id, data.message.chat_id)) {
    console.warn(
      `[feishu-adapter] Dropped inbound message ${messageId}: unauthorized or sender identity missing ` +
      `(chat=${data.message.chat_id})`,
    );
    return;
  }

  const threadId = data.message.thread_id || undefined;
  const routeKey = buildRouteKey(data.message.chat_id, threadId);
  ctx.setLastIncomingMessageId(routeKey, messageId);
  console.log(
    `[feishu-adapter] Inbound message ${messageId} chat=${data.message.chat_id}` +
    `${threadId ? ` thread=${threadId}` : ''} type=${data.message.message_type} chatType=${data.message.chat_type}`,
  );

  await ctx.enqueueChatTask(routeKey, async () => {
    ctx.prunePendingInboundImages();
    const inbound: InboundMessage = {
      messageId,
      address: {
        channelType: ctx.channelType,
        channelInstanceId: ctx.profileId,
        chatId: data.message.chat_id,
        userId: sender.id,
        ...(threadId ? { threadId } : {}),
      },
      text: '',
      timestamp: Number(data.message.create_time || Date.now()),
      raw: {
        rootId: data.message.root_id,
        parentId: data.message.parent_id,
        threadId,
        messageType: data.message.message_type,
      },
    };

    if (data.message.message_type === 'image') {
      const imageKey = parseImageResourceKey(data.message.content);
      const pendingKey = pendingInboundImageKey(
        data.message.chat_id,
        sender.id,
        messageId,
        threadId,
      );
      if (!imageKey) {
        ctx.setPendingInboundImage({
          key: pendingKey,
          chatId: data.message.chat_id,
          threadId,
          senderId: sender.id,
          messageId,
          createdAt: Date.now(),
          errorMessage: '这张图片的资源标识缺失，请重新发送图片后再直接回复文字。',
        });
        await ctx.sendAsPost(
          inbound.address,
          '已收到图片，但读取图片资源失败。请重新发送图片后，再直接回复这张图片补充文字。',
          messageId,
        );
        return;
      }
      try {
        const attachment = await ctx.downloadInboundImageAttachment(messageId, imageKey);
        ctx.setPendingInboundImage({
          key: pendingKey,
          chatId: data.message.chat_id,
          threadId,
          senderId: sender.id,
          messageId,
          createdAt: Date.now(),
          attachments: [attachment],
        });
        await ctx.sendAsPost(
          inbound.address,
          '已收到图片。请直接回复这张图片本身补充文字，我会把图文一起发给模型。',
          messageId,
        );
      } catch (error) {
        const errorMessage = `这张图片下载失败，请重新发送图片后再直接回复文字。${
          error instanceof Error && error.message ? `\n原因：${error.message}` : ''
        }`;
        ctx.setPendingInboundImage({
          key: pendingKey,
          chatId: data.message.chat_id,
          threadId,
          senderId: sender.id,
          messageId,
          createdAt: Date.now(),
          errorMessage,
        });
        console.warn('[feishu-adapter] Failed to download inbound image:', error);
        await ctx.sendAsPost(inbound.address, errorMessage, messageId);
      }
      return;
    }


    // 语音消息处理
    if (data.message.message_type === 'audio') {
      const fileKey = parseAudioFileKey(data.message.content);
      if (!fileKey) {
        await ctx.sendAsPost(
          inbound.address,
          '已收到语音消息，但读取语音文件失败。请重新发送语音。',
          messageId,
        );
        return;
      }
      try {
        console.log(`[feishu-adapter] Transcribing audio ${messageId} file_key=${fileKey}`);
        const result = await ctx.downloadAndTranscribe(messageId, fileKey);
        const transcribedText = result.text.trim();
        if (!transcribedText) {
          await ctx.sendAsPost(
            inbound.address,
            '语音转写失败。请重新发送语音或直接发文字。',
            messageId,
          );
          return;
        }
        console.log(`[feishu-adapter] Audio transcribed: "${transcribedText}"`);
        await ctx.sendAsPost(
          inbound.address,
          `语音转写：${transcribedText}`,
          messageId,
        );
        // 把转写文本当作普通文本继续处理，并标记来源为语音
        inbound.text = transcribedText;
        inbound.fromAudio = true; // 标记消息来源为语音，用于触发语音回复
        data.message.message_type = 'text';
        // 标记此 chat 需要语音回复
        ctx.setPendingAudioReply(data.message.chat_id, true);
        console.log(`[feishu-adapter] Audio converted to text (fromAudio=true), continuing processing...`);
      } catch (error) {
        console.warn('[feishu-adapter] Audio transcription failed:', error);
        await ctx.sendAsPost(
          inbound.address,
          `语音转写失败：${error instanceof Error ? error.message : String(error)}`,
          messageId,
        );
        return;
      }
    }

    // 支持 text 和 post（富文本）类型消息
    if (data.message.message_type !== 'text' && data.message.message_type !== 'post') {
      console.warn(
        `[feishu-adapter] Dropped inbound message ${messageId}: unsupported message type ` +
        `(type=${data.message.message_type}, content=${data.message.content.slice(0, 200)})`,
      );
      return;
    }

    // 用户主动发文本消息时，清除语音回复标记（退出语音模式）
    if (data.message.message_type === 'text' && !inbound.fromAudio) {
      ctx.clearPendingAudioReply(data.message.chat_id);
      console.log(`[feishu-adapter] User sent text message, clearing audio reply mode for chat ${data.message.chat_id}`);
    }

    // 如果已有转写文本（语音），跳过 parseTextContent
    if (!inbound.text) {
      inbound.text = parseTextContent(data.message.content);
    }
    if (!inbound.text) {
      console.warn(
        `[feishu-adapter] Dropped inbound message ${messageId}: empty parsed text ` +
        `(type=${data.message.message_type}, content=${data.message.content.slice(0, 200)})`,
      );
      return;
    }

    // 用户主动发文本消息时，退出语音回复模式
    // 注意：语音转写的文本 inbound.fromAudio=true，不应退出语音模式
    if (!inbound.fromAudio) {
      ctx.setPendingAudioReply(data.message.chat_id, false);
      console.log(`[feishu-adapter] User sent text message, clearing audio reply mode for chat ${data.message.chat_id}`);
    }

    const referencedImages = ctx.resolveReferencedInboundImages(
      data.message.chat_id,
      sender.id,
      threadId,
      [data.message.parent_id, data.message.root_id],
    );
    if (referencedImages.errorMessage) {
      await ctx.sendAsPost(inbound.address, referencedImages.errorMessage, messageId);
      return;
    }
    if (referencedImages.attachments?.length) {
      inbound.attachments = referencedImages.attachments;
    } else {
      // Fallback: 当 parent_id/root_id 无法匹配时（如"先发图片再发文字"非回复场景），
      // 查找同一 chat + sender 下最近一条 pending image
      const fallbackImage = ctx.resolveLatestPendingImageForChat(
        data.message.chat_id,
        sender.id,
        threadId,
      );
      if (fallbackImage?.errorMessage) {
        await ctx.sendAsPost(inbound.address, fallbackImage.errorMessage, messageId);
        return;
      }
      if (fallbackImage?.attachments?.length) {
        inbound.attachments = fallbackImage.attachments;
      }
    }

    // Ingest to memory_tree if OpenHuman runtime is configured
    // Check if this instance is configured for OpenHuman
    const defaultRuntime = process.env.CTI_DEFAULT_RUNTIME || '';
    if (defaultRuntime === 'openhuman' && inbound.text.trim()) {
      // Fire-and-forget ingest (don't block message processing)
      ctx.ingestToMemoryTree(
        data.message.chat_id,
        sender.id,
        inbound.text,
        messageId,
      ).catch((err) => {
        console.warn('[feishu-adapter] memory_tree ingest error (non-blocking):', err);
      });
    }

    if (data.message.chat_type === 'p2p') {
      console.log(`[feishu-adapter] Routing to handleDirectMessage, text="${inbound.text}"`);
      await handleDirectMessage(ctx, sender, inbound);
      return;
    }
    console.log(`[feishu-adapter] Routing to handleGroupMessage, text="${inbound.text}"`);
    await handleGroupMessage(ctx, sender, inbound);
  });
}

export async function handleDirectMessage(
  ctx: AdapterContext,
  sender: SenderIdentity,
  inbound: InboundMessage,
): Promise<void> {
  const command = inbound.text.trim().toLowerCase();
  if (command === '/new:claude') {
    await ctx.handleCreateSessionCommand(sender, inbound, 'claude');
    return;
  }
  if (command === '/new:codex') {
    await ctx.handleCreateSessionCommand(sender, inbound, 'codex');
    return;
  }
  if (command === '/new:openhuman') {
    await ctx.handleCreateSessionCommand(sender, inbound, 'openhuman');
    return;
  }
  if (command === '/resume:claude') {
    await ctx.handleResumeSessionCommand(sender, inbound, 'claude');
    return;
  }
  if (command === '/resume:codex') {
    await ctx.handleResumeSessionCommand(sender, inbound, 'codex');
    return;
  }
  if (command === '/resume:openhuman') {
    await ctx.handleResumeSessionCommand(sender, inbound, 'openhuman');
    return;
  }
  if (command === '/stop') {
    const store = ctx.getStore();
    const binding = store.getChannelBinding(ctx.channelType, inbound.address.chatId, ctx.profileId);
    if (!binding) {
      await ctx.sendAsPost(inbound.address, '当前没有活跃会话。', inbound.messageId);
      return;
    }
    ctx.enqueue(inbound);
    return;
  }

  if (command === '/compact') {
    const store = ctx.getStore();
    const binding = store.getChannelBinding(ctx.channelType, inbound.address.chatId, ctx.profileId);
    if (!binding) {
      await ctx.sendAsPost(inbound.address, '当前没有活跃会话，请先发送消息创建会话。', inbound.messageId);
      return;
    }
    const sessionId = binding.codepilotSessionId;
    if (!sessionId) {
      await ctx.sendAsPost(inbound.address, '当前没有活跃会话。', inbound.messageId);
      return;
    }
    await ctx.sendAsPost(inbound.address, '⏳ 正在压缩上下文，请稍候…', inbound.messageId);
    const config = loadConfig();
    const result = await compactConversation(store, sessionId, config.compact);
    if (result.success) {
      applyCompactResult(store, sessionId, result);
      store.updateSdkSessionId(sessionId, '');
      console.log(`[feishu-adapter] /compact: 压缩完成，${result.originalCount} 条消息 → 摘要`);
      await ctx.sendAsPost(inbound.address, `✅ 上下文已压缩（${result.originalCount} 条消息 → 摘要）。下一条消息将使用压缩后的上下文。`, inbound.messageId);
    } else {
      console.warn(`[feishu-adapter] /compact 失败: ${result.error}`);
      await ctx.sendAsPost(inbound.address, `❌ 压缩失败: ${result.error}`, inbound.messageId);
    }
    return;
  }

  // 私聊非命令消息：尝试恢复最近的会话，或自动创建新会话
  const store = ctx.getStore();
  const existingBinding = store.getChannelBinding(ctx.channelType, inbound.address.chatId, ctx.profileId);

  // 如果已有绑定，直接处理消息
  if (existingBinding) {
    ctx.enqueue(inbound);
    return;
  }

  // 没有绑定，自动创建新会话并绑定私聊本身（不创建新群聊）
  const config = loadConfig();
  const defaultRuntime = config.defaultRuntime || 'claude';
  console.log(`[feishu-adapter] No existing binding found for p2p chat, auto-creating session with runtime=${defaultRuntime}`);
  try {
    await ctx.ensureRuntimeAvailable(defaultRuntime);
    const session = store.createRuntimeSession({
      runtime: defaultRuntime,
      model: '',
      cwd: store.getSetting('bridge_default_work_dir') || process.cwd(),
    });
    // 直接绑定私聊本身，不创建新群聊
    store.upsertChannelBinding({
      channelType: ctx.channelType,
      channelInstanceId: ctx.profileId,
      chatId: inbound.address.chatId,  // 使用私聊的 chatId
      codepilotSessionId: session.id,
      workingDirectory: session.working_directory,
      model: session.model,
      chatType: 'p2p',
      mode: 'code',
      active: true,
    });
    console.log(`[feishu-adapter] Created and bound session ${session.id} (runtime=${defaultRuntime}) to p2p chat ${inbound.address.chatId}`);
  } catch (error) {
    console.error('[feishu-adapter] Failed to auto-create session:', error);
    await ctx.sendAsPost(
      inbound.address,
      `自动创建会话失败：${error instanceof Error ? error.message : String(error)}`,
      inbound.messageId,
    );
    return;
  }
  ctx.enqueue(inbound);
  return;
}

export async function handleGroupMessage(
  ctx: AdapterContext,
  _sender: SenderIdentity,
  inbound: InboundMessage,
): Promise<void> {
  const store = ctx.getStore();
  const text = inbound.text.trim();
  const lower = text.toLowerCase();
  const binding = store.getChannelBinding(ctx.channelType, inbound.address.chatId, ctx.profileId);
  const workflow = binding ? store.getActivePlanWorkflowByBinding(binding.id) : null;

  if (lower === '/reset') {
    await ctx.handleResetCommand(inbound.address, inbound.messageId);
    return;
  }
  if (lower === '/stop') {
    if (!binding) {
      await ctx.sendAsPost(inbound.address, '当前群尚未绑定会话。请先私聊 Bot 发送 `/new:claude` 或 `/new:codex`。', inbound.messageId);
      return;
    }
    ctx.enqueue(inbound);
    return;
  }
  if (lower.startsWith('/mode')) {
    if (!binding) {
      await ctx.sendAsPost(inbound.address, '当前群尚未绑定会话。请先私聊 Bot 发送 `/new:claude` 或 `/new:codex`。', inbound.messageId);
      return;
    }
    await ctx.handleModeCommand(binding.id, text, inbound.address, inbound.messageId);
    return;
  }
  if (lower === '/plan' || lower.startsWith('/plan ')) {
    if (!binding) {
      await ctx.sendAsPost(inbound.address, '当前群尚未绑定会话。请先私聊 Bot 发送 `/new:claude` 或 `/new:codex`。', inbound.messageId);
      return;
    }
    await ctx.handlePlanCommand(binding.id, inbound);
    return;
  }
  if (lower === '/compact') {
    if (!binding) {
      await ctx.sendAsPost(inbound.address, '当前群尚未绑定会话。', inbound.messageId);
      return;
    }
    const store2 = ctx.getStore();
    const binding2 = store2.getChannelBinding(ctx.channelType, inbound.address.chatId, ctx.profileId);
    if (binding2) {
      const sid2 = binding2.codepilotSessionId;
      if (sid2) {
        await ctx.sendAsPost(inbound.address, '⏳ 正在压缩上下文，请稍候…', inbound.messageId);
        const config2 = loadConfig();
        const result2 = await compactConversation(store2, sid2, config2.compact);
        if (result2.success) {
          applyCompactResult(store2, sid2, result2);
          store2.updateSdkSessionId(sid2, '');
          console.log(`[feishu-adapter] /compact: 压缩完成，${result2.originalCount} 条消息 → 摘要`);
          await ctx.sendAsPost(inbound.address, `✅ 上下文已压缩（${result2.originalCount} 条消息 → 摘要）。下一条消息将使用压缩后的上下文。`, inbound.messageId);
        } else {
          console.warn(`[feishu-adapter] /compact 失败: ${result2.error}`);
          await ctx.sendAsPost(inbound.address, `❌ 压缩失败: ${result2.error}`, inbound.messageId);
        }
      }
    }
    return;
  }
  if (lower.startsWith('/new')) {
    await ctx.sendAsPost(inbound.address, '请先私聊 Bot 使用 `/new:claude` 或 `/new:codex` 创建新会话。', inbound.messageId);
    return;
  }
  if (lower.startsWith('/')) {
    await ctx.sendAsPost(inbound.address, '该群仅支持普通对话、`/plan`、`/mode`、`/stop`、`/reset`。权限请求请直接使用卡片按钮处理；如需新会话，请私聊 Bot。', inbound.messageId);
    return;
  }

  if (!binding) {
    await ctx.sendAsPost(inbound.address, '当前群尚未绑定会话。请先私聊 Bot 发送 `/new:claude` 或 `/new:codex`。', inbound.messageId);
    return;
  }
  if (workflow) {
    const consumed = await ctx.handlePlanWorkflowMessage(binding.id, workflow.workflowId, inbound);
    if (consumed) return;
  }
  ctx.enqueue(inbound);
}

function extractSenderIdentity(data: FeishuMessageEventData): SenderIdentity | null {
  const senderId = data.sender.sender_id;
  if (senderId?.open_id) return { id: senderId.open_id, type: 'open_id' };
  if (senderId?.user_id) return { id: senderId.user_id, type: 'user_id' };
  if (senderId?.union_id) return { id: senderId.union_id, type: 'union_id' };
  return null;
}
