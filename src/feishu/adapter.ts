import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  ActivityEvent,
  ChannelAddress,
  ChannelBinding,
  ChannelType,
  FileAttachment,
  InboundMessage,
  OutboundImage,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
} from '../bridge/types.js';
import { DEFAULT_CHANNEL_INSTANCE_ID, resolveChannelInstanceId } from '../bridge/types.js';
import type { StructuredInputRequestInfo } from '../bridge/host.js';
import { BaseChannelAdapter } from '../bridge/channel-adapter.js';
import { getBridgeContext } from '../bridge/context.js';
import { interruptActiveTask } from '../bridge/bridge-manager.js';
import { getSessionCacheStats } from '../bridge/conversation-engine.js';
import { appendLocalCommandExchange } from '../bridge/local-command-history.js';
import {
  buildCardContent,
  buildPostContent,
  preprocessFeishuMarkdown,
  type AgentDividerInfo,
} from '../bridge/markdown/feishu.js';
import {
  buildClaudePlanExecutionPrompt,
} from '../runtime/claude-plan-exit.js';
import {
  getClaudeModeSuffix,
  getClaudeModeTitle,
  normalizeClaudePermissionMode,
} from '../runtime/claude-mode.js';
import type { ClaudePermissionMode } from '../runtime/claude-mode.js';
import {
  listClaudeNativeWorkspaces,
  listCodexNativeWorkspaces,
  type NativeReplayItem,
} from '../infra/native-session-history.js';

import type { MultiplexLLMProvider } from '../providers/multiplex.js';
import { listRecentWorkspaces, type RecentWorkspaceOption } from '../infra/recent-workspaces.js';
import type { RuntimeName } from '../runtime/types.js';
import { getRuntimeConfig, buildSystemPrompt } from '../config/runtime-configs.js';
import { JsonFileStore } from '../infra/store.js';
import {
  extractActionSenderIdentity as extractActionSenderIdentityWithContext,
  findBindingById as findBindingByIdWithContext,
  handleCardAction as handleCardActionWithContext,
  handleClaudePlanExitCardAction as handleClaudePlanExitCardActionWithContext,
  handleCreateSessionCommand as handleCreateSessionCommandWithContext,
  handleDirectMessage as handleDirectMessageWithContext,
  handleGroupMessage as handleGroupMessageWithContext,
  handleIncomingEvent as handleIncomingEventWithContext,
  handleModeCommand as handleModeCommandWithContext,
  handleNewSessionCardAction as handleNewSessionCardActionWithContext,
  handlePlanCardAction as handlePlanCardActionWithContext,
  handlePlanCommand as handlePlanCommandWithContext,
  handlePlanWorkflowMessage as handlePlanWorkflowMessageWithContext,
  handleResetCommand as handleResetCommandWithContext,
  handleResumeCardAction as handleResumeCardActionWithContext,
  handleResumeSessionCommand as handleResumeSessionCommandWithContext,
  handleInterruptCardAction as handleInterruptCardActionWithContext,
  handleStructuredInputCardAction as handleStructuredInputCardActionWithContext,
  patchActionCardSafely as patchActionCardSafelyWithContext,
  replayNativeSessionHistory as replayNativeSessionHistoryWithContext,
} from './handlers/index.js';
import { LarkClient } from './lark-client.js';

// 实时日志：绕过 NSSM stdout 缓冲，直接写硬盘
const DEBUG_LOG = `C:\\D\\opt\\agents-to-im\\debug_realtime_${process.env.CTI_BOT || 'unknown'}.log`;
function rtLog(msg: string): void {
  const time = new Date().toISOString();
  try {
    fs.appendFileSync(DEBUG_LOG, `[${time}] ${msg}\n`, 'utf-8');
  } catch {}
}

import {
  buildActionCard,
  buildClaudeModeCard,
  buildNewClaudeSessionCard,
  buildNewCodexSessionCard,
  buildNewGeminiSessionCard,
  buildNewMimoSessionCard,
  buildPermissionCard,
  buildResumeSessionCard,
  buildSimpleCard,
  buildStatusCard,
  buildStreamingCardSkeleton,
  buildStructuredInputCard,
  buildStructuredInputFallbackText,
  extractStructuredAnswers,
  getActivityEventId,
  isStructuredInputFieldInteraction,
  splitReplayText,
} from './cards/index.js';
import {
  NEW_SESSION_WORKDIR_FIELD,
  PENDING_INBOUND_IMAGE_TTL_MS,
  PLAN_SUFFIX,
  STREAM_ELEMENT_ID,
  STREAM_PLACEHOLDER_TEXT,
  TYPING_EMOJI,
  findMissingAppScopes,
} from './constants.js';
import { OutboundAudioService } from './services/outbound-audio-service.js';
import type {
  ActivityArtifact,
  FeishuAdapterOptions,
  FeishuChatUpdatedEventData,
  FeishuMessageEventData,
  FeishuMessageRecalledEventData,
  PendingActivitySend,
  PendingInboundImage,
  PreviewArtifact,
  SenderIdentity,
  StructuredActionEvent,
} from './types.js';
import { ActivityService } from './services/activity-service.js';
import { InboundImageService } from './services/inbound-image-service.js';
import { PreviewService } from './services/preview-service.js';
import {
  activityKey,
  assertLarkOk,
  buildPlanExecutionPrompt,
  buildPlanningPrompt,
  buildRouteKey,
  collectTextFragments,
  defaultChatName,
  extensionForMimeType,
  isNonEmptyString,
  isRecoverableMessageSendError,
  normalizeMarkdown,
  normalizePath,
  parseImageResourceKey,
  parseTextContent,
  pendingInboundImageKey,
  previewKey,
  resolveActionOpenMessageId,
  resolveClaudeBindingMode,
  routeKeyForAddress,
  stableMessageUuid,
  stripClaudeModeSuffix,
} from './utils.js';

export { FEISHU_REQUIRED_APP_SCOPES, findMissingAppScopes } from './constants.js';
export type { FeishuAdapterOptions } from './types.js';

function isToolCallActivityEvent(event: ActivityEvent): boolean {
  return event.kind === 'tool_activity'
    || event.kind === 'command_execution'
    || event.kind === 'file_change';
}

/**
 * 读取直连 deepseek 类 bot（reasonix / dsh）的 usage stats（stats/YYYY-MM-DD.jsonl），
 * 返回最近一轮 + 当日平均的缓存命中率，以及最近一轮的上下文占用百分比
 * （prompt tokens / 1M 上限）。source=cli 是飞书 bot（ACP 直连）的请求记录；
 * source=desktop 是桌面端（跳过）。
 * 供 ACP 直连无 usage 上报到 conversation-engine 的 bot fallback 使用。
 */
// DeepSeek 余额缓存（避免每轮都调 /user/balance 造成延迟；60 秒过期）
let deepseekBalanceCache: { total: string; granted: string; toppedUp: string; cachedAt: number } | null = null;

async function readDeepseekBalance(): Promise<{ total: string; granted: string; toppedUp: string } | null> {
  const now = Date.now();
  if (deepseekBalanceCache && now - deepseekBalanceCache.cachedAt < 60_000) {
    return { total: deepseekBalanceCache.total, granted: deepseekBalanceCache.granted, toppedUp: deepseekBalanceCache.toppedUp };
  }
  try {
    const key = process.env.DEEPSEEK_API_KEY
      || (() => {
        const envFile = 'C:\\Users\\oadan\\AppData\\Roaming\\reasonix\\.env';
        try {
          const line = fs.readFileSync(envFile, 'utf-8').split(/\r?\n/).find((l) => l.startsWith('DEEPSEEK_API_KEY='));
          return line ? line.slice('DEEPSEEK_API_KEY='.length).trim() : '';
        } catch { return ''; }
      })();
    if (!key) return null;
    const resp = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as {
      balance_infos?: Array<{ currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }>;
    };
    const info = data.balance_infos?.[0];
    if (!info) return null;
    const result = { total: info.total_balance, granted: info.granted_balance, toppedUp: info.topped_up_balance };
    deepseekBalanceCache = { ...result, cachedAt: now };
    return result;
  } catch {
    return null;
  }
}

/** 按 profileId 判断是否为直连 deepseek 的 bot（reasonix / dsh），决定是否显示余额等 meta 项 */
function isDirectDeepSeekProfile(profileId: string): boolean {
  return profileId.includes('reasonix') || profileId.includes('dsh');
}

/**
 * 读取直连 deepseek 类 bot（reasonix / dsh）的 usage stats 文件目录。
 * 2026-08-18：reasonix home 已统一为桌面 %APPDATA%/reasonix（REASONIX_HOME），
 * bot 与桌面共用同一份 stats；dsh 在 ~/.dsh/dsh-bot（DSH_HOME）。
 */
function resolveStatsDir(profileId: string): string | null {
  if (profileId.includes('dsh')) {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const botStatsDir = path.join(dshHome, 'dsh-bot', 'stats');
    return fs.existsSync(botStatsDir) ? botStatsDir : null;
  }
  if (profileId.includes('reasonix')) {
    const botHome = process.env.REASONIX_HOME || path.join(os.homedir(), '.reasonix-bot');
    const botStatsDir = path.join(botHome, 'stats');
    const desktopStatsDir = path.join(
      process.platform === 'win32'
        ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
        : path.join(os.homedir(), '.config'),
      'reasonix',
      'stats',
    );
    return fs.existsSync(botStatsDir) ? botStatsDir : desktopStatsDir;
  }
  return null;
}

function readAgentCacheStats(profileId: string): { lastRate: number; avgRate: number; contextPercent: number } | null {
  try {
    const statsDir = resolveStatsDir(profileId);
    if (!statsDir) return null;
    // 文件按本地日期命名（如 2026-08-06），不能用 toISOString（UTC 会偏一天）
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const file = path.join(statsDir, `${localDate}.jsonl`);
    if (!fs.existsSync(file)) return null;

    let lastRate: number | null = null;
    let sumHit = 0;
    let sumMiss = 0;
    let total = 0;
    let lastPromptTokens: number | null = null;
    // reasonix / dsh (deepseek-v4-flash) 上下文上限 1M tokens；超过触发引擎压缩/报错
    const CONTEXT_LIMIT_TOKENS = 1_000_000;
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec: { source?: string; cache_hit?: number; cache_miss?: number; prompt?: number };
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.source !== 'cli') continue; // 只看飞书 bot 的请求
      const hit = Number(rec.cache_hit ?? 0);
      const miss = Number(rec.cache_miss ?? 0);
      if (hit + miss <= 0) continue;
      const rate = (hit / (hit + miss)) * 100;
      lastRate = rate;
      sumHit += hit;
      sumMiss += miss;
      total++;
      if (rec.prompt != null && Number(rec.prompt) > 0) lastPromptTokens = Number(rec.prompt);
    }
    if (lastRate == null || total === 0) return null;
    const avgRate = (sumHit / (sumHit + sumMiss)) * 100;
    const contextPercent = lastPromptTokens != null
      ? Math.min(100, (lastPromptTokens / CONTEXT_LIMIT_TOKENS) * 100)
      : 0;
    return { lastRate, avgRate, contextPercent };
  } catch {
    return null;
  }
}

