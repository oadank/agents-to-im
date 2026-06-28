import type { LLMProvider, StreamChatParams } from '../bridge/host.js';

import type { Config } from '../config/config.js';
import { CodexProvider } from './codex/codex-provider.js';
import { SDKLLMProvider } from './claude/sdk-provider.js';
import { OpenHumanProvider, createOpenHumanProvider } from './openhuman/openhuman-provider.js';
import { ZCodeProvider, createZCodeProvider } from './zcode/zcode-provider.js';
import { MiMoProvider } from './mimo/mimo-provider.js';
import { GeminiProvider, createGeminiProvider } from './gemini/gemini-provider.js';
import { preflightCheck, resolveClaudeCliPath } from './claude/cli-support.js';
import { PendingApprovals, type PendingPermissions, PendingStructuredInputs } from './claude/permission-gateway.js';
import {
  ClaudeRuntimeDriver,
  CodexRuntimeDriver,
  OpenHumanRuntimeDriver,
  ZCodeRuntimeDriver,
  MiMoRuntimeDriver,
  GeminiRuntimeDriver,
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
  private geminiProvider: GeminiProvider | null = null;
  private claudeDriver: ClaudeRuntimeDriver | null = null;
  private codexDriver: CodexRuntimeDriver | null = null;
  private openhumanDriver: OpenHumanRuntimeDriver | null = null;
  private zcodeDriver: ZCodeRuntimeDriver | null = null;
  private mimoDriver: MiMoRuntimeDriver | null = null;
  private geminiDriver: GeminiRuntimeDriver | null = null;
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
      throw new Error(`Claude CLI preflight check failed: ${check.error}`);
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

  private async getGeminiProvider(): Promise<GeminiProvider> {
    if (this.geminiProvider) return this.geminiProvider;
    this.geminiProvider = createGeminiProvider();
    return this.geminiProvider;
  }

  protected async getProvider(runtime: RuntimeName): Promise<LLMProvider> {
    if (runtime === 'codex') return this.getCodexProvider();
    if (runtime === 'openhuman') return this.getOpenHumanProvider();
    if (runtime === 'zcode') return this.getZCodeProvider();
    if (runtime === 'mimo') return this.getMiMoProvider();
    if (runtime === 'gemini') return this.getGeminiProvider();
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
