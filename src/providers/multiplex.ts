import type { LLMProvider, StreamChatParams } from '../bridge/host.js';

import type { Config } from '../config/config.js';
import { CodexProvider } from './codex/codex-provider.js';
import { SDKLLMProvider } from './claude/sdk-provider.js';
import { OpenHumanProvider, createOpenHumanProvider } from './openhuman/openhuman-provider.js';
import { ZCodeProvider, createZCodeProvider } from './zcode/zcode-provider.js';
import { MiMoProvider } from './mimo/mimo-provider.js';
import { OpencodeProvider } from './opencode/opencode-provider.js';
import { ReasonixProvider } from './reasonix/reasonix-provider.js';
import { DshProvider, createDshProvider } from './dsh/dsh-provider.js';
import { OpenClawProvider } from './openclaw/openclaw-provider.js';
import { GeminiProvider, createGeminiProvider } from './gemini/gemini-provider.js';
import { HermesProvider, createHermesProvider } from './hermes/hermes-provider.js';
import { OpenAkitaProvider } from './openakita/openakita-provider.js';
import { preflightCheck, resolveClaudeCliPath } from './claude/cli-support.js';
import { PendingApprovals, type PendingPermissions, PendingStructuredInputs } from './claude/permission-gateway.js';
import {
  ClaudeRuntimeDriver,
  CodexRuntimeDriver,
  OpenHumanRuntimeDriver,
  ZCodeRuntimeDriver,
  MiMoRuntimeDriver,
  OpencodeRuntimeDriver,
  ReasonixRuntimeDriver,
  DshRuntimeDriver,
  OpenClawRuntimeDriver,
  GeminiRuntimeDriver,
  HermesRuntimeDriver,
  OpenAkitaRuntimeDriver,
  type RuntimeDriver,
} from '../runtime/driver.js';
import {
  RUNTIME_CAPABILITIES,
  type ProviderCapabilities,
} from '../runtime/capabilities.js';
import type { RuntimeName } from '../runtime/types.js';
import { JsonFileStore } from '../infra/store.js';

export type { ProviderCapabilities } from '../runtime/capabilities.js';

export class MultiplexLLMProvider implements LLMProvider {
  private claudeProvider: SDKLLMProvider | null = null;
  private codexProvider: CodexProvider | null = null;
  private openhumanProvider: OpenHumanProvider | null = null;
  private zcodeProvider: ZCodeProvider | null = null;
  private mimoProvider: MiMoProvider | null = null;
  private opencodeProvider: OpencodeProvider | null = null;
  private reasonixProvider: ReasonixProvider | null = null;
  private dshProvider: DshProvider | null = null;
  private openclawProvider: OpenClawProvider | null = null;
  private geminiProvider: GeminiProvider | null = null;
  private hermesProvider: HermesProvider | null = null;
  private openakitaProvider: OpenAkitaProvider | null = null;
  private claudeDriver: ClaudeRuntimeDriver | null = null;
  private codexDriver: CodexRuntimeDriver | null = null;
  private openhumanDriver: OpenHumanRuntimeDriver | null = null;
  private zcodeDriver: ZCodeRuntimeDriver | null = null;
  private mimoDriver: MiMoRuntimeDriver | null = null;
  private opencodeDriver: OpencodeRuntimeDriver | null = null;
  private reasonixDriver: ReasonixRuntimeDriver | null = null;
  private dshDriver: DshRuntimeDriver | null = null;
  private openclawDriver: OpenClawRuntimeDriver | null = null;
  private geminiDriver: GeminiRuntimeDriver | null = null;
  private hermesDriver: HermesRuntimeDriver | null = null;
  private openakitaDriver: OpenAkitaRuntimeDriver | null = null;
  private claudeCliPath: string | null = null;
  private readonly pendingApprovals: PendingApprovals;
  private readonly pendingStructuredInputs: PendingStructuredInputs;
  private readonly config: Config;