/**
 * 查询 DeepSeek 直连余额（仅 reasonix 显示，其他 bot 走 LiteLLM 无此接口）。
 * 缓存 60 秒避免每次回复都打余额接口。
 */
let balanceCache: { value: string; at: number } | null = null;
async function fetchDeepSeekBalance(): Promise<string | null> {
  const now = Date.now();
  if (balanceCache && now - balanceCache.at < 60_000) return balanceCache.value;
  try {
    const key = process.env.DEEPSEEK_API_KEY || (() => {
      const envFile = 'C:\\Users\\oadan\\AppData\\Roaming\\reasonix\\.env';
      try {
        const line = fs.readFileSync(envFile, 'utf-8').split(/\r?\n/).find((l) => l.startsWith('DEEPSEEK_API_KEY='));
        return line ? line.slice('DEEPSEEK_API_KEY='.length).trim() : '';
      } catch { return ''; }
    })();
    if (!key) return null;
    const resp = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as {
      balance_infos?: Array<{ currency: string; total_balance: string }>;
    };
    const info = data.balance_infos?.[0];
    if (!info) return null;
    const value = `¥${info.total_balance}`;
    balanceCache = { value, at: now };
    return value;
  } catch {
    return null;
  }
}

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'feishu';
  private readonly instanceAdapterId: string;
  private readonly instanceProfileId: string;
  private static readonly SELF_RENAME_ECHO_TTL_MS = 30_000;

  private botOpenId: string | null = null;
  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  /** 用户通过插队卡"取消消息"按钮标记作废的消息 id（从队列移除 + 防止已入链的执行） */
  private cancelledMessageIds = new Set<string>();
  /** "稍后"按钮挂起的消息：chatId → 消息列表（等同会话下一条消息合并发送） */
  private deferredMessages = new Map<string, InboundMessage[]>();
  private wsClient: lark.WSClient | null = null;
  private chatQueues = new Map<string, Promise<void>>();
  private seenMessageIds = new Map<string, number>();
  // ⚠️ 2026-08-09 修复：seenMessageIds 持久化到磁盘（CTI_HOME/seen-messages-<bot>.json），
  // 避免 PM2 重启后内存 Set 清空导致飞书重推的旧消息被重复处理（"取消的消息又复活"根因）。
  private readonly seenMessagesFile: string;
  private lastIncomingMessageId = new Map<string, string>();
  private typingReactions = new Map<string, string>();
  private pendingTitleSyncs = new Set<string>();
  private knownChatNames = new Map<string, string>();
  private selfRenameEchoes = new Map<string, number>();
  private readonly larkClient = new LarkClient();
  private readonly previewService = new PreviewService(
    this.larkClient,
    (routeKey) => this.lastIncomingMessageId.get(routeKey),
    (address) => this.buildDividerInfo(address),
  );
  private readonly activityService = new ActivityService(
    this.larkClient,
    (routeKey) => this.lastIncomingMessageId.get(routeKey),
  );
  private readonly inboundImageService = new InboundImageService(
    () => this.restClient,
  );
  private readonly outboundAudioService = new OutboundAudioService(
    () => this.restClient,
  );
  /** Tracks chats that need audio reply (user sent audio message) */
  private pendingAudioReply = new Map<string, boolean>();

  constructor(
    private readonly options: FeishuAdapterOptions = {
      profile: {
        id: DEFAULT_CHANNEL_INSTANCE_ID,
      },
    },
  ) {
    super();
    this.instanceProfileId = options.profile.id || DEFAULT_CHANNEL_INSTANCE_ID;
    this.instanceAdapterId = `${this.channelType}:${this.instanceProfileId}`;
    // 预热 reasonix / dsh 余额缓存：进程启动即拉取一次，保证第一轮回复的 meta 行就能显示余额
    // （buildDividerInfo 同步读缓存；60s 内不重复打接口）
    if (isDirectDeepSeekProfile(this.profileId)) {
      void fetchDeepSeekBalance();
    }
    // 加载持久化的已读消息 ID（重启后仍能对飞书重推去重）
    try {
      const home = process.env.CTI_HOME || path.join(os.homedir(), '.agents-to-im');
      this.seenMessagesFile = path.join(home, `seen-messages-${this.instanceProfileId}.json`);
      if (fs.existsSync(this.seenMessagesFile)) {
        const raw = JSON.parse(fs.readFileSync(this.seenMessagesFile, 'utf-8')) as Record<string, number>;
        for (const [mid, ts] of Object.entries(raw)) {
          this.seenMessageIds.set(mid, ts);
        }
      }
    } catch {
      // 加载失败不阻塞启动，退化为内存去重
      this.seenMessagesFile = path.join(
        process.env.CTI_HOME || path.join(os.homedir(), '.agents-to-im'),
        `seen-messages-${this.instanceProfileId}.json`,
      );
    }
  }

  /** 获取该 adapter 的默认 runtime */
  getDefaultRuntime(): RuntimeName {
    return this.options.defaultRuntime || 'claude';
  }

  get adapterId(): string {
    return this.instanceAdapterId;
  }

  get profileId(): string {
    return this.instanceProfileId;
  }

  get label(): string {
    return this.instanceProfileId;
  }

  get restClient(): lark.Client | null {
    return this.larkClient.getClient();
  }

  set restClient(client: lark.Client | null) {
    const cfg = this.getClientConfig();
    this.larkClient.setClient(client, cfg.appId || this.options.profile.appId, cfg.appSecret || this.options.profile.appSecret, String(cfg.domain));
  }

  get previewArtifacts(): Map<string, PreviewArtifact> {
    return this.previewService.previewArtifacts;
  }

  get activePreviewByRoute(): Map<string, string> {
    return this.previewService.activePreviewByRoute;
  }

  get activityArtifacts(): Map<string, ActivityArtifact> {
    return this.activityService.activityArtifacts;
  }

  get pendingActivitySends(): Map<string, PendingActivitySend> {
    return this.activityService.pendingActivitySends;
  }

  get pendingInboundImages(): Map<string, PendingInboundImage> {
    return this.inboundImageService.pendingInboundImages;
  }

  get outboundMessageQueues(): Map<string, Promise<void>> {
    return this.larkClient.outboundMessageQueues;
  }

  get lastOutboundMessageAt(): Map<string, number> {
    return this.larkClient.lastOutboundMessageAt;
  }

  getLarkClient(): LarkClient {
    return this.larkClient;
  }

  private getPreviewService(): PreviewService {
    return this.previewService;
  }

  private getActivityService(): ActivityService {
    return this.activityService;
  }

  private getInboundImageService(): InboundImageService {
    return this.inboundImageService;
  }

  private setLastIncomingMessageId(routeKey: string, messageId: string): void {
    this.lastIncomingMessageId.set(routeKey, messageId);
  }

  private markSeenMessage(messageId: string): boolean {
    if (this.seenMessageIds.has(messageId)) return false;
    this.seenMessageIds.set(messageId, Date.now());
    if (this.seenMessageIds.size > 1000) {
      const first = this.seenMessageIds.keys().next().value;
      if (first) this.seenMessageIds.delete(first);
    }
    // 持久化：重启后仍能去重（2026-08-09 修复，防"取消消息复活/重复处理"）
    try {
      const obj: Record<string, number> = {};
      this.seenMessageIds.forEach((v, k) => { obj[k] = v; });
      fs.writeFileSync(this.seenMessagesFile, JSON.stringify(obj), 'utf-8');
    } catch { /* 写盘失败不影响主流程 */ }
    return true;
  }

  private getHandlerContext(): import('./types.js').AdapterContext {
    return {
      channelType: this.channelType,
      profileId: this.profileId,
      label: this.label,
      botOpenId: this.botOpenId,
      getStore: this.getStore.bind(this),
      getLarkClient: this.getLarkClient.bind(this),
      getPreviewService: this.getPreviewService.bind(this),
      getActivityService: this.getActivityService.bind(this),
      getInboundImageService: this.getInboundImageService.bind(this),
      withInstance: this.withInstance.bind(this),
      isAuthorized: this.isAuthorized.bind(this),
      setLastIncomingMessageId: this.setLastIncomingMessageId.bind(this),
      markSeenMessage: this.markSeenMessage.bind(this),
      enqueue: this.enqueue.bind(this),
      enqueueChatTask: this.enqueueChatTask.bind(this),
      isMessageQueued: this.isMessageQueued.bind(this),
      cancelInboundMessage: this.cancelInboundMessage.bind(this),
      deferInboundMessage: this.deferInboundMessage.bind(this),
      collectDeferredMessages: this.collectDeferredMessages.bind(this),
      ingestToMemoryTree: this.ingestToMemoryTree.bind(this),
      sendAsPost: this.sendAsPost.bind(this),
      sendAsInteractiveCard: this.sendAsInteractiveCard.bind(this),
      sendInteractiveCard: this.sendInteractiveCard.bind(this),
      patchInteractiveCard: this.patchInteractiveCard.bind(this),
      patchActionCardSafely: this.patchActionCardSafely.bind(this),
      handleCreateSessionCommand: this.handleCreateSessionCommand.bind(this),
      handleNewSessionCardAction: this.handleNewSessionCardAction.bind(this),
      handleClaudeModeCardAction: this.handleClaudeModeCardAction.bind(this),
      handleResumeSessionCommand: this.handleResumeSessionCommand.bind(this),
      handleResumeCardAction: this.handleResumeCardAction.bind(this),
      handleInterruptCardAction: this.handleInterruptCardAction.bind(this),
      handleResetCommand: this.handleResetCommand.bind(this),
      handleModeCommand: this.handleModeCommand.bind(this),
      handlePlanCommand: this.handlePlanCommand.bind(this),
      handlePlanWorkflowMessage: this.handlePlanWorkflowMessage.bind(this),
      handlePlanCardAction: this.handlePlanCardAction.bind(this),
      handleClaudePlanExitCardAction: this.handleClaudePlanExitCardAction.bind(this),
      handleStructuredInputCardAction: this.handleStructuredInputCardAction.bind(this),
      resolveStructuredInputRequest: this.resolveStructuredInputRequest.bind(this),
      getRecentWorkspaceOptions: this.getRecentWorkspaceOptions.bind(this),
      resolveSelectedWorkdir: this.resolveSelectedWorkdir.bind(this),
      createBoundSession: this.createBoundSession.bind(this),
      ensureRuntimeAvailable: this.ensureRuntimeAvailable.bind(this),
      sendNewSessionCard: this.sendNewSessionCard.bind(this),
      sendClaudeModeCard: this.sendClaudeModeCard.bind(this),
      appendBindingCommandExchange: this.appendBindingCommandExchange.bind(this),
      syncChatName: this.syncChatName.bind(this),
      findBindingById: this.findBindingById.bind(this),
      extractActionSenderIdentity: this.extractActionSenderIdentity.bind(this),
      resolveActionChatId: this.resolveActionChatId.bind(this),
      replayNativeSessionHistory: this.replayNativeSessionHistory.bind(this),
      buildPlanRequestInbound: this.buildPlanRequestInbound.bind(this),
      buildNativePlanRequestInbound: this.buildNativePlanRequestInbound.bind(this),
      buildPlanExecutionInbound: this.buildPlanExecutionInbound.bind(this),
      prunePendingInboundImages: this.prunePendingInboundImages.bind(this),
      setPendingInboundImage: this.setPendingInboundImage.bind(this),
      downloadInboundImageAttachment: this.downloadInboundImageAttachment.bind(this),
      downloadAndTranscribe: this.downloadAndTranscribe.bind(this),
      resolveReferencedInboundImages: this.resolveReferencedInboundImages.bind(this),
      resolveLatestPendingImageForChat: this.resolveLatestPendingImageForChat.bind(this),
      deletePendingInboundImage: this.inboundImageService.deletePendingInboundImage.bind(this.inboundImageService),
      setPendingAudioReply: this.setPendingAudioReply.bind(this),
      clearPendingAudioReply: this.clearPendingAudioReply.bind(this),
      needsAudioReply: this.needsAudioReply.bind(this),
      getDefaultRuntime: this.getDefaultRuntime.bind(this),
    };
  }

  /**
   * Send a plain-text notification to a feishu chat.
   * Used by idle-compact and other background processes to notify users.
   */
  async sendNotification(chatId: string, text: string): Promise<boolean> {
    try {
      const address: ChannelAddress = {
        channelType: this.channelType,
        channelInstanceId: this.profileId,
        chatId,
      };
      await this.sendAsPost(address, text);
      return true;
    } catch (err) {
      console.warn(`[feishu-adapter] sendNotification failed for ${chatId}:`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  private withInstance(address: ChannelAddress): ChannelAddress {
    return {
      ...address,
      channelInstanceId: resolveChannelInstanceId(address) === DEFAULT_CHANNEL_INSTANCE_ID
        ? this.profileId
        : resolveChannelInstanceId(address),
    };
  }

  private usesLegacyStoreSettings(): boolean {
    return !this.options.profile.appId && !this.options.profile.appSecret;
  }

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[feishu-adapter] Cannot start:', configError);
      return;
    }

    const { appId, appSecret, domain } = this.getClientConfig();
    this.restClient = new lark.Client({ appId, appSecret, domain });
    void this.fetchBotOpenId();

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        await this.handleIncomingEvent(data as FeishuMessageEventData);
      },
      'im.message.message_read_v1': async () => {},
      'im.message.recalled_v1': async (data: unknown) => {
        await this.handleMessageRecalledEvent(data as FeishuMessageRecalledEventData);
      },
      'im.chat.updated_v1': async (data: unknown) => {
        await this.handleChatUpdatedEvent(data as FeishuChatUpdatedEventData);
      },
      'card.action.trigger': async (data: unknown) => {
        try {
          return await this.handleCardAction(data as StructuredActionEvent);
        } catch (error) {
          console.warn('[feishu-adapter] card.action.trigger handler error:', error);
          return {
            toast: {
              type: 'error',
              content: '交互处理失败，请稍后重试。',
            },
          };
        }
      },
    });

    this.wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.info,  // 只记录 info 及以上，减少日志噪音
    });

    const wsClientAny = this.wsClient as unknown as {
      handleEventData: (data: unknown) => unknown;
    };
    const originalHandleEventData = wsClientAny.handleEventData.bind(wsClientAny);
    wsClientAny.handleEventData = (data: unknown) => {
      const frame = data as { headers?: Array<{ key?: string; value?: string }>; payload?: Uint8Array };
      const messageType = frame.headers?.find((header) => header.key === 'type')?.value;
      const messageId = frame.headers?.find((header) => header.key === 'message_id')?.value;
      // 调试：记录所有接收的数据帧类型和 payload
      const payloadStr = frame.payload ? new TextDecoder('utf-8').decode(frame.payload) : 'undefined';
      console.log('[feishu-adapter] WS frame received, type=', messageType, 'message_id=', messageId, 'payload=', payloadStr.slice(0, 200));
      if (messageType === 'card' && frame.headers) {
        console.log('[feishu-adapter] Converting card type to event');
        return originalHandleEventData({
          ...frame,
          headers: frame.headers.map((header) =>
            header.key === 'type' ? { ...header, value: 'event' } : header,
          ),
        });
      }
      return originalHandleEventData(data);
    };

    this.running = true;
    void this.larkClient.runScopeDiagnostic();
    void this.wsClient.start({ eventDispatcher: dispatcher });
    console.log('[feishu-adapter] Started');
  }

  private async fetchBotOpenId(): Promise<void> {
    // 优先用配置指定的 bot open_id（user 视角，与群 mentions 匹配）
    const configured = this.options?.profile?.botOpenId;
    if (configured) {
      this.botOpenId = configured;
      console.log(`[feishu-adapter] Bot open_id (configured): ${configured}`);
      return;
    }
    if (!this.restClient) return;
    try {
      const response = await this.restClient.request({
        url: '/open-apis/bot/v3/info',
        method: 'GET',
      }) as { bot?: { open_id?: string } };
      const openId = response?.bot?.open_id;
      if (openId) {
        this.botOpenId = openId;
        console.log(`[feishu-adapter] Bot open_id: ${openId}`);
      }
    } catch (error) {
      console.warn('[feishu-adapter] Failed to fetch bot open_id:', error);
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    try {
      this.wsClient?.close({ force: true });
    } catch {
      // ignore
    }
    this.wsClient = null;
    this.restClient = null;
    for (const waiter of this.waiters) waiter(null);
    this.waiters = [];
    this.queue = [];
    this.chatQueues.clear();
    this.pendingTitleSyncs.clear();
    this.knownChatNames.clear();
    this.selfRenameEchoes.clear();
    this.previewService.reset();
    this.activityService.reset();
    this.inboundImageService.reset();
  }

  isRunning(): boolean {
    return this.running;
  }

  consumeOne(): Promise<InboundMessage | null> {
    // 跳过已被"取消消息"按钮标记作废的消息
    while (this.queue.length > 0) {
      const queued = this.queue.shift();
      if (queued && this.cancelledMessageIds.has(queued.messageId)) {
        this.cancelledMessageIds.delete(queued.messageId);
        continue;
      }
      if (queued) return Promise.resolve(queued);
    }
    if (!this.running) return Promise.resolve(null);
    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** 查询消息是否仍在待处理队列（排队消息被 consumeOne 取出开始处理后即不在队列） */
  isMessageQueued(messageId: string): boolean {
    return this.queue.some((m) => m.messageId === messageId);
  }

  /** 查询消息是否已被"取消消息"按钮标记作废（供消费循环在入链前拦截） */
  isMessageCancelled(messageId: string): boolean {
    return this.cancelledMessageIds.has(messageId);
  }

  /** 取消一条已入队的消息（插队卡"取消消息"按钮）：从队列移除 + 标记作废 */
  cancelInboundMessage(messageId: string): boolean {
    this.cancelledMessageIds.add(messageId);
    const idx = this.queue.findIndex((m) => m.messageId === messageId);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      return true;
    }
    return false; // 不在待处理队列（可能已入 chatQueues 串行链），靠标记在消费时拦截
  }

  /** "稍后"按钮：把消息从待处理队列移到挂起区（等同会话下一条消息合并发送） */
  deferInboundMessage(messageId: string): boolean {
    const idx = this.queue.findIndex((m) => m.messageId === messageId);
    if (idx === -1) {
      // 不在队列（可能已出队执行）——只能标记，无法挂起
      return false;
    }
    const [msg] = this.queue.splice(idx, 1);
    const chatId = msg.address.chatId;
    const list = this.deferredMessages.get(chatId) || [];
    list.push(msg);
    this.deferredMessages.set(chatId, list);
    return true;
  }

  /** 取出该会话所有"稍后"挂起的消息（合并到下一条 prompt），取出后清空 */
  collectDeferredMessages(chatId: string): InboundMessage[] {
    const list = this.deferredMessages.get(chatId) || [];
    this.deferredMessages.delete(chatId);
    return list;
  }

  validateConfig(): string | null {
    const store = this.tryGetStore();
    const appId = this.options.profile.appId || store?.getSetting('bridge_feishu_app_id') || '';
    const appSecret = this.options.profile.appSecret || store?.getSetting('bridge_feishu_app_secret') || '';
    if (!appId) return `${this.label}: CTI_FEISHU_APP_ID is required`;
    if (!appSecret) return `${this.label}: CTI_FEISHU_APP_SECRET is required`;
    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    const allowed = this.options.profile.allowedUsers
      || (this.usesLegacyStoreSettings()
        ? (this.getStore().getSetting('bridge_feishu_allowed_users') || '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : undefined);
    // 安全策略：未配置 allowlist 时拒绝所有发送者，避免任何能向 bot 发消息的人
    // 都能驱动本机 Claude/Codex 执行命令。如果用户确实希望放行所有人（仅适用
    // 于 1:1 私聊或仅 owner 在群中的场景），必须显式配置为 '*' 这一个通配符。
    // 注意：'*' 必须独占整个列表才生效，混合配置如 ['*', 'ou_xxx'] 会被视作
    // 仅匹配 'ou_xxx'，避免歧义。
    if (!allowed || allowed.length === 0) return false;
    const cleaned = allowed.map((item) => item.trim()).filter(Boolean);
    if (cleaned.length === 1 && cleaned[0] === '*') return true;
    return new Set(cleaned).has(userId);
  }

  onMessageStart(address: ChannelAddress): void {
    if (!this.restClient) return;
    const routeKey = routeKeyForAddress(address);
    const messageId = this.lastIncomingMessageId.get(routeKey);
    if (!messageId) return;
    void this.restClient.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: TYPING_EMOJI } },
    }).then((response) => {
      const reactionId = response.data?.reaction_id;
      if (reactionId) this.typingReactions.set(routeKey, reactionId);
    }).catch(() => {});
  }

  onMessageEnd(address: ChannelAddress): void {
    if (!this.restClient) return;
    const routeKey = routeKeyForAddress(address);
    const reactionId = this.typingReactions.get(routeKey);
    const messageId = this.lastIncomingMessageId.get(routeKey);
    if (reactionId && messageId) {
      this.typingReactions.delete(routeKey);
      void this.restClient.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      }).catch(() => {});
    }
    void this.syncChatName(address.chatId);
  }

  getPreviewCapabilities(address: ChannelAddress): PreviewCapabilities | null {
    const store = this.getStore();
    if (!store.getChannelBinding(this.channelType, address.chatId, this.profileId)) {
      return null;
    }
    return {
      supported: true,
      privateOnly: false,
      finalDelivery: 'replace_preview',
    };
  }

  async sendPreview(address: ChannelAddress, text: string, draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    const processedText = preprocessFeishuMarkdown(text);
    if (!processedText.trim()) return 'skip';
    return this.previewService.sendPreview(this.withInstance(address), processedText, draftId);
  }

  async primePreview(address: ChannelAddress, draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    return this.previewService.primePreview(this.withInstance(address), draftId);
  }

  endPreview(address: ChannelAddress, draftId: number): void {
    this.previewService.endPreview(this.withInstance(address), draftId);
  }

  async sendStructuredInputRequest(
    address: ChannelAddress,
    request: StructuredInputRequestInfo,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    const hasSecret = request.questions.some((question) => question.isSecret);
    if (hasSecret) {
      await this.sendAsPost(
        address,
        '当前问题包含敏感输入，飞书群聊不适合采集。请转到本地命令行继续。',
        replyToMessageId,
      );
      getBridgeContext().permissions.resolvePendingStructuredInput?.(request.requestId, { answers: {} });
      return { ok: true };
    }
    try {
      const result = await this.sendInteractiveCard(
        address,
        buildStructuredInputCard(request),
        replyToMessageId,
      );
      return {
        ok: true,
        messageId: result.messageId,
        openMessageId: result.openMessageId,
      };
    } catch (error) {
      console.warn('[feishu-adapter] Failed to send structured input card, falling back to post:', error);
      const fallback = await this.sendAsPost(
        address,
        buildStructuredInputFallbackText(request),
        replyToMessageId,
      );
      return {
        ok: fallback.ok,
        error: fallback.error,
        messageId: fallback.messageId,
        openMessageId: fallback.openMessageId,
      };
    }
  }

  async resolveStructuredInputRequest(requestId: string): Promise<void> {
    const request = this.getStore().getStructuredInputRequest(requestId);
    if (request?.channelInstanceId !== this.profileId) return;
    if (!request?.messageId) return;
    try {
      await this.patchInteractiveCard(
        request.messageId,
        buildStructuredInputCard({
          requestId: request.requestId,
          threadId: request.threadId,
          turnId: request.turnId,
          itemId: request.itemId,
          questions: request.questions,
        }, {
          resolved: true,
          note: '该问答已完成，正在继续执行。',
          answers: request.draftAnswers,
        }),
      );
    } catch (error) {
      console.warn('[feishu-adapter] Failed to resolve structured input card:', error);
    }
  }

  shouldProjectActivityEvent(event: ActivityEvent): boolean {
    if (!isToolCallActivityEvent(event)) return true;
    return this.options.profile.showToolCallCards === true;
  }

  async upsertActivityEvent(
    address: ChannelAddress,
    event: ActivityEvent,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    if (!this.shouldProjectActivityEvent(event)) {
      return { ok: true };
    }
    return this.activityService.upsertActivityEvent(
      this.withInstance(address),
      event,
      replyToMessageId,
      true,
    );
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }
    const address = this.withInstance(message.address);

    // Check if this chat needs audio reply (user sent audio message)
    if (this.needsAudioReply(address.chatId)) {
      const text = normalizeMarkdown(message);
      console.log(`[feishu-adapter] Sending audio reply to chat ${address.chatId}`);
      const audioResult = await this.outboundAudioService.sendAudioReply(address, text, message.replyToMessageId);
      if (audioResult.success) {
        void this.maybeSyncSessionTitle(address.chatId);
        return { ok: true };
      }
      // Audio reply failed, fall back to text
      console.warn(`[feishu-adapter] Audio reply failed, falling back to text: ${audioResult.error}`);
    }

    if (message.rawCard) {
      const result = await this.sendInteractiveCard(address, message.rawCard, message.replyToMessageId);
      return {
        ok: true,
        messageId: result.messageId,
        openMessageId: result.openMessageId,
      };
    }

    if (message.inlineButtons && message.inlineButtons.length > 0) {
      return this.sendPermissionCard(
        address,
        normalizeMarkdown(message),
        message.inlineButtons,
        message.replyToMessageId,
        message.cardHeader,
      );
    }

    const finalPreview = await this.previewService.finalizePreview(address, normalizeMarkdown(message));
    if (finalPreview?.ok) {
      void this.maybeSyncSessionTitle(address.chatId);
      // 群聊回复：补发一条 post @ 发起人，让发起人/总控能收到（流式卡片不支持 @）
      await this.mentionReplyToSender(address, message.replyToMessageId);
      return finalPreview;
    }

    const text = normalizeMarkdown(message);
    // Use post (rich text) for copy-friendly messages; card only for permission buttons
    const result = await this.sendAsPost(address, text, message.replyToMessageId);
    if (result.ok) {
      void this.maybeSyncSessionTitle(address.chatId);
      // 群聊回复：补发一条 post @ 发起人
      if (result.messageId) {
        await this.mentionReplyToSender(address, message.replyToMessageId);
      }
    }
    return result;
  }

  /**
   * 群聊回复时，补发一条 post 富文本消息 @ 发起人（触发本 bot 的 sender），
   * 让发起人/总控能收到回复。流式卡片不支持 @ 提及，故需单独补发。
   * 仅群聊（group）补发，私聊（p2p）不需要 @ 发起人。
   */
  private async mentionReplyToSender(
    address: ChannelAddress,
    replyToMessageId?: string,
  ): Promise<void> {
    try {
      // 仅群聊补发 @：私聊（p2p）是一对一，不需要 @
      const binding = this.getStore().getChannelBinding(this.channelType, address.chatId, this.profileId);
      if (binding?.chatType === 'p2p') return;
      const senderId = address.userId;
      if (!senderId || senderId === this.botOpenId) return;
      const content = JSON.stringify({
        zh_cn: {
          content: [[{ tag: 'at', user_id: senderId, user_name: address.displayName || '' }]],
        },
      });
      await this.sendLarkMessage(this.withInstance(address), 'post', content, replyToMessageId);
    } catch (e) {
      console.warn('[feishu-adapter] mentionReplyToSender failed:', e);
    }
  }

  async sendImage(image: OutboundImage): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }
    try {
      const address = this.withInstance(image.address);
      const imageKey = await this.uploadImageFile(image.filePath);
      const response = await this.sendLarkMessage(
        address,
        'image',
        JSON.stringify({ image_key: imageKey }),
        image.replyToMessageId,
      );
      assertLarkOk(response, 'im.message.sendImage');
      return {
        ok: true,
        messageId: response.data?.message_id,
        openMessageId: (response.data as { open_message_id?: string } | undefined)?.open_message_id,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private appendBindingCommandExchange(binding: ChannelBinding | null, commandText: string, replyText: string): void {
    if (!binding?.codepilotSessionId) return;
    appendLocalCommandExchange(this.getStore(), binding.codepilotSessionId, commandText, replyText);
  }

  private prunePendingInboundImages(now = Date.now()): void {
    this.inboundImageService.prunePendingInboundImages(now);
  }

  private getPendingInboundImage(chatId: string, senderId: string, messageId: string, threadId?: string): PendingInboundImage | null {
    return this.inboundImageService.getPendingInboundImage(chatId, senderId, messageId, threadId);
  }

  private setPendingInboundImage(entry: PendingInboundImage): void {
    this.inboundImageService.setPendingInboundImage(entry);
  }

  private async downloadInboundImageAttachment(messageId: string, imageKey: string): Promise<FileAttachment> {
    return this.inboundImageService.downloadInboundImageAttachment(messageId, imageKey);
  }

  private async downloadAndTranscribe(messageId: string, fileKey: string): Promise<{ text: string; noSpeech?: boolean }> {
    rtLog(`[VOICE-DEBUG] downloadAndTranscribe called with messageId=${messageId}, fileKey=${fileKey}`);
    const client = this.getLarkClient().getClient();
    if (!client?.im?.messageResource?.get) {
      rtLog(`[VOICE-DEBUG] Feishu audio resource download capability unavailable`);
      throw new Error('Feishu 音频资源下载能力不可用');
    }
    rtLog(`[VOICE-DEBUG] Client and im.messageResource.get method available`);

    // 准备临时目录和文件
    const pathMod = await import('node:path');
    const osMod = await import('node:os');
    const fsp = await import('node:fs/promises');
    const tmpDir = pathMod.join(osMod.tmpdir(), 'feishu-audio');
    const tmpFile = path.join(tmpDir, `${messageId}.opus`);
    const wavFile = path.join(tmpDir, `asr_${messageId}.wav`);
    await fsp.mkdir(tmpDir, { recursive: true });

    rtLog(`[VOICE-DEBUG] Downloading audio resource from messageId=${messageId}, fileKey=${fileKey}`);
    // 使用飞书 API 下载音频文件
    const response = await client.im.messageResource.get({
      params: { type: 'file' as never },  // 音频文件用 file 类型
      path: {
        message_id: messageId,
        file_key: fileKey,
      },
    });
    rtLog(`[VOICE-DEBUG] Download response received`);

    // 从流读取数据
    const stream = response.getReadableStream();
    rtLog(`[VOICE-DEBUG] Getting readable stream from response`);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    rtLog(`[VOICE-DEBUG] Stream read complete, total chunks: ${chunks.length}`);
    const buffer = Buffer.concat(chunks);
    await fsp.writeFile(tmpFile, buffer);
    rtLog(`[VOICE-DEBUG] Audio file written to ${tmpFile}`);

    const isWin = process.platform === 'win32';

    const cleanup = async () => {
      rtLog(`[VOICE-DEBUG] Running cleanup: deleting ${tmpFile}, ${wavFile}`);
      await fsp.unlink(tmpFile).catch(() => {});
      await fsp.unlink(wavFile).catch(() => {});
      rtLog(`[VOICE-DEBUG] Cleanup completed`);
    };

    try {
      let text: string;

      if (isWin) {
        // Windows: 直接调用 ffmpeg 和 sherpa-onnx-offline.exe（当前稳定方案）
        rtLog(`[VOICE-DEBUG] Starting Windows audio processing`);
        const { spawnSync } = await import('node:child_process');
        const ffmpeg = 'C:\\Users\\oadan\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe';
        const sherpaBin = 'C:\\D\\opt\\sherpa-onnx\\bin\\sherpa-onnx-offline.exe';
        const modelDir = 'C:\\D\\opt\\sherpa-onnx\\models\\sensevoice-int8';

        rtLog(`[VOICE-DEBUG] Executing ffmpeg conversion`);
        const ffmpegResult = spawnSync(ffmpeg, ['-y', '-i', tmpFile, '-ar', '16000', '-ac', '1', '-f', 'wav', wavFile], {
          windowsHide: true,
          timeout: 30000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (ffmpegResult.error || ffmpegResult.status !== 0) {
          const errorMsg = ffmpegResult.error?.message || ffmpegResult.stderr?.toString() || 'Unknown ffmpeg error';
          console.error('[feishu-adapter] ffmpeg conversion failed:', errorMsg);
          rtLog(`[VOICE-DEBUG] ffmpeg conversion failed: ${errorMsg}`);
          throw new Error('ffmpeg 音频转换失败');
        }
        rtLog(`[VOICE-DEBUG] FFmpeg conversion completed`);

        rtLog(`[VOICE-DEBUG] Executing sherpa-onnx recognition via HTTP service`);
        const startTime = Date.now();
        const http = await import('node:http');
        
        const postData = JSON.stringify({ audioPath: wavFile });
        const options = {
          hostname: 'localhost',
          port: 18790,
          path: '/transcribe',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
        };

        const sherpaOutput = await new Promise<string>((resolve, reject) => {
          const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                const result = JSON.parse(data);
                if (result.error) {
                  reject(new Error(result.error));
                } else {
                  resolve(result.text || '');
                }
              } catch (e) {
                reject(new Error(`解析 ASR 响应失败: ${e.message}`));
              }
            });
          });
          req.on('error', reject);
          req.write(postData);
          req.end();
        });

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        rtLog(`[VOICE-DEBUG] Sherpa-onnx recognition completed (${elapsed}s)`);
        rtLog(`[VOICE-DEBUG] Sherpa raw output: "${sherpaOutput.substring(0, 200)}"`);
        text = sherpaOutput;

        // Step 4: 标点恢复 (内置 add-punctuation，不再依赖 voice-engine)
        if (text) {
          rtLog(`[VOICE-DEBUG] Starting punctuation recovery`);
          try {
            const { addPunctuation } = await import('./add-punctuation.mjs');
            const punctOut = addPunctuation(text);
            if (punctOut) text = String(punctOut).trim();
            rtLog(`[VOICE-DEBUG] Punctuation recovery completed: "${text.substring(0, 50)}..."`);
          } catch (e) {
            rtLog(`[VOICE-DEBUG] Punctuation recovery skipped: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          rtLog(`[VOICE-DEBUG] No text extracted from sherpa output`);
        }
      } else {
        // Linux: ffmpeg 转 wav + HTTP 调内建 asr-service（与 Windows 统一，不依赖 voice-engine）
        rtLog(`[VOICE-DEBUG] Starting Linux audio processing`);
        const { spawnSync } = await import('node:child_process');
        const ffmpeg = process.env.ASR_FFMPEG_BIN || 'ffmpeg';
        const ffmpegResult = spawnSync(ffmpeg, ['-y', '-i', tmpFile, '-ar', '16000', '-ac', '1', '-f', 'wav', wavFile], {
          timeout: 30000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (ffmpegResult.error || ffmpegResult.status !== 0) {
          const errorMsg = ffmpegResult.error?.message || ffmpegResult.stderr?.toString() || 'Unknown ffmpeg error';
          throw new Error(`ffmpeg 音频转换失败: ${errorMsg.slice(0, 300)}`);
        }

        const { request } = await import('node:http');
        const postData = JSON.stringify({ audioPath: wavFile });
        const sherpaOutput = await new Promise<string>((resolve, reject) => {
          const req = request({
            hostname: '127.0.0.1',
            port: Number(process.env.ASR_SERVICE_PORT || 18790),
            path: '/transcribe',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(postData),
            },
            timeout: 60000,
          }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
              try {
                const result = JSON.parse(data);
                if (result.error) reject(new Error(result.error));
                else resolve(result.text || '');
              } catch (e) {
                reject(new Error(`解析 ASR 响应失败: ${e instanceof Error ? e.message : String(e)}`));
              }
            });
          });
          req.on('error', reject);
          req.on('timeout', () => req.destroy(new Error('ASR 服务请求超时')));
          req.write(postData);
          req.end();
        });
        text = sherpaOutput;
        rtLog(`[VOICE-DEBUG] Linux audio processing completed: "${text.substring(0, 50)}..."`);
      }

      await cleanup();
      rtLog(`[VOICE-DEBUG] downloadAndTranscribe completed successfully, returning text`);
      return { text, noSpeech: !text.trim() };
    } catch (error) {
      rtLog(`[VOICE-DEBUG] downloadAndTranscribe caught error: ${error instanceof Error ? error.message : String(error)}`);
      await cleanup();
      throw error;
    }
  }

  private resolveReferencedInboundImages(
    chatId: string,
    senderId: string,
    threadId: string | undefined,
    referenceIds: Array<string | undefined>,
  ): { attachments?: FileAttachment[]; errorMessage?: string } {
    return this.inboundImageService.resolveReferencedInboundImages(
      chatId,
      senderId,
      threadId,
      referenceIds,
    );
  }

  private resolveLatestPendingImageForChat(
    chatId: string,
    senderId: string,
    threadId?: string,
  ): { attachments?: FileAttachment[]; errorMessage?: string; key?: string } | null {
    const entry = this.inboundImageService.getLatestPendingImageForChat(
      chatId,
      senderId,
      threadId,
    );
    if (!entry) return null;
    if (entry.attachments?.length) {
      return { attachments: entry.attachments, key: entry.key };
    }
    return {
      errorMessage: entry.errorMessage || '这张图片暂时无法读取，请重新发送图片后再直接回复文字。',
      key: entry.key,
    };
  }

  private setPendingAudioReply(chatId: string, needsAudio: boolean): void {
    this.pendingAudioReply.set(chatId, needsAudio);
  }

  private clearPendingAudioReply(chatId: string): void {
    this.pendingAudioReply.delete(chatId);
  }

  private needsAudioReply(chatId: string): boolean {
    const needs = this.pendingAudioReply.get(chatId) || false;
    // Clear after checking (one-time use)
    // 持续语音模式：直到用户发文本消息才清除，而不是一次性消耗
    return needs;
  }

  private async handleIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    return handleIncomingEventWithContext(this.getHandlerContext(), data);
  }

  private async handleCardAction(event: StructuredActionEvent): Promise<{ toast: { type: string; content: string } }> {
    return handleCardActionWithContext(this.getHandlerContext(), event);
  }

  private async patchActionCardSafely(
    messageId: string | undefined,
    card: Record<string, unknown>,
    kind: string,
    openMessageId?: string,
  ): Promise<void> {
    return patchActionCardSafelyWithContext(this.getHandlerContext(), messageId, card, kind, openMessageId);
  }

  private findBindingById(bindingId: string): ChannelBinding | null {
    return findBindingByIdWithContext(this.getHandlerContext(), bindingId);
  }

  private extractActionSenderIdentity(event: StructuredActionEvent): SenderIdentity | null {
    return extractActionSenderIdentityWithContext(this.getHandlerContext(), event);
  }

  private resolveActionChatId(event: StructuredActionEvent): string | undefined {
    return event.context?.open_chat_id || undefined;
  }

  private getRecentWorkspaceOptions(): RecentWorkspaceOption[] {
    const store = this.getStore();
    return listRecentWorkspaces(
      store.listChannelBindings(this.channelType),
      store.getSetting('bridge_default_work_dir') || process.cwd(),
      10,
      [...listClaudeNativeWorkspaces(), ...listCodexNativeWorkspaces()],
    );
  }

  private resolveSelectedWorkdir(formValue?: Record<string, unknown>): string {
    const selected = collectTextFragments(formValue?.[NEW_SESSION_WORKDIR_FIELD]);
    if (selected[0]) {
      return normalizePath(selected[0]);
    }
    const fallback = this.getRecentWorkspaceOptions()[0]?.value
      || this.getStore().getSetting('bridge_default_work_dir')
      || process.cwd();
    return normalizePath(fallback);
  }

  private buildSessionReadyMessage(runtime: RuntimeName, binding: ChannelBinding): string {
    if (runtime === 'claude') {
      const modeTitle = getClaudeModeTitle(resolveClaudeBindingMode(binding));
      return [
        `已创建 Claude 会话，当前 mode：**${modeTitle}**。`,
        '后续直接在本群发送消息继续对话。',
        '可用命令：`/stop` 中断当前输出、`/mode` 切换 mode、`/reset` 重置会话。权限请求请直接使用卡片按钮处理。',
      ].join('\n');
    }
    if (runtime === 'zcode') {
      return [
        '已创建 ZCode 会话。',
        '后续直接在本群发送消息继续对话。',
        '可用命令：`/stop` 中断当前输出、`/reset` 重置会话。',
      ].join('\n');
    }
    if (runtime === 'mimo') {
      return [
        '已创建 MiMo 会话，已绑定当前私聊窗口。',
        '后续直接发消息继续对话。',
        '可用命令：`/stop` 中断当前输出、`/reset` 重置会话。',
      ].join('\n');
    }
    if (runtime === 'gemini') {
      return [
        '已创建 Gemini 会话，已绑定当前私聊窗口。',
        '后续直接发消息继续对话。',
        '可用命令：`/stop` 中断当前输出、`/reset` 重置会话。',
      ].join('\n');
    }
    return [
      `已创建 codex 会话，当前模式：**${binding.mode === 'plan' ? 'Plan' : '默认'}**。`,
      '后续请直接在本群继续对话。',
      '可用命令：`/stop` 中断当前输出、`/mode` 切换 mode、`/reset` 重置会话。',
    ].join('\n');
  }

  private async ensureRuntimeAvailable(runtime: RuntimeName): Promise<void> {
    const llm = getBridgeContext().llm as MultiplexLLMProvider & {
      ensureRuntimeAvailable?: (target: RuntimeName) => Promise<void>;
    };
    await llm.ensureRuntimeAvailable?.(runtime);
  }

  private async createBoundSession(
    runtime: RuntimeName,
    sender: SenderIdentity,
    options?: {
      claudePermissionMode?: ClaudePermissionMode;
      cwd?: string;
      bindingMode?: 'code' | 'plan' | 'ask';
      skipReadyMessage?: boolean;
      existingChatId?: string;
      model?: string;
    },
  ): Promise<{ chatId: string; binding: ChannelBinding }> {
    await this.ensureRuntimeAvailable(runtime);
    const store = this.getStore();
    // Use existing chat ID if provided (e.g., for mimo p2p binding), otherwise create new group
    const chatId = options?.existingChatId || await this.createSessionGroup(runtime, sender, options?.claudePermissionMode);
    const session = store.createRuntimeSession({
      runtime,
      model: options?.model || '',
      cwd: options?.cwd || store.getSetting('bridge_default_work_dir') || process.cwd(),
      systemPrompt: buildSystemPrompt(runtime),
    });
    const initialBinding = store.upsertChannelBinding({
      channelType: this.channelType,
      channelInstanceId: this.profileId,
      chatId,
      codepilotSessionId: session.id,
      workingDirectory: session.working_directory,
      model: session.model,
      chatType: options?.existingChatId ? 'p2p' : 'group',
      ...(runtime === 'claude'
        ? { claudePermissionMode: options?.claudePermissionMode || 'default' }
        : {}),
    });
    // claude 用 sdkSessionId 做 --resume，/new 必须清空旧会话，否则会接回旧 Claude session
    // hermes/codex 也同样逻辑，清空旧 sdkSessionId 确保创建新 ACP session
    // reasonix 同样需要（2026-08-09 修复）：/new 后清空旧 sdkSessionId，避免引擎 resume 回旧会话
    // dsh 同样需要：ACP 缓存 key 是 sdkSessionId，/new 后已 reset，旧 id 无对应引擎
    if (runtime === 'claude' || runtime === 'hermes' || runtime === 'codex' || runtime === 'reasonix' || runtime === 'dsh') {
      store.updateChannelBinding(initialBinding.id, { sdkSessionId: '' });
    }
    if (options?.bindingMode && initialBinding.mode !== options.bindingMode) {
      store.updateChannelBinding(initialBinding.id, { mode: options.bindingMode });
    }
    const binding = store.getChannelBinding(this.channelType, chatId, this.profileId) || initialBinding;
    await this.syncChatName(chatId);
    if (!options?.skipReadyMessage) {
      await this.sendAsPost(
        { channelType: this.channelType, channelInstanceId: this.profileId, chatId },
        this.buildSessionReadyMessage(runtime, binding),
      );
    }
    return { chatId, binding };
  }

  private async sendClaudeModeCard(
    address: ChannelAddress,
    scope: 'new' | 'switch',
    replyToMessageId?: string,
    options?: {
      selectedMode?: ClaudePermissionMode;
      bindingId?: string;
      note?: string;
    },
  ): Promise<SendResult> {
    const result = await this.sendInteractiveCard(
      address,
      buildClaudeModeCard(scope, options),
      replyToMessageId,
    );
    return {
      ok: true,
      messageId: result.messageId,
      openMessageId: result.openMessageId,
    };
  }

  private async sendNewSessionCard(
    address: ChannelAddress,
    runtime: RuntimeName,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    const workspaces = this.getRecentWorkspaceOptions();
    const card = runtime === 'codex'
      ? buildNewCodexSessionCard(workspaces)
      : runtime === 'mimo'
        ? buildNewMimoSessionCard(workspaces)
        : runtime === 'gemini'
          ? buildNewGeminiSessionCard(workspaces)
          : buildNewClaudeSessionCard(workspaces);
    const result = await this.sendInteractiveCard(address, card, replyToMessageId);
    return {
      ok: true,
      messageId: result.messageId,
      openMessageId: result.openMessageId,
    };
  }

  private async handleDirectMessage(sender: SenderIdentity, inbound: InboundMessage): Promise<void> {
    return handleDirectMessageWithContext(this.getHandlerContext(), sender, inbound);
  }

  private async handleGroupMessage(_sender: SenderIdentity, inbound: InboundMessage): Promise<void> {
    return handleGroupMessageWithContext(this.getHandlerContext(), _sender, inbound);
  }

  private async handleCreateSessionCommand(sender: SenderIdentity, inbound: InboundMessage, runtime: RuntimeName): Promise<void> {
    return handleCreateSessionCommandWithContext(this.getHandlerContext(), sender, inbound, runtime);
  }

  private async handleResumeSessionCommand(
    _sender: SenderIdentity,
    inbound: InboundMessage,
    runtime: RuntimeName,
  ): Promise<void> {
    return handleResumeSessionCommandWithContext(this.getHandlerContext(), _sender, inbound, runtime);
  }

  private async handleNewSessionCardAction(
    event: StructuredActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    return handleNewSessionCardActionWithContext(this.getHandlerContext(), event, callbackData);
  }

  private async handleResumeCardAction(
    event: StructuredActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    return handleResumeCardActionWithContext(this.getHandlerContext(), event, callbackData);
  }

  private async handleInterruptCardAction(
    event: StructuredActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    return handleInterruptCardActionWithContext(this.getHandlerContext(), event, callbackData);
  }

  private async replayNativeSessionHistory(
    address: ChannelAddress,
    runtime: RuntimeName,
    items: NativeReplayItem[],
  ): Promise<void> {
    return replayNativeSessionHistoryWithContext(this.getHandlerContext(), address, runtime, items);
  }

  private async handleResetCommand(address: ChannelAddress, replyToMessageId?: string): Promise<void> {
    return handleResetCommandWithContext(this.getHandlerContext(), address, replyToMessageId);
  }

  private async handleModeCommand(bindingId: string, text: string, address: ChannelAddress, replyToMessageId?: string): Promise<void> {
    return handleModeCommandWithContext(this.getHandlerContext(), bindingId, text, address, replyToMessageId);
  }

  private async handlePlanCommand(bindingId: string, inbound: InboundMessage): Promise<void> {
    return handlePlanCommandWithContext(this.getHandlerContext(), bindingId, inbound);
  }

  private async handlePlanWorkflowMessage(bindingId: string, workflowId: string, inbound: InboundMessage): Promise<boolean> {
    return handlePlanWorkflowMessageWithContext(this.getHandlerContext(), bindingId, workflowId, inbound);
  }

  private buildPlanRequestInbound(
    address: ChannelAddress,
    messageId: string,
    workflowId: string,
    requestText: string,
    options?: {
      attemptId?: string;
      promptText?: string;
      attachments?: FileAttachment[];
    },
  ): InboundMessage {
    return {
      messageId,
      address,
      text: requestText,
      timestamp: Date.now(),
      ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
      bridgeMeta: {
        planWorkflow: {
          kind: 'plan_request',
          workflowId,
          ...(options?.attemptId ? { attemptId: options.attemptId } : {}),
          promptText: options?.promptText || buildPlanningPrompt(requestText),
          storedUserText: requestText,
          permissionMode: 'plan',
        },
      },
    };
  }

  private buildNativePlanRequestInbound(
    address: ChannelAddress,
    messageId: string,
    workflowId: string,
    requestText: string,
    options?: {
      attemptId?: string;
      attachments?: FileAttachment[];
    },
  ): InboundMessage {
    return {
      messageId,
      address,
      text: requestText,
      timestamp: Date.now(),
      ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
      bridgeMeta: {
        planWorkflow: {
          kind: 'native_plan_request',
          workflowId,
          ...(options?.attemptId ? { attemptId: options.attemptId } : {}),
          promptText: requestText,
          storedUserText: requestText,
          permissionMode: 'plan',
          collaborationMode: 'plan',
        },
      },
    };
  }

  private buildPlanExecutionInbound(
    address: ChannelAddress,
    messageId: string,
    workflowId: string,
    requestText: string,
    options?: {
      attemptId?: string;
      permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
      planText?: string;
    },
  ): InboundMessage {
    const storedUserText = `执行已确认计划：${requestText}`;
    return {
      messageId,
      address,
      text: storedUserText,
      timestamp: Date.now(),
      bridgeMeta: {
        planWorkflow: {
          kind: 'plan_execute',
          workflowId,
          ...(options?.attemptId ? { attemptId: options.attemptId } : {}),
          promptText: buildClaudePlanExecutionPrompt(requestText, options?.planText),
          storedUserText,
          permissionMode: options?.permissionMode || 'acceptEdits',
          collaborationMode: 'default',
        },
      },
    };
  }

  private async handleClaudeModeCardAction(
    event: StructuredActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    const parts = callbackData.split(':');
    const scope = parts[1];
    const bindingId = scope === 'switch' ? parts[2] : '';
    const rawMode = scope === 'switch' ? parts[3] : parts[2];
    const mode = normalizeClaudePermissionMode(rawMode);
    if (!mode || (scope !== 'new' && scope !== 'switch')) {
      return { toast: { type: 'warning', content: 'Unsupported action' } };
    }

    const actionMessageId = resolveActionOpenMessageId(event);

    if (scope === 'new') {
      const sender = this.extractActionSenderIdentity(event);
      if (!sender) {
        return { toast: { type: 'warning', content: '无法识别当前操作人' } };
      }
      const cwd = this.resolveSelectedWorkdir(event.action?.form_value as Record<string, unknown> | undefined);
      try {
        await this.createBoundSession('claude', sender, {
          claudePermissionMode: mode,
          cwd,
        });
        await this.patchActionCardSafely(
          undefined,
          buildStatusCard(
            'Claude 会话已创建',
            `工作区：\`${cwd}\`\n\n当前 mode：**${getClaudeModeTitle(mode)}**。\n\n请直接进入新群继续对话。`,
            'green',
          ),
          'claude-mode',
          actionMessageId,
        );
        return { toast: { type: 'success', content: `已创建 ${getClaudeModeTitle(mode)} 会话` } };
      } catch (error) {
        console.error('[feishu-adapter] Failed to create Claude session from mode card:', error);
        return {
          toast: {
            type: 'warning',
            content: `创建会话失败：${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
    }

    const binding = bindingId ? this.findBindingById(bindingId) : null;
    if (!binding) {
      return { toast: { type: 'warning', content: '当前群尚未绑定会话' } };
    }
    const runtime = this.getStore().getSessionExt(binding.codepilotSessionId)?.runtime || this.getDefaultRuntime();
    if (runtime !== 'claude') {
      return { toast: { type: 'warning', content: '当前群不是 Claude 会话' } };
    }

    const currentMode = resolveClaudeBindingMode(binding);
    if (currentMode !== mode) {
      this.getStore().updateChannelBinding(binding.id, {
        claudePermissionMode: mode,
        mode: 'code',
      });
      await this.syncChatName(binding.chatId);
    }
    await this.patchActionCardSafely(
      undefined,
      buildClaudeModeCard('switch', {
        selectedMode: mode,
        bindingId: binding.id,
        note: `已切换到 **${getClaudeModeTitle(mode)}**。`,
      }),
      'claude-mode',
      actionMessageId,
    );
    return {
      toast: {
        type: 'success',
        content: currentMode === mode
          ? `当前已是 ${getClaudeModeTitle(mode)}`
          : `已切换到 ${getClaudeModeTitle(mode)}`,
      },
    };
  }

  private async handleStructuredInputCardAction(
    event: StructuredActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    return handleStructuredInputCardActionWithContext(this.getHandlerContext(), event, callbackData);
  }

  private async handlePlanCardAction(
    event: lark.InteractiveCardActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    return handlePlanCardActionWithContext(this.getHandlerContext(), event, callbackData);
  }

  private async handleClaudePlanExitCardAction(
    event: lark.InteractiveCardActionEvent,
    callbackData: string,
  ): Promise<{ toast: { type: string; content: string } }> {
    return handleClaudePlanExitCardActionWithContext(this.getHandlerContext(), event, callbackData);
  }

  private async createSessionGroup(
    runtime: RuntimeName,
    sender: SenderIdentity,
    claudePermissionMode?: ClaudePermissionMode,
  ): Promise<string> {
    if (!this.restClient) throw new Error('Feishu client not initialized');
    const initialName = defaultChatName(runtime, claudePermissionMode);
    const response = await this.restClient.im.chat.create({
      params: {
        user_id_type: sender.type,
        set_bot_manager: true,
      },
      data: {
        name: initialName,
        chat_mode: 'group',
        chat_type: 'private',
        group_message_type: 'chat',
        user_id_list: [sender.id],
      },
    });
    assertLarkOk(response, 'im.chat.create');
    const chatId = response.data?.chat_id;
    if (!chatId) throw new Error('Create group succeeded without chat_id');
    this.knownChatNames.set(chatId, initialName);
    return chatId;
  }

  private chatNameKey(chatId: string, name: string): string {
    return `${chatId}\u0000${name}`;
  }

  private pruneSelfRenameEchoes(now = Date.now()): void {
    for (const [key, expiresAt] of this.selfRenameEchoes) {
      if (expiresAt <= now) this.selfRenameEchoes.delete(key);
    }
  }

  private rememberObservedChatName(chatId: string, name: string): void {
    this.knownChatNames.set(chatId, name);
  }

  private rememberSelfRename(chatId: string, name: string): void {
    this.pruneSelfRenameEchoes();
    this.selfRenameEchoes.set(
      this.chatNameKey(chatId, name),
      Date.now() + FeishuAdapter.SELF_RENAME_ECHO_TTL_MS,
    );
  }

  private consumeSelfRenameEcho(chatId: string, name: string): boolean {
    this.pruneSelfRenameEchoes();
    const key = this.chatNameKey(chatId, name);
    const expiresAt = this.selfRenameEchoes.get(key);
    if (!expiresAt || expiresAt <= Date.now()) {
      this.selfRenameEchoes.delete(key);
      return false;
    }
    this.selfRenameEchoes.delete(key);
    return true;
  }

  private async handleChatUpdatedEvent(data: FeishuChatUpdatedEventData): Promise<void> {
    const chatId = data.chat_id?.trim();
    const beforeName = data.before_change?.name?.trim() || '';
    const afterName = data.after_change?.name?.trim() || '';
    if (!chatId || !afterName) return;

    this.rememberObservedChatName(chatId, afterName);
    if (beforeName === afterName || this.consumeSelfRenameEcho(chatId, afterName)) return;

    const store = this.getStore();
    const binding = store.getChannelBinding(this.channelType, chatId, this.profileId);
    if (!binding) return;

    store.updateSessionExt(binding.codepilotSessionId, {
      title: afterName,
      titleStatus: 'done',
      displayNameMode: 'manual_locked',
    });

    const llm = getBridgeContext().llm as MultiplexLLMProvider & {
      writeSessionTitle?: (sessionId: string, title: string) => Promise<void>;
    };
    try {
      await llm.writeSessionTitle?.(binding.codepilotSessionId, afterName);
    } catch (error) {
      console.warn('[feishu-adapter] Failed to push manual title to runtime:', error);
    }
  }

  private async handleMessageRecalledEvent(data: FeishuMessageRecalledEventData): Promise<void> {
    const messageId = data.message_id?.trim();
    const chatId = data.chat_id?.trim();
    if (!messageId || !chatId) return;

    console.log(`[feishu-adapter] Message recalled: ${messageId} in chat ${chatId}`);

    // Clear lastIncomingMessageId if the recalled message was the last one
    const routeKey = routeKeyForAddress({
      channelType: this.channelType,
      channelInstanceId: this.profileId,
      chatId,
    });
    if (this.lastIncomingMessageId.get(routeKey) === messageId) {
      this.lastIncomingMessageId.delete(routeKey);
      console.log(`[feishu-adapter] Cleared lastIncomingMessageId for route ${routeKey}`);
    }

    // Clear typing reaction if exists
    if (this.typingReactions.has(routeKey)) {
      this.typingReactions.delete(routeKey);
    }

    // Clean up preview artifacts for this chat
    const previewKeyPrefix = routeKey;
    for (const [key, artifact] of this.previewService.previewArtifacts) {
      if (key.startsWith(previewKeyPrefix) && artifact.messageId === messageId) {
        this.previewService.previewArtifacts.delete(key);
        console.log(`[feishu-adapter] Cleaned up preview artifact for recalled message`);
      }
    }
  }

  private async maybeSyncSessionTitle(chatId: string): Promise<void> {
    if (this.pendingTitleSyncs.has(chatId)) return;
    const store = this.getStore();
    const binding = store.getChannelBinding(this.channelType, chatId, this.profileId);
    if (!binding) return;

    const llm = getBridgeContext().llm as MultiplexLLMProvider & {
      readSessionTitle?: (sessionId: string) => Promise<string | null>;
      writeSessionTitle?: (sessionId: string, title: string) => Promise<void>;
    };

    this.pendingTitleSyncs.add(chatId);
    try {
      const ext = store.getSessionExt(binding.codepilotSessionId);
      if (!ext || ext.displayNameMode === 'native_locked') return;

      if (ext.displayNameMode === 'manual_locked') {
        const manualTitle = ext.title?.trim();
        if (!manualTitle) return;
        const runtimeTitle = (await llm.readSessionTitle?.(binding.codepilotSessionId))?.trim() || '';
        if (runtimeTitle === manualTitle) return;
        await llm.writeSessionTitle?.(binding.codepilotSessionId, manualTitle);
        return;
      }

      const runtimeTitle = (await llm.readSessionTitle?.(binding.codepilotSessionId))?.trim();
      if (!runtimeTitle) return;
      if (runtimeTitle === (ext.title || '').trim() && ext.titleStatus === 'done') return;

      store.updateSessionExt(binding.codepilotSessionId, {
        title: runtimeTitle,
        titleStatus: 'done',
        displayNameMode: 'default',
      });
      await this.syncChatName(chatId);
    } catch (error) {
      console.warn('[feishu-adapter] Failed to sync session title:', error);
    } finally {
      this.pendingTitleSyncs.delete(chatId);
    }
  }

  private shouldDecoratePlan(bindingId: string, mode: 'code' | 'plan' | 'ask'): boolean {
    if (mode === 'plan') return true;
    return !!this.getStore().getActivePlanWorkflowByBinding(bindingId);
  }

  private computeChatDisplayName(chatId: string): string | null {
    const store = this.getStore();
    const binding = store.getChannelBinding(this.channelType, chatId, this.profileId);
    if (!binding) return null;
    const ext = store.getSessionExt(binding.codepilotSessionId);
    if ((ext?.displayNameMode === 'native_locked' || ext?.displayNameMode === 'manual_locked') && ext.title) {
      return ext.title;
    }
    const runtime = ext?.runtime || this.getDefaultRuntime();
    const baseName = stripClaudeModeSuffix(ext?.title || defaultChatName(runtime));
    if (runtime === 'claude') {
      return `${baseName}${getClaudeModeSuffix(resolveClaudeBindingMode(binding))}`;
    }
    if (!this.shouldDecoratePlan(binding.id, binding.mode)) {
      return baseName;
    }
    return `${baseName}${PLAN_SUFFIX}`;
  }

  private async syncChatName(chatId: string): Promise<void> {
    // Disabled: do not modify group names per user request
    return;
  }

  private extractSenderIdentity(data: FeishuMessageEventData): SenderIdentity | null {
    const senderId = data.sender.sender_id;
    if (senderId?.open_id) return { id: senderId.open_id, type: 'open_id' };
    if (senderId?.user_id) return { id: senderId.user_id, type: 'user_id' };
    if (senderId?.union_id) return { id: senderId.union_id, type: 'union_id' };
    return null;
  }

  private getClientConfig(): { appId: string; appSecret: string; domain: lark.Domain } {
    const store = this.tryGetStore();
    const appId = this.options.profile.appId || store?.getSetting('bridge_feishu_app_id') || '';
    const appSecret = this.options.profile.appSecret || store?.getSetting('bridge_feishu_app_secret') || '';
    const domain = (this.options.profile.domain || store?.getSetting('bridge_feishu_domain') || '') === 'lark'
      ? lark.Domain.Lark
      : lark.Domain.Feishu;
    return { appId, appSecret, domain };
  }

  private tryGetStore(): JsonFileStore | null {
    try {
      return getBridgeContext().store as JsonFileStore;
    } catch {
      return null;
    }
  }

  private getStore(): JsonFileStore {
    return getBridgeContext().store as JsonFileStore;
  }

  private enqueue(msg: InboundMessage): void {
    // 已被"取消消息"按钮标记作废的消息直接丢弃
    if (this.cancelledMessageIds.has(msg.messageId)) {
      this.cancelledMessageIds.delete(msg.messageId);
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      // 方案 C（优先队列）：新消息插队到队列最前面，当前任务完成后立即优先处理
      this.queue.unshift(msg);
    }
  }

  private async enqueueChatTask(chatId: string, task: () => Promise<void>): Promise<void> {
    // 优先队列（方案 C）：新消息在全局 queue 插队（见 enqueue 的 unshift），不打断当前任务
    const previous = this.chatQueues.get(chatId) || Promise.resolve();
    const next = previous.then(task, task);
    this.chatQueues.set(chatId, next);
    try {
      await next;
    } finally {
      if (this.chatQueues.get(chatId) === next) {
        this.chatQueues.delete(chatId);
      }
    }
  }

  /** Ingest message to OpenHuman memory_tree for semantic search.
   * Called when OpenHuman runtime is active to build searchable memory index.
   */
  private async ingestToMemoryTree(
    chatId: string,
    senderId: string,
    text: string,
    messageId: string,
  ): Promise<void> {
    const coreUrl = process.env.OPENHUMAN_CORE_URL || 'http://localhost:7788/rpc';
    const coreToken = process.env.OPENHUMAN_CORE_TOKEN || '';

    // Build ChatBatch payload for memory_tree_ingest
    // Use OpenHuman user ID (from config or default) as owner, not feishu senderId
    const openhumanUserId = process.env.OPENHUMAN_USER_ID || '6a0bd5556b16f2d8e561ee92';
    const payload = {
      source_kind: 'chat',
      source_id: `feishu:${chatId}:${senderId}`,
      owner: openhumanUserId,
      tags: ['feishu', 'channel'],
      payload: {
        platform: 'feishu',
        channel_label: chatId,
        messages: [
          {
            author: senderId,
            timestamp: Date.now(),
            text,
            source_ref: `feishu://message/${messageId}`,
          },
        ],
      },
    };

    try {
      const response = await fetch(coreUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(coreToken ? { 'Authorization': `Bearer ${coreToken}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'openhuman.memory_tree_ingest',
          params: payload,
        }),
      });

      if (!response.ok) {
        console.warn('[feishu-adapter] memory_tree_ingest HTTP error:', response.status);
        return;
      }

      const result = await response.json() as { result?: { chunks_written?: number; chunks_dropped?: number }; error?: { message: string } };
      if (result.error) {
        console.warn('[feishu-adapter] memory_tree_ingest error:', result.error.message);
      } else {
        console.log('[feishu-adapter] memory_tree_ingest success:', result.result);
      }
    } catch (error) {
      console.warn('[feishu-adapter] memory_tree_ingest failed:', error);
    }
  }

  private async sendPermissionCard(
    address: ChannelAddress,
    text: string,
    buttons: NonNullable<OutboundMessage['inlineButtons']>,
    replyToMessageId?: string,
    cardHeader?: OutboundMessage['cardHeader'],
  ): Promise<SendResult> {
    const card = cardHeader
      ? buildActionCard(cardHeader.title, text, buttons, cardHeader.template || 'blue')
      : buildPermissionCard(text, buttons);
    const result = await this.sendInteractiveCard(address, card, replyToMessageId);
    return {
      ok: true,
      messageId: result.messageId,
      openMessageId: result.openMessageId,
    };
  }

  private buildDividerInfo(address: ChannelAddress): AgentDividerInfo | undefined {
    // Build divider info if enabled (same logic as sendAsInteractiveCard/sendAsPost)
    if (this.options.profile.showAgentDivider ?? true) {
      const store = this.getStore();
      const binding = store.getChannelBinding(this.channelType, address.chatId, this.profileId);
      const session = binding?.codepilotSessionId ? store.getSession(binding.codepilotSessionId) : null;
      const sessionExt = binding?.codepilotSessionId ? store.getSessionExt(binding.codepilotSessionId) : null;

      // Get runtime from session extension, default to 'mimo'
      const runtime = sessionExt?.runtime || this.getDefaultRuntime();
      const runtimeConfig = getRuntimeConfig(runtime);

      // Use runtime config for model and provider
      // Priority: runtime config (live) > session snapshot > binding (legacy) > N/A
      const modelName = runtimeConfig.model || session?.model || 'N/A';
      const providerName = runtimeConfig.provider || 'N/A';

      const cacheStats = this.buildCacheDivider(binding);

      const dividerInfo: AgentDividerInfo = {
        agent: runtimeConfig.displayName || this.options.profile.agentName || this.profileId,
        model: modelName,
        provider: providerName,
        session: binding?.sdkSessionId?.substring(0, 8) || binding?.codepilotSessionId?.substring(0, 8) || 'N/A',
        ...(cacheStats ? { cacheHitRate: cacheStats.lastRate, cacheAvgRate: cacheStats.avgRate, contextPercent: cacheStats.contextPercent || undefined } : {}),
      };
      // 2026-08-09 修复：reasonix 余额补进 buildDividerInfo（预览卡片/骨架走此方法，之前漏加导致
      // 正常文字回复不带余额，只有走 sendAsPost 的语音兜底路径才显示）。
      // 2026-08-14 扩展：dsh（ACP 直连 deepseek）同样显示余额。
      // 同步读 60s 缓存（不阻塞预览渲染）；同时异步刷新缓存（缓存有效时内部直接返回，过期才打接口），
      // 保证每轮对话显示的余额最多滞后 60 秒。
      if (isDirectDeepSeekProfile(this.profileId)) {
        if (balanceCache) {
          dividerInfo.balance = balanceCache.value;
        }
        void fetchDeepSeekBalance();
      }
      return dividerInfo;
    }
    return undefined;
  }

  /** 计算当前 session 的缓存命中率（最近一轮 + 平均）和上下文占用百分比，供 meta 行显示 */
  private buildCacheDivider(binding: ChannelBinding | null): { lastRate: number; avgRate: number; contextPercent: number } | null {
    let cacheStats: { lastRate: number; avgRate: number; contextPercent: number } | null = null;
    const sid = binding?.codepilotSessionId;
    if (sid) {
      const s = getSessionCacheStats(sid);
      rtLog(`[cacheStats] session=${sid.slice(0, 8)} stats=${s ? JSON.stringify({ lastTotal: s.lastTotal, sumHit: s.sumHit, sumMiss: s.sumMiss }) : 'null'}`);
      if (s && s.lastTotal > 0) {
        const lastRate = (s.lastHit / s.lastTotal) * 100;
        const avgRate = (s.sumHit / (s.sumHit + s.sumMiss)) * 100;
        // 非 reasonix bot 无 prompt tokens 数据源，contextPercent 留 0（由调用方决定是否显示）
        cacheStats = { lastRate, avgRate, contextPercent: 0 };
      }
    }
    if (!cacheStats) {
      cacheStats = readAgentCacheStats(this.profileId);
      rtLog(`[cacheStats] ${this.profileId} fallback: ${cacheStats ? `${cacheStats.lastRate.toFixed(2)}/${cacheStats.avgRate.toFixed(2)} ctx=${cacheStats.contextPercent.toFixed(2)}%` : 'null'}`);
    }
    return cacheStats;
  }

  private async sendAsInteractiveCard(
    address: ChannelAddress,
    text: string,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    // Build divider info if enabled
    let dividerInfo: AgentDividerInfo | undefined;
    if (this.options.profile.showAgentDivider ?? true) {
      const store = this.getStore();
      const binding = store.getChannelBinding(this.channelType, address.chatId, this.profileId);
      const session = binding?.codepilotSessionId ? store.getSession(binding.codepilotSessionId) : null;
      const sessionExt = binding?.codepilotSessionId ? store.getSessionExt(binding.codepilotSessionId) : null;

      // Get runtime from session extension, default to 'mimo'
      const runtime = sessionExt?.runtime || this.getDefaultRuntime();
      const runtimeConfig = getRuntimeConfig(runtime);

      // Use runtime config for model and provider
      // Priority: runtime config (live) > session snapshot > binding (legacy) > N/A
      const modelName = runtimeConfig.model || session?.model || 'N/A';
      const providerName = runtimeConfig.provider || 'N/A';

      const cacheStats2 = this.buildCacheDivider(binding);
      dividerInfo = {
        agent: runtimeConfig.displayName || this.options.profile.agentName || this.profileId,
        model: modelName,
        provider: providerName,
        session: binding?.sdkSessionId?.substring(0, 8) || binding?.codepilotSessionId?.substring(0, 8) || 'N/A',
        ...(cacheStats2 ? { cacheHitRate: cacheStats2.lastRate, cacheAvgRate: cacheStats2.avgRate, contextPercent: cacheStats2.contextPercent || undefined } : {}),
        ...(isDirectDeepSeekProfile(this.profileId) ? { balance: await fetchDeepSeekBalance() ?? undefined } : {}),
      };
    }

    const content = buildCardContent(text, dividerInfo);
    const response = await this.sendLarkMessage(this.withInstance(address), 'interactive', content, replyToMessageId);
    assertLarkOk(response, 'im.message.sendInteractive');
    return {
      ok: true,
      messageId: response.data?.message_id,
      openMessageId: (response.data as { open_message_id?: string } | undefined)?.open_message_id,
    };
  }

  private shouldUseUserToken(): boolean {
    return this.options.profile.enableUserMode === true && this.larkClient.getUserAccessToken() !== null;
  }

  private async sendAsPost(
    address: ChannelAddress,
    text: string,
    replyToMessageId?: string,
    forceBotToken?: boolean,
  ): Promise<SendResult> {
    // Build divider info if enabled (same logic as sendAsInteractiveCard)
    let dividerInfo: AgentDividerInfo | undefined;
    if (this.options.profile.showAgentDivider ?? true) {
      const store = this.getStore();
      const binding = store.getChannelBinding(this.channelType, address.chatId, this.profileId);
      const session = binding?.codepilotSessionId ? store.getSession(binding.codepilotSessionId) : null;
      const sessionExt = binding?.codepilotSessionId ? store.getSessionExt(binding.codepilotSessionId) : null;

      // Get runtime from session extension, default to 'mimo'
      const runtime = sessionExt?.runtime || this.getDefaultRuntime();
      const runtimeConfig = getRuntimeConfig(runtime);

      // Use runtime config for model and provider
      // Priority: runtime config (live) > session snapshot > binding (legacy) > N/A
      const modelName = runtimeConfig.model || session?.model || 'N/A';
      const providerName = runtimeConfig.provider || 'N/A';

      const cacheStats2 = this.buildCacheDivider(binding);
      dividerInfo = {
        agent: runtimeConfig.displayName || this.options.profile.agentName || this.profileId,
        model: modelName,
        provider: providerName,
        session: binding?.sdkSessionId?.substring(0, 8) || binding?.codepilotSessionId?.substring(0, 8) || 'N/A',
        ...(cacheStats2 ? { cacheHitRate: cacheStats2.lastRate, cacheAvgRate: cacheStats2.avgRate, contextPercent: cacheStats2.contextPercent || undefined } : {}),
        ...(isDirectDeepSeekProfile(this.profileId) ? { balance: await fetchDeepSeekBalance() ?? undefined } : {}),
      };
    }

    const content = buildPostContent(text, dividerInfo);
    const useUserToken = forceBotToken ? false : this.shouldUseUserToken();
    const response = await this.sendLarkMessage(this.withInstance(address), 'post', content, replyToMessageId, undefined, useUserToken);
    assertLarkOk(response, 'im.message.sendPost');
    return {
      ok: true,
      messageId: response.data?.message_id,
      openMessageId: (response.data as { open_message_id?: string } | undefined)?.open_message_id,
    };
  }

  private async sendInteractiveCard(
    address: ChannelAddress,
    card: Record<string, unknown> | lark.InteractiveCard,
    replyToMessageId?: string,
    requestUuid?: string,
  ): Promise<{ messageId: string; openMessageId?: string }> {
    const useUserToken = this.shouldUseUserToken();
    return this.larkClient.sendCard(
      this.withInstance(address),
      card,
      replyToMessageId,
      requestUuid,
      useUserToken,
    );
  }

  private async uploadImageFile(filePath: string): Promise<string> {
    return this.larkClient.uploadImage(filePath);
  }

  private async sendLarkMessage(
    address: ChannelAddress,
    msgType: 'interactive' | 'post' | 'image',
    content: string,
    replyToMessageId?: string,
    requestUuid?: string,
    useUserToken?: boolean,
  ): Promise<{ code?: number; msg?: string; data?: { message_id?: string; open_message_id?: string; chat_id?: string } }> {
    return this.larkClient.sendMessage(address, msgType, content, replyToMessageId, requestUuid, useUserToken);
  }

  private async patchInteractiveCard(
    messageId: string,
    card: Record<string, unknown>,
    options?: { messageIdType?: 'message_id' | 'open_message_id' },
  ): Promise<void> {
    return this.larkClient.patchCard(messageId, card, options);
  }

  private async deleteMessageQuietly(messageId: string): Promise<void> {
    return this.larkClient.deleteMessageQuietly(messageId);
  }
}
