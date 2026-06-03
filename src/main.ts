/**
 * Daemon entry point for agents-to-im.
 *
 * Assembles all DI implementations and starts the bridge.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { initBridgeContext } from './bridge/context.js';
import * as bridgeManager from './bridge/bridge-manager.js';

import { loadConfig, configToSettings, CTI_HOME, type Config } from './config/config.js';
import { compactConversation, applyCompactResult } from './bridge/compact.js';
import { FeishuAdapter } from './feishu/adapter.js';
import { MultiplexLLMProvider } from './providers/multiplex.js';
import { JsonFileStore } from './infra/store.js';
import { PendingApprovals, PendingPermissions, PendingStructuredInputs } from './providers/claude/permission-gateway.js';
import { setupLogger } from './config/logger.js';
import { startDashboard, stopDashboard } from './infra/dashboard.js';

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  lastExitReason?: string;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // Merge with existing status to preserve fields like lastExitReason
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* first write */ }
  const merged = { ...existing, ...info };
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_FILE);
}

async function main(): Promise<void> {
  const config = loadConfig();
  setupLogger();

  const runId = crypto.randomUUID();
  const startTime = Date.now();
  console.log(`[agents-to-im] Starting bridge (run_id: ${runId})`);

  const settings = configToSettings(config);
  // Add compact config to settings for JsonFileStore
  settings.set('compact_model', config.compact.model);
  settings.set('compact_max_tokens', String(config.compact.maxTokens));
  settings.set('compact_temperature', String(config.compact.temperature));
  settings.set('compact_clear_sdk_session', String(config.compact.clearSdkSession));
    // Permission mode: bypassPermissions skips all tool confirmations
    const permMode = process.env.CTI_PERMISSION_MODE || 'bypassPermissions';
    settings.set('claude_permission_mode', permMode);
    console.log('[agents-to-im] Permission mode:', permMode);
  const store = new JsonFileStore(settings);
  (globalThis as any).__ctiStore = store;
  store.migrateLegacySessions(config.defaultRuntime);
  // 启动时清空所有 Codex thread ID，防止 Codex app-server 重启后 "no rollout found"
  // 因为 Codex app-server 的 thread 状态在重启后会丢失
  const clearedThreads = store.clearAllCodexThreadIds();
  if (clearedThreads > 0) {
    console.log(`[agents-to-im] Cleared ${clearedThreads} stale Codex thread IDs on startup`);
  }
  const pendingPerms = new PendingPermissions();
  const pendingApprovals = new PendingApprovals();
  const pendingStructuredInputs = new PendingStructuredInputs();
  const llm = new MultiplexLLMProvider(store, pendingPerms, pendingApprovals, pendingStructuredInputs, config);
  console.log('[agents-to-im] Runtime selection: per-session multiplex (claude/codex)');
  const feishuAdapter = new FeishuAdapter({
    profile: config.feishu,
  });
  const enabledChannelIds: string[] = [];
  const configError = feishuAdapter.validateConfig();
  if (configError) {
    console.warn(`[agents-to-im] Skip Feishu adapter ${feishuAdapter.adapterId}: ${configError}`);
  } else {
    bridgeManager.registerAdapter(feishuAdapter);
    enabledChannelIds.push(feishuAdapter.adapterId);
  }

  const gateway = {
    resolvePendingPermission: (
      id: string,
      resolution: { behavior: 'allow' | 'deny'; message?: string; updatedPermissions?: unknown[]; interrupt?: boolean },
    ) => (
      pendingPerms.resolve(id, resolution)
      || pendingApprovals.resolve(id, resolution)
    ),
    resolvePendingStructuredInput: (
      requestId: string,
      resolution: { answers: Record<string, { answers: string[] }> },
    ) => pendingStructuredInputs.resolve(requestId, resolution),
  };

  initBridgeContext({
    store,
    llm,
    permissions: gateway,
    lifecycle: {
      onBridgeStart: () => {
        // Write authoritative PID from the actual process (not shell $!)
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
        writeStatus({
          running: true,
          pid: process.pid,
          runId,
          startedAt: new Date().toISOString(),
          channels: enabledChannelIds,
        });
        console.log(
          `[agents-to-im] Bridge started (PID: ${process.pid}, channels: ${enabledChannelIds.join(', ') || 'none'})`,
        );
      },
      onBridgeStop: () => {
        writeStatus({ running: false });
        console.log('[agents-to-im] Bridge stopped');
      },
    },
  });

  await bridgeManager.start();

  // Start the dashboard status panel
  try {
    startDashboard({
      store,
      getUptime: () => (Date.now() - startTime) / 1000,
      getBridgeStatus: bridgeManager.getStatus,
    });
  } catch (err) {
    console.warn('[agents-to-im] Dashboard failed to start:', err instanceof Error ? err.message : err);
  }

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`[agents-to-im] Shutting down (${reason})...`);
    pendingPerms.denyAll();
    pendingApprovals.denyAll();
    pendingStructuredInputs.denyAll();
    stopDashboard();
    await llm.dispose();
    await bridgeManager.stop();
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // ── Exit diagnostics ──
  process.on('unhandledRejection', (reason) => {
    console.error('[agents-to-im] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
    writeStatus({ running: false, lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}` });
  });
  process.on('uncaughtException', (err) => {
    console.error('[agents-to-im] uncaughtException:', err.stack || err.message);
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    process.exit(1);
  });
  process.on('beforeExit', (code) => {
    console.log(`[agents-to-im] beforeExit (code: ${code})`);
  });
  process.on('exit', (code) => {
    console.log(`[agents-to-im] exit (code: ${code})`);
  });

  // ── Heartbeat to keep event loop alive ──
  // setInterval is ref'd by default, preventing Node from exiting
  // when the event loop would otherwise be empty.
  setInterval(() => { /* keepalive */ }, 45_000);

  // ── Idle-compact: LLM summarize sessions idle > 1.5h with accumulated messages ──
  const IDLE_COMPACT_INTERVAL_MS = 30 * 60 * 1000; // Check every 30 minutes
  const IDLE_THRESHOLD_MS = 90 * 60 * 1000; // 1.5 hours idle
  const MIN_MESSAGES_FOR_COMPACT = 20; // Only compact sessions with enough messages

  setInterval(async () => {
    try {
      const store = (globalThis as any).__ctiStore;
      if (!store) return;
      // 每次执行时重新加载配置，确保运行时修改 config.env 生效
      const config2 = loadConfig();
      const now = Date.now();
      const bindings = store.listChannelBindings?.() || [];
      for (const binding of bindings) {
        if (!binding.active) continue;
        const updatedAt = new Date(binding.updatedAt).getTime();
        if (isNaN(updatedAt) || now - updatedAt < IDLE_THRESHOLD_MS) continue;
        const msgCount = store.getMessages(binding.codepilotSessionId, { limit: 999 })?.messages?.length || 0;
        if (msgCount < MIN_MESSAGES_FOR_COMPACT) continue;
        // Idle session with enough messages — LLM summarize
        const sid = binding.codepilotSessionId;
        console.log(`[idle-compact] Compacting session ${sid} (idle ${Math.round((now - updatedAt) / 60000)}min, ${msgCount} msgs)`);
        const result = await compactConversation(store, sid, config2.compact);
        if (result.success) {
          applyCompactResult(store, sid, result);
          if (config2.compact.clearSdkSession) {
            store.updateSdkSessionId(sid, '');
          }
          console.log(`[idle-compact] 压缩完成: ${result.originalCount} 条消息 → 摘要`);
          // Send feishu notification so the user knows compact ran
          if (binding.channelType === 'feishu' && binding.chatId) {
            const notified = await feishuAdapter.sendNotification(
              binding.chatId,
              `🔄 会话已自动压缩（${result.originalCount} 条消息 → 摘要）。下一条消息将使用压缩后的上下文。`,
            );
            if (notified) console.log(`[idle-compact] 已通知飞书 chat ${binding.chatId}`);
          }
        } else {
          console.warn(`[idle-compact] 压缩失败: ${result.error}`);
        }
      }
    } catch (err) {
      console.error('[idle-compact] Error:', err);
    }
  }, IDLE_COMPACT_INTERVAL_MS);
}

main().catch((err) => {
  console.error('[agents-to-im] Fatal error:', err instanceof Error ? err.stack || err.message : err);
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  process.exit(1);
});