  constructor(
    private readonly store: JsonFileStore,
    private readonly pendingPerms: PendingPermissions,
    pendingApprovals: PendingApprovals | Config,
    pendingStructuredInputs?: PendingStructuredInputs,
    config?: Config,
  ) {
    if (config) {
      this.pendingApprovals = pendingApprovals as PendingApprovals;
      this.pendingStructuredInputs = pendingStructuredInputs || new PendingStructuredInputs();
      this.config = config;
      return;
    }
    this.pendingApprovals = new PendingApprovals();
    this.pendingStructuredInputs = new PendingStructuredInputs();
    this.config = pendingApprovals as Config;
  }

  private getSessionRuntime(sessionId: string): RuntimeName {
    return this.store.getSessionExt(sessionId)?.runtime || 'claude';
  }

  getRuntimeCapabilities(runtime: RuntimeName): ProviderCapabilities {
    return { ...RUNTIME_CAPABILITIES[runtime] };
  }

  getSessionCapabilities(sessionId: string): ProviderCapabilities {
    return this.getRuntimeCapabilities(this.getSessionRuntime(sessionId));
  }

  private async getClaudeProvider(): Promise<SDKLLMProvider> {
    if (this.claudeProvider) return this.claudeProvider;
    const cliPath = resolveClaudeCliPath(this.config);
    if (!cliPath) {
      throw new Error(
        'Cannot find the `claude` CLI executable. Install Claude Code CLI and ensure it is available in PATH.',
      );
    }
    const check = preflightCheck(cliPath);
    if (!check.ok) {
      console.warn(`[llm-provider] Claude CLI preflight check failed: ${check.error}, proceeding anyway`);
    }
    this.claudeCliPath = cliPath;
    this.claudeProvider = new SDKLLMProvider(
      this.pendingPerms,
      this.pendingStructuredInputs,
      cliPath,
    );
    return this.claudeProvider;
  }

  private async getCodexProvider(): Promise<CodexProvider> {
    if (this.codexProvider) return this.codexProvider;
    const provider = new CodexProvider(this.pendingApprovals, this.pendingStructuredInputs);
    await provider.prepare();
    // 检测 Codex 进程是否重启了，如果重启则清空所有 thread id
    if (provider.didPidChange()) {
      const cleared = this.store.clearAllCodexThreadIds();
      if (cleared > 0) {
        console.log(`[multiplex] Codex process restarted, cleared ${cleared} thread IDs`);
      }
      provider.resetPidChanged();
    }
    this.codexProvider = provider;
    return provider;
  }

  private async getOpenHumanProvider(): Promise<OpenHumanProvider> {
    if (this.openhumanProvider) return this.openhumanProvider;
    this.openhumanProvider = createOpenHumanProvider();
    return this.openhumanProvider;
  }

  private async getZCodeProvider(): Promise<ZCodeProvider> {
    if (this.zcodeProvider) return this.zcodeProvider;
    this.zcodeProvider = createZCodeProvider();
    return this.zcodeProvider;
  }

  private async getMiMoProvider(): Promise<MiMoProvider> {
    if (this.mimoProvider) return this.mimoProvider;
    this.mimoProvider = new MiMoProvider();
    return this.mimoProvider;
  }

  private async getOpencodeProvider(): Promise<OpencodeProvider> {
    if (this.opencodeProvider) return this.opencodeProvider;
    this.opencodeProvider = new OpencodeProvider();
    return this.opencodeProvider;
  }

  private async getReasonixProvider(): Promise<ReasonixProvider> {
    if (this.reasonixProvider) return this.reasonixProvider;
    this.reasonixProvider = new ReasonixProvider();
    return this.reasonixProvider;
  }

  private async getDshProvider(): Promise<DshProvider> {
    if (this.dshProvider) return this.dshProvider;
    this.dshProvider = createDshProvider();
    return this.dshProvider;
  }

  private async getOpenClawProvider(): Promise<OpenClawProvider> {
    if (this.openclawProvider) return this.openclawProvider;
    this.openclawProvider = new OpenClawProvider();
    return this.openclawProvider;
  }

