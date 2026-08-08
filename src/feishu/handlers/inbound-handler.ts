import type { InboundMessage, ChannelBinding } from '../../bridge/types.js';
import { loadConfig } from '../../config/config.js';
import { compactConversation, applyCompactResult } from '../../bridge/compact.js';
import { interruptActiveTask, isSessionBusy } from '../../bridge/bridge-manager.js';
import { buildInterruptCard } from '../cards/index.js';
import type {
  AdapterContext,
  FeishuMessageEventData,
  SenderIdentity,
} from '../types.js';
import { buildRouteKey, parseImageResourceKey, parseTextContent, parseAudioFileKey } from '../utils.js';
import { pendingInboundImageKey } from '../utils.js';
import fs from 'node:fs';

// 实时日志：绕过 NSSM stdout 缓冲，直接写硬盘
const DEBUG_LOG = `C:\\D\\opt\\agents-to-im\\debug_realtime_${process.env.CTI_BOT || 'unknown'}.log`;
function rtLog(msg: string): void {
  const time = new Date().toISOString();
  try {
    fs.appendFileSync(DEBUG_LOG, `[${time}] ${msg}\n`, 'utf-8');
  } catch {}
}

export async function handleIncomingEvent(
  ctx: AdapterContext,
  data: FeishuMessageEventData,
): Promise<void> {
  const messageId = data.message.message_id;
  rtLog(`[STEP1] handleIncomingEvent entered, messageId=${messageId}, chatId=${data.message.chat_id}, senderType=${data.sender?.sender_type}`);
  rtLog(`[STEP1-RAW] data keys: ${Object.keys(data).join(',')}, data.mentions=${JSON.stringify(data.mentions)}, (data as any).message?.mentions=${JSON.stringify((data as any).message?.mentions)}`);
  if (data.sender.sender_type === 'app') {
    rtLog(`[STEP1] sender_type=app, returning`);
    return;
  }
  // Skip stale messages (older than 60s) to prevent reprocessing after PM2 restart
  const messageTime = Number(data.message.create_time || '0') * 1000;
  if (messageTime > 0 && Date.now() - messageTime > 60_000) {
    rtLog(`[STEP1] stale message (age=${Math.floor((Date.now() - messageTime) / 1000)}s), skipping`);
    return;
  }
  const seen = ctx.markSeenMessage(messageId);
  rtLog(`[STEP2] markSeenMessage result=${seen} for messageId=${messageId}`);
  if (!seen) {
    rtLog(`[STEP2] already seen, returning silently`);
    return;
  }

  const sender = extractSenderIdentity(data);
  rtLog(`[STEP3] extractSenderIdentity result: ${sender ? `id=${sender.id}` : 'null'}`);
  if (!sender || !ctx.isAuthorized(sender.id, data.message.chat_id)) {
    rtLog(`[STEP3] unauthorized or sender missing, dropping`);
    console.warn(
      `[feishu-adapter] Dropped inbound message ${messageId}: unauthorized or sender identity missing ` +
      `(chat=${data.message.chat_id})`,
    );
    return;
  }
  rtLog(`[STEP3] authorized OK`);

  const threadId = data.message.thread_id || undefined;
  const routeKey = buildRouteKey(data.message.chat_id, threadId);
  ctx.setLastIncomingMessageId(routeKey, messageId);
  console.log(
    `[feishu-adapter] Inbound message ${messageId} chat=${data.message.chat_id}` +
    `${threadId ? ` thread=${threadId}` : ''} type=${data.message.message_type} chatType=${data.message.chat_type}`,
  );

  rtLog(`[STEP4] Calling enqueueChatTask, routeKey=${routeKey}, msgType=${data.message.message_type}`);
  console.log(`[feishu-adapter] DEBUG: Actual message_type value: "${data.message.message_type}" (length=${data.message.message_type.length})`);
  await ctx.enqueueChatTask(routeKey, async () => {
    rtLog(`[STEP5] enqueueChatTask callback EXECUTED for routeKey=${routeKey}`);
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
        mentions: (data as any).message?.mentions ?? data.mentions,
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
      rtLog(`[VOICE-DEBUG] Starting audio processing for messageId=${messageId}`);
      const fileKey = parseAudioFileKey(data.message.content);
      rtLog(`[VOICE-DEBUG] Parsed fileKey: ${fileKey || 'null'}`);
      if (!fileKey) {
        rtLog(`[VOICE-DEBUG] No fileKey found, sending error message`);
        await ctx.sendAsPost(
          inbound.address,
          '已收到语音消息，但读取语音文件失败。请重新发送语音。',
          messageId,
        );
        rtLog(`[VOICE-DEBUG] Error message sent, returning`);
        return;
      }
      try {
        rtLog(`[VOICE-DEBUG] Calling downloadAndTranscribe with messageId=${messageId}, fileKey=${fileKey}`);
        console.log(`[feishu-adapter] Transcribing audio ${messageId} file_key=${fileKey}`);
        const result = await ctx.downloadAndTranscribe(messageId, fileKey);
        rtLog(`[VOICE-DEBUG] downloadAndTranscribe completed successfully`);
        const transcribedText = result.text.trim();
        rtLog(`[VOICE-DEBUG] Transcribed text length: ${transcribedText.length}`);
        if (transcribedText) {
          console.log(`[feishu-adapter] Audio transcribed: "${transcribedText}"`);
          rtLog(`[VOICE-DEBUG] Sending transcription result: "${transcribedText.substring(0, 50)}..."`);
          await ctx.sendAsPost(
            inbound.address,
            `语音转写：${transcribedText}`,
            messageId,
          );
          rtLog(`[VOICE-DEBUG] Transcription message sent successfully`);
          // 把转写文本当作普通文本继续处理，并标记来源为语音
          inbound.text = transcribedText;
          inbound.fromAudio = true; // 标记消息来源为语音，用于触发语音回复
          data.message.message_type = 'text';
          // 标记此 chat 需要语音回复
          ctx.setPendingAudioReply(data.message.chat_id, true);
          console.log(`[feishu-adapter] Audio converted to text (fromAudio=true), continuing processing...`);
          rtLog(`[VOICE-DEBUG] Audio processing completed, continuing with text processing`);
        } else {
          // 语音转录成功但内容为空
          rtLog(`[VOICE-DEBUG] Audio transcription completed but no content detected`);
          await ctx.sendAsPost(
            inbound.address,
            `语音转写：未识别到语音内容`,
            messageId,
          );
          rtLog(`[VOICE-DEBUG] No-content transcription message sent`);
          // 空内容时不继续处理（不转换为文字输入）
          return;
        }
      } catch (error) {
        rtLog(`[VOICE-DEBUG] downloadAndTranscribe threw error: ${error instanceof Error ? error.message : String(error)}`);
        console.warn('[feishu-adapter] Audio transcription failed:', error);
        await ctx.sendAsPost(
          inbound.address,
          `语音转写失败：${error instanceof Error ? error.message : String(error)}`,
          messageId,
        );
        rtLog(`[VOICE-DEBUG] Error message sent after exception, returning`);
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
    // Strip @mention placeholders (e.g. @_user_1) — replace with mention name
    if (data.mentions && data.mentions.length > 0) {
      for (const mention of data.mentions) {
        if (mention.key && mention.name) {
          inbound.text = inbound.text.replace(mention.key, mention.name);
        } else if (mention.key) {
          inbound.text = inbound.text.replace(mention.key, '').trim();
        }
      }
      inbound.text = inbound.text.replace(/\s+/g, ' ').trim();
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
        if (fallbackImage.key) {
          ctx.deletePendingInboundImage(fallbackImage.key);
        }
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
      rtLog(`[STEP6] Routing to handleDirectMessage, chatType=p2p, text="${inbound.text}"`);
      console.log(`[feishu-adapter] Routing to handleDirectMessage, text="${inbound.text}"`);
      await handleDirectMessage(ctx, sender, inbound);
      rtLog(`[STEP7] handleDirectMessage RETURNED OK`);
      return;
    }
    rtLog(`[STEP6] Routing to handleGroupMessage, chatType=${data.message.chat_type}, text="${inbound.text}"`);
    console.log(`[feishu-adapter] Routing to handleGroupMessage, text="${inbound.text}"`);
    await handleGroupMessage(ctx, sender, inbound);
    rtLog(`[STEP7] handleGroupMessage RETURNED OK`);
  });
}

export async function handleDirectMessage(
  ctx: AdapterContext,
  sender: SenderIdentity,
  inbound: InboundMessage,
): Promise<void> {
  // 命令匹配：只取第一行/第一段（容忍富文本解析出换行+附加内容，如 "/new\n发送自 陈丹的飞书 CLI"）
  const command = inbound.text.trim().toLowerCase().split(/\r?\n/)[0].trim();
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
  if (command === '/new:zcode') {
    await ctx.handleCreateSessionCommand(sender, inbound, 'zcode');
    return;
  }
  if (command === '/new:gemini') {
    await ctx.handleCreateSessionCommand(sender, inbound, 'gemini');
    return;
  }
  if (command === '/new:mimo') {
    await ctx.handleCreateSessionCommand(sender, inbound, 'mimo');
    return;
  }
  if (command === '/new') {
    const runtime = ctx.getDefaultRuntime();
    // 私聊：自动绑定当前对话（不弹卡片、不拉群）
    try {
      await ctx.ensureRuntimeAvailable(runtime);
      const store = ctx.getStore();
      const options: Parameters<typeof ctx.createBoundSession>[2] = {
        // reasonix 用 CTI_REASONIX_ACP_CWD（如 C:\），其他 bot 用 USERPROFILE
        cwd: process.env.CTI_REASONIX_ACP_CWD
          || (process.platform === 'win32' ? (process.env.USERPROFILE || 'C:\\Users\\oadan') : '/opt'),
        bindingMode: 'code',
        existingChatId: inbound.address.chatId,
        skipReadyMessage: true,
      };
      if (runtime === 'claude') {
        options.claudePermissionMode = 'bypassPermissions';
      }
      if (runtime === 'mimo') {
        options.model = store.getSetting('compact_model') || 'MiMo-OpenAI';
      }
      const { binding } = await ctx.createBoundSession(runtime, sender, options);
      console.log(`[feishu-adapter] /new: auto-bound p2p chat ${inbound.address.chatId} runtime=${runtime}`);
      const feedback = `✅ 已新建 ${runtime} 会话｜工作区 \`${binding.workingDirectory}\`｜直接对话即可`;
      await ctx.sendAsPost(inbound.address, feedback, inbound.messageId, true);
    } catch (error) {
      console.error('[feishu-adapter] /new auto-bind failed:', error);
      await ctx.sendAsPost(
        inbound.address,
        `创建会话失败：${error instanceof Error ? error.message : String(error)}`,
        inbound.messageId,
      );
    }
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
  if (command === '/resume:zcode') {
    await ctx.handleResumeSessionCommand(sender, inbound, 'zcode');
    return;
  }
  if (command.startsWith('/agent:')) {
    const agent = command.slice(7).trim();
    const validAgents = ['glm', 'gemini', 'opencode'];
    if (!validAgents.includes(agent)) {
      await ctx.sendAsPost(inbound.address, `不支持的 agent: ${agent}。可用: ${validAgents.join(', ')}`, inbound.messageId);
      return;
    }
    const store = ctx.getStore();
    const binding = store.getChannelBinding(ctx.channelType, inbound.address.chatId, ctx.profileId);
    if (!binding) {
      await ctx.sendAsPost(inbound.address, '当前没有活跃会话，请先发送消息创建会话。', inbound.messageId);
      return;
    }
    store.updateSessionModel(binding.codepilotSessionId, `agent:${agent}`);
    await ctx.sendAsPost(inbound.address, `✅ 已切换到 ${agent}，后续消息将使用该 agent。`, inbound.messageId);
    return;
  }
  if (command.startsWith('/ask:')) {
    const spaceIdx = inbound.text.indexOf(' ');
    if (spaceIdx === -1) {
      await ctx.sendAsPost(inbound.address, '用法: /ask:agent名 你的问题', inbound.messageId);
      return;
    }
    const agent = inbound.text.slice(5, spaceIdx).trim();
    const msg = inbound.text.slice(spaceIdx + 1).trim();
    const validAgents = ['glm', 'gemini', 'opencode'];
    if (!validAgents.includes(agent)) {
      await ctx.sendAsPost(inbound.address, `不支持的 agent: ${agent}。可用: ${validAgents.join(', ')}`, inbound.messageId);
      return;
    }
    const store = ctx.getStore();
    const binding = store.getChannelBinding(ctx.channelType, inbound.address.chatId, ctx.profileId);
    if (!binding) {
      await ctx.sendAsPost(inbound.address, '当前没有活跃会话，请先发送消息创建会话。', inbound.messageId);
      return;
    }
    // 读取对话历史，拼到 prompt 前面
    const { messages } = store.getMessages(binding.codepilotSessionId, { limit: 30 });
    let enrichedPrompt = msg;
    if (messages.length > 0) {
      const history = messages
        .filter((m: { role: string }) => m.role === 'user' || m.role === 'assistant')
        .map((m: { role: string; content: string }) => `[${m.role}]: ${m.content}`)
        .join('\n');
      enrichedPrompt = `以下是之前的对话记录：\n${history}\n\n---\n\n用户: ${msg}`;
    }
    // 设置 model 为 agent:xxx，替换消息文本为 enriched prompt
    store.updateSessionModel(binding.codepilotSessionId, `agent:${agent}`);
    inbound.text = enrichedPrompt;
    ctx.enqueue(inbound);
    return;
  }
  if (command === '/stop') {
    const store = ctx.getStore();
    const binding = store.getChannelBinding(ctx.channelType, inbound.address.chatId, ctx.profileId);
    if (!binding) {
      await ctx.sendAsPost(inbound.address, '当前没有活跃会话。', inbound.messageId, true);
      return;
    }
    const interrupted = interruptActiveTask(binding.codepilotSessionId);
    if (interrupted) {
      await ctx.sendAsPost(inbound.address, '已停止当前任务。', inbound.messageId, true);
    } else {
      await ctx.sendAsPost(inbound.address, '当前没有正在运行的任务。', inbound.messageId, true);
    }
    return;
  }

  if (command === '/compact') {
    const store = ctx.getStore();
    const binding = store.getChannelBinding(ctx.channelType, inbound.address.chatId, ctx.profileId);
    if (!binding) {
      await ctx.sendAsPost(inbound.address, '当前没有活跃会话，请先发送消息创建会话。', inbound.messageId, true);
      return;
    }
    const sessionId = binding.codepilotSessionId;
    if (!sessionId) {
      await ctx.sendAsPost(inbound.address, '当前没有活跃会话。', inbound.messageId, true);
      return;
    }
    await ctx.sendAsPost(inbound.address, '⏳ 正在压缩上下文，请稍候…', inbound.messageId, true);

    // Use global compact config from config.env
    const compactConfig = loadConfig().compact;
    const runtime = store.getSessionExt?.(sessionId)?.runtime || 'claude';

    const result = await compactConversation(store, sessionId, compactConfig, runtime);
    if (result.success) {
      applyCompactResult(store, sessionId, result);
      if (compactConfig.clearSdkSession) {
        store.updateSdkSessionId(sessionId, '');
      }
      console.log(`[feishu-adapter] /compact: 压缩完成，${result.originalCount} 条消息 → 摘要`);
      await ctx.sendAsPost(inbound.address, `✅ 上下文已压缩（${result.originalCount} 条消息 → 摘要）。下一条消息将使用压缩后的上下文。`, inbound.messageId, true);
    } else {
      console.warn(`[feishu-adapter] /compact 失败: ${result.error}`);
      await ctx.sendAsPost(inbound.address, `❌ 压缩失败: ${result.error}`, inbound.messageId, true);
    }
    return;
  }

  // 私聊非命令消息：尝试恢复最近的会话，或自动创建新会话
  const store = ctx.getStore();
  const existingBinding = store.getChannelBinding(ctx.channelType, inbound.address.chatId, ctx.profileId);

  // 如果已有绑定，直接处理消息（busy 时弹插队卡片）
  if (existingBinding) {
    if (await maybeOfferInterrupt(ctx, existingBinding, inbound)) return;
    ctx.enqueue(inbound);
    return;
  }

  // 没有绑定，自动创建新会话并绑定私聊本身（不创建新群聊）
  // 使用 bot 的 runtime 而不是全局 defaultRuntime
  const defaultRuntime = ctx.getDefaultRuntime();
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

/**
 * busy 时：先把新消息入队（队首，不丢消息）+ 弹插队卡片，返回 true（已弹卡片）。
 * 空闲时返回 false，调用方直接 enqueue 即可。
 */
async function maybeOfferInterrupt(
  ctx: AdapterContext,
  binding: ChannelBinding,
  inbound: InboundMessage,
): Promise<boolean> {
  const sessionId = binding.codepilotSessionId || binding.sdkSessionId;
  const busy = !!sessionId && isSessionBusy(sessionId);
  rtLog(`[maybeOfferInterrupt] chat=${inbound.address.chatId} sessionId=${sessionId || '(none)'} busy=${busy} ` +
    `codepilot=${binding.codepilotSessionId || '(none)'} sdk=${binding.sdkSessionId || '(none)'}`);
  console.log(
    `[inbound-handler] maybeOfferInterrupt chat=${inbound.address.chatId} sessionId=${sessionId || '(none)'} busy=${busy} ` +
    `codepilot=${binding.codepilotSessionId || '(none)'} sdk=${binding.sdkSessionId || '(none)'}`,
  );
  if (!sessionId || !busy) {
    rtLog(`[maybeOfferInterrupt] NOT busy (sessionId=${sessionId || '(none)'}), skip interrupt card`);
    return false;
  }
  ctx.enqueue(inbound); // 先入队，点"立即插队"后 abort 当前任务，队列随即消费到它
  try {
    const result = await ctx.sendInteractiveCard(inbound.address, buildInterruptCard({
      chatId: inbound.address.chatId,
      messageId: inbound.messageId,
      botName: ctx.label,
    }));
    rtLog(`[maybeOfferInterrupt] interrupt card sent: messageId=${result.messageId} openId=${result.openMessageId || '(none)'}`);
    setInterruptCardMessageId(inbound.messageId, { messageId: result.messageId, openMessageId: result.openMessageId });
    // 自动插队：卡片弹出后 N 秒未操作，自动执行"立即插队"（默认 10s，可用 CTI_AUTO_INTERRUPT_MS 覆盖）
    scheduleAutoInterrupt(ctx, sessionId, inbound, result.messageId);
  } catch (e) {
    rtLog(`[maybeOfferInterrupt] send interrupt card FAILED: ${e}`);
    console.warn('[feishu-adapter] send interrupt card failed:', e);
  }
  return true;
}

// ── 自动插队（卡片弹出后 N 秒未操作自动执行"立即插队"）──
// key = chatId，避免同一会话多条消息的定时器互相干扰；用户手动点"稍后处理"时取消。
const autoInterruptTimers = new Map<string, ReturnType<typeof setTimeout>>();
const AUTO_INTERRUPT_MS = parseInt(process.env.CTI_AUTO_INTERRUPT_MS || '10000', 10);

// 插队卡片 messageId 映射：原始消息 messageId → { 卡片 messageId + openMessageId }（用于按钮点击后 patch 卡片状态）
// 存双 id：飞书 patch 接口对 open_message_id（om_ 开头）需 message_id_type=open_message_id，
// 对普通 message_id 需 message_id_type=message_id；双存双试提高成功率。
const interruptCardMessageIds = new Map<string, { messageId: string; openMessageId?: string }>();
// 定期兜底清理：映射超过 500 条时整体重建，防止内存泄漏（新卡片发送时 set 覆盖同名 key）
setInterval(() => {
  if (interruptCardMessageIds.size > 500) {
    interruptCardMessageIds.clear();
  }
}, 30 * 60 * 1000).unref?.();
export function getInterruptCardMessageId(messageId: string): { messageId: string; openMessageId?: string } | undefined {
  return interruptCardMessageIds.get(messageId);
}
export function setInterruptCardMessageId(messageId: string, cardInfo: { messageId: string; openMessageId?: string }): void {
  interruptCardMessageIds.set(messageId, cardInfo);
}
export function deleteInterruptCardMessageId(messageId: string): void {
  interruptCardMessageIds.delete(messageId);
}

function scheduleAutoInterrupt(
  ctx: AdapterContext,
  sessionId: string,
  inbound: InboundMessage,
  cardMessageId: string,
): void {
  const chatId = inbound.address.chatId;
  const existing = autoInterruptTimers.get(chatId);
  if (existing) clearTimeout(existing); // 只保留最新一条消息的自动插队
  const timer = setTimeout(async () => {
    autoInterruptTimers.delete(chatId);
    // 到点时若任务已不忙（自己完成/已被打断），什么都不做
    if (!isSessionBusy(sessionId)) {
      rtLog(`[autoInterrupt] chat=${chatId} session=${sessionId.slice(0, 8)} no longer busy, skip auto interrupt`);
      return;
    }
    const interrupted = interruptActiveTask(sessionId);
    rtLog(`[autoInterrupt] chat=${chatId} session=${sessionId.slice(0, 8)} auto interrupt after ${AUTO_INTERRUPT_MS}ms, interrupted=${interrupted}`);
    if (interrupted) {
      // 更新插队卡片为"已自动插队"状态（去掉按钮）；卡片本身已显示状态，无需再发重复 post
      let cardPatched = false;
      const autoCard = buildInterruptCard({
        chatId,
        messageId: inbound.messageId,
        botName: ctx.label,
        status: 'auto',
      });
      // 双 id 双尝试：open_message_id → message_id（与 patchActionCardSafely 同策略）
      const cardInfo = getInterruptCardMessageId(inbound.messageId);
      // 统一用 message_id 类型（不加 query，URL 直接放 om_ id —— 实测成功路径）
      const autoAttempts = [
        cardInfo?.messageId
          ? { id: cardInfo.messageId, messageIdType: 'message_id' as const }
          : null,
        cardInfo?.openMessageId
          ? { id: cardInfo.openMessageId, messageIdType: 'message_id' as const }
          : null,
      ].filter((a): a is { id: string; messageIdType: 'message_id' } => !!a);
      for (const attempt of autoAttempts) {
        try {
          await ctx.patchInteractiveCard(attempt.id, autoCard, { messageIdType: attempt.messageIdType });
          cardPatched = true;
          rtLog(`[autoInterrupt] interrupt card updated to auto status: ${attempt.id} (via ${attempt.messageIdType})`);
          break;
        } catch (e) {
          rtLog(`[autoInterrupt] update card via ${attempt.messageIdType} failed: ${e}`);
        }
      }
      if (!cardPatched) {
        console.warn('[feishu-adapter] auto interrupt card patch failed: both messageIdTypes');
      }
      // 仅当卡片 patch 失败时才用 post 兜底提示（卡片已显示则不再发重复消息）
      if (!cardPatched) {
        try {
          await ctx.sendAsPost(inbound.address, `⏱️ ${AUTO_INTERRUPT_MS / 1000}s 未操作，已自动插队：当前任务已中断，你的新消息优先处理中…`, inbound.messageId);
        } catch (e) {
          console.warn('[feishu-adapter] auto interrupt feedback failed:', e);
        }
      }
    }
  }, AUTO_INTERRUPT_MS);
  autoInterruptTimers.set(chatId, timer);
  rtLog(`[autoInterrupt] chat=${chatId} session=${sessionId.slice(0, 8)} auto interrupt scheduled in ${AUTO_INTERRUPT_MS}ms`);
}

/** 用户手动点了"稍后处理"（interrupt:no）时取消自动插队 */
export function cancelAutoInterrupt(chatId: string): void {
  const existing = autoInterruptTimers.get(chatId);
  if (existing) {
    clearTimeout(existing);
    autoInterruptTimers.delete(chatId);
    rtLog(`[autoInterrupt] chat=${chatId} auto interrupt cancelled (user chose 稍后处理)`);
  }
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

  // 群命令（/reset, /new, /stop, /mode, /plan, /compact）不需要 @ bot，所有 bot 各自处理自己的会话
  const isGroupCommand = lower === '/reset' || lower === '/new' || lower.startsWith('/new')
    || lower === '/stop' || lower.startsWith('/mode') || lower === '/plan' || lower.startsWith('/plan ')
    || lower === '/compact';

  if (!isGroupCommand) {
    // 非命令消息必须 @到本 bot 才回复，不 @ 静默忽略
    const raw = inbound.raw as { mentions?: Array<{ key: string; id?: { open_id?: string } }> } | undefined;
    const mentions = raw?.mentions;
    rtLog(`[MENTION-DEBUG] botOpenId=${ctx.botOpenId}, mentions=${JSON.stringify(mentions)}, rawKeys=${raw ? Object.keys(raw).join(',') : 'null'}`);
    if (mentions && mentions.length > 0) {
      if (ctx.botOpenId) {
        const isMentioned = mentions.some((m) => m.id?.open_id === ctx.botOpenId);
        rtLog(`[MENTION-DEBUG] isMentioned=${isMentioned}, checking against botOpenId=${ctx.botOpenId}`);
        if (!isMentioned) return; // 未 @本 bot，静默忽略
      }
      // botOpenId 未知时，只要有 @ 就处理
    } else {
      // 没有 @，不回复
      rtLog(`[MENTION-DEBUG] no mentions found, returning`);
      return;
    }
  }

  if (lower === '/reset') {
    await ctx.handleResetCommand(inbound.address, inbound.messageId);
    return;
  }
  if (lower === '/stop') {
    if (!binding) {
      await ctx.sendAsPost(inbound.address, '当前群尚未绑定会话。请先私聊 Bot 发送 `/new:claude` 或 `/new:codex`。', inbound.messageId);
      return;
    }
    // /stop 必须立即打断当前任务，不能排队（否则当前任务完成前 /stop 永远执行不到）
    try {
      const sessionId = binding.codepilotSessionId || binding.sdkSessionId;
      const interrupted = interruptActiveTask(sessionId);
      if (interrupted) {
        await ctx.sendAsPost(inbound.address, '⏹ 正在中断当前任务...', inbound.messageId);
      } else {
        await ctx.sendAsPost(inbound.address, '当前没有正在运行的任务。', inbound.messageId);
      }
    } catch (e) {
      console.log(`[inbound-handler] /stop interrupt error: ${e}`);
      // 失败则退回队列处理
      ctx.enqueue(inbound);
    }
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

        // Use global compact config from config.env
        const compactConfig2 = loadConfig().compact;
        const runtime2 = store2.getSessionExt?.(sid2)?.runtime || 'claude';

        const result2 = await compactConversation(store2, sid2, compactConfig2, runtime2);
        if (result2.success) {
          applyCompactResult(store2, sid2, result2);
          if (compactConfig2.clearSdkSession) {
            store2.updateSdkSessionId(sid2, '');
          }
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
    // 群聊 /new：用默认 runtime 自动创建并绑定新会话（不再要求私聊）
    const newRuntime = ctx.getDefaultRuntime();
    try {
      await ctx.ensureRuntimeAvailable(newRuntime);
      const store = ctx.getStore();
      const newOptions: Parameters<typeof ctx.createBoundSession>[2] = {
        cwd: process.env.CTI_REASONIX_ACP_CWD
          || (process.platform === 'win32' ? (process.env.USERPROFILE || 'C:\\Users\\oadan') : '/opt'),
        bindingMode: 'code',
        existingChatId: inbound.address.chatId,
        skipReadyMessage: true,
      };
      if (newRuntime === 'claude') {
        newOptions.claudePermissionMode = 'bypassPermissions';
      }
      const { binding } = await ctx.createBoundSession(newRuntime, _sender, newOptions);
      console.log(`[feishu-adapter] group /new: bound chat ${inbound.address.chatId} runtime=${newRuntime}`);
      const feedback = `✅ 已新建 ${newRuntime} 会话（本群）｜工作区 \`${binding.workingDirectory}\`｜直接对话即可`;
      await ctx.sendAsPost(inbound.address, feedback, inbound.messageId, true);
    } catch (error) {
      console.error('[feishu-adapter] group /new failed:', error);
      await ctx.sendAsPost(
        inbound.address,
        `创建会话失败：${error instanceof Error ? error.message : String(error)}`,
        inbound.messageId,
      );
    }
    return;
  }
  if (lower.startsWith('/')) {
    await ctx.sendAsPost(inbound.address, '该群仅支持普通对话、`/plan`、`/mode`、`/stop`、`/reset`。权限请求请直接使用卡片按钮处理；如需新会话，请私聊 Bot。', inbound.messageId);
    return;
  }

  if (!binding) {
    // 群聊自动绑定：@ bot 的普通消息未绑定时自动创建会话并绑定（默认 runtime），无需先私聊 /new
    const autoRuntime = ctx.getDefaultRuntime();
    try {
      const autoOptions: Parameters<typeof ctx.createBoundSession>[2] = {
        cwd: process.env.CTI_REASONIX_ACP_CWD
          || (process.platform === 'win32' ? (process.env.USERPROFILE || 'C:\\Users\\oadan') : '/opt'),
        bindingMode: 'code',
        existingChatId: inbound.address.chatId,
        skipReadyMessage: true,
      };
      if (autoRuntime === 'claude') {
        autoOptions.claudePermissionMode = 'bypassPermissions';
      }
      if (autoRuntime === 'mimo') {
        autoOptions.model = store.getSetting('compact_model') || 'MiMo-OpenAI';
      }
      const { binding: autoBinding } = await ctx.createBoundSession(autoRuntime, _sender, autoOptions);
      console.log(`[feishu-adapter] group auto-bind chatId=${inbound.address.chatId} runtime=${autoRuntime}`);
      await ctx.sendAsPost(
        inbound.address,
        `✅ 已自动绑定 ${autoRuntime} 会话（本群）｜工作区 \`${autoBinding.workingDirectory}\`｜直接对话即可`,
        inbound.messageId,
        true,
      );
      ctx.enqueue(inbound); // 当前消息直接进入新会话
    } catch (autoError) {
      console.error('[feishu-adapter] group auto-bind failed:', autoError);
      await ctx.sendAsPost(
        inbound.address,
        `自动绑定失败：${autoError instanceof Error ? autoError.message : String(autoError)}`,
        inbound.messageId,
      );
    }
    return;
  }
  if (workflow) {
    const consumed = await ctx.handlePlanWorkflowMessage(binding.id, workflow.workflowId, inbound);
    if (consumed) return;
  }
  // busy 时弹插队卡片（消息已入队，用户可选立即打断或稍后处理）
  if (await maybeOfferInterrupt(ctx, binding, inbound)) return;
  ctx.enqueue(inbound);
}

function extractSenderIdentity(data: FeishuMessageEventData): SenderIdentity | null {
  const senderId = data.sender.sender_id;
  if (senderId?.open_id) return { id: senderId.open_id, type: 'open_id' };
  if (senderId?.user_id) return { id: senderId.user_id, type: 'user_id' };
  if (senderId?.union_id) return { id: senderId.union_id, type: 'union_id' };
  return null;
}