  private async getGeminiProvider(): Promise<GeminiProvider> {
    if (this.geminiProvider) return this.geminiProvider;
    this.geminiProvider = createGeminiProvider();
    return this.geminiProvider;
  }

  private async getHermesProvider(): Promise<HermesProvider> {
    if (this.hermesProvider) return this.hermesProvider;
    this.hermesProvider = createHermesProvider();
    return this.hermesProvider;
  }

  private async getOpenAkitaProvider(): Promise<OpenAkitaProvider> {
    if (this.openakitaProvider) return this.openakitaProvider;
    this.openakitaProvider = new OpenAkitaProvider();
    return this.openakitaProvider;
  }

  /** 重置指定 runtime 的 provider 缓存（/new 用）：清 ACP 会话 + 删持久化 session 文件，下次消息必然全新空白会话 */
  async resetProviderCache(runtime: RuntimeName, sessionId?: string): Promise<void> {
    const provider = await this.getProvider(runtime);
    // ACP 类 runtime 提供 resetSession（kill + 清缓存 + 删磁盘 session 文件）
    const acp = provider as unknown as { resetSession?: (key?: string) => void; clearCache?: () => void };
    if (typeof acp.resetSession === 'function') {
      // ⚠️ 2026-08-09 修复：必须传真实 sessionId（acpCache 的 key 是 sdkSessionId 而非 'default'），
      // 否则 resetSession 找不到缓存的引擎进程，kill 不生效，/new 无法真正新建空白会话。
      acp.resetSession(sessionId);
      console.log(`[multiplex] resetProviderCache: ${runtime} session reset done${sessionId ? ` (key=${sessionId.slice(0, 8)})` : ''}`);
    } else if (typeof acp.clearCache === 'function') {
      acp.clearCache();
      console.log(`[multiplex] resetProviderCache: ${runtime} cache cleared (no disk session reset)`);
    } else {
      console.log(`[multiplex] resetProviderCache: ${runtime} has no reset/clear method, skipped`);
    }
  }

  protected async getProvider(runtime: RuntimeName): Promise<LLMProvider> {
    if (runtime === 'codex') return this.getCodexProvider();
    if (runtime === 'openhuman') return this.getOpenHumanProvider();
    if (runtime === 'zcode') return this.getZCodeProvider();
    if (runtime === 'mimo') return this.getMiMoProvider();
    if (runtime === 'opencode') return this.getOpencodeProvider();
    if (runtime === 'reasonix') return this.getReasonixProvider();
    if (runtime === 'dsh') return this.getDshProvider();
    if (runtime === 'openclaw') return this.getOpenClawProvider();
    if (runtime === 'gemini') return this.getGeminiProvider();
    if (runtime === 'hermes') return this.getHermesProvider();
    if (runtime === 'openakita') return this.getOpenAkitaProvider();
    return this.getClaudeProvider();
  }

  private getDriver(runtime: RuntimeName): RuntimeDriver {
    if (runtime === 'codex') {
      if (!this.codexDriver) {
        this.codexDriver = new CodexRuntimeDriver(
          this.store,
          this.config,
          () => this.getProvider('codex') as Promise<CodexProvider>,
        );
      }
      return this.codexDriver;
    }
    if (runtime === 'openhuman') {
      if (!this.openhumanDriver) {
        this.openhumanDriver = new OpenHumanRuntimeDriver(
          this.store,
          this.config,
          () => this.getProvider('openhuman') as Promise<OpenHumanProvider>,
        );
      }
      return this.openhumanDriver;
    }
    if (runtime === 'zcode') {
      if (!this.zcodeDriver) {
        this.zcodeDriver = new ZCodeRuntimeDriver(
          this.store,
          this.config,
          () => this.getProvider('zcode') as Promise<ZCodeProvider>,
        );
      }
      return this.zcodeDriver;
    }
    if (runtime === 'mimo') {
      if (!this.mimoDriver) {
        this.mimoDriver = new MiMoRuntimeDriver(
          this.store,
          this.config,
          () => this.getProvider('mimo') as Promise<MiMoProvider>,
        );
      }
      return this.mimoDriver;
    }
    if (runtime === 'opencode') {
      if (!this.opencodeDriver) {
        this.opencodeDriver = new OpencodeRuntimeDriver(
          this.store,
          this.config,
          () => this.getProvider('opencode') as Promise<OpencodeProvider>,
        );
      }
      return this.opencodeDriver;
    }
    if (runtime === 'reasonix') {
      if (!this.reasonixDriver) {
        this.reasonixDriver = new ReasonixRuntimeDriver(
          this.store,
          this.config,
          () => this.getProvider('reasonix') as Promise<ReasonixProvider>,
        );
      }
      return this.reasonixDriver;
    }
    if (runtime === 'dsh') {
      if (!this.dshDriver) {
        this.dshDriver = new DshRuntimeDriver(
          this.store,
          this.config,
          () => this.getProvider('dsh') as Promise<DshProvider>,
        );
      }
      return this.dshDriver;
    }
    if (runtime === 'openclaw') {
      if (!this.openclawDriver) {
        this.openclawDriver = new OpenClawRuntimeDriver(
          this.store,
          this.config,
          () => this.getProvider('openclaw') as Promise<OpenClawProvider>,
        );
      }
      return this.openclawDriver;
    }
    if (runtime === 'gemini') {
      if (!this.geminiDriver) {
        this.geminiDriver = new GeminiRuntimeDriver(
          this.store,
          this.config,
          () => this.getProvider('gemini') as Promise<GeminiProvider>,
        );
      }
      return this.geminiDriver;
    }
    if (runtime === 'hermes') {
      if (!this.hermesDriver) {
        this.hermesDriver = new HermesRuntimeDriver(
          this.store,
          this.config,
          () => this.getProvider('hermes') as Promise<HermesProvider>,
        );
      }
      return this.hermesDriver;
    }
    if (runtime === 'openakita') {
      if (!this.openakitaDriver) {
        this.openakitaDriver = new OpenAkitaRuntimeDriver(
          this.store,
          this.config,
          () => this.getProvider('openakita') as Promise<OpenAkitaProvider>,
        );
      }
      return this.openakitaDriver;
    }
    if (!this.claudeDriver) {
      this.claudeDriver = new ClaudeRuntimeDriver(
        this.store,
        this.config,
        () => this.getProvider('claude') as Promise<SDKLLMProvider>,
      );
    }
    return this.claudeDriver;
  }

  async ensureRuntimeAvailable(runtime: RuntimeName): Promise<void> {
    await this.getDriver(runtime).prepare();
  }

  async ensureCodexNativePlanAvailable(): Promise<void> {
    const driver = this.getDriver('codex');
    await driver.prepare();
    const provider = await this.getCodexProvider();
    if (!(await provider.supportsNativePlan())) {
      throw new Error('本地 Codex 版本不支持原生 plan 模式');
    }
  }

  private streamWithRuntime(runtime: RuntimeName, params: StreamChatParams): ReadableStream<string> {
    const self = this;
    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          try {
            const driver = self.getDriver(runtime);
            await driver.prepare();
            const reader = (await driver.streamTurn(params)).getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            controller.close();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            controller.enqueue(`data: ${JSON.stringify({ type: 'error', data: message })}\n`);
            controller.close();
          }
        })().catch((error) => {
          controller.error(error);
        });
      },
    });
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    return this.streamWithRuntime(this.getSessionRuntime(params.sessionId), params);
  }

  async readSessionTitle(sessionId: string): Promise<string | null> {
    const runtime = this.getSessionRuntime(sessionId);
    return this.getDriver(runtime).readSessionTitle(sessionId);
  }

  async writeSessionTitle(sessionId: string, title: string): Promise<void> {
    const runtime = this.getSessionRuntime(sessionId);
    await this.getDriver(runtime).writeSessionTitle(sessionId, title);
  }

  async dispose(): Promise<void> {
    await this.codexDriver?.dispose?.();
  }
}
