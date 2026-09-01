import type { StreamChatParams } from '../bridge/host.js';
import type { Config } from '../config/config.js';
import {
  readClaudeSessionTitle,
  writeClaudeSessionTitle,
} from '../infra/native-session-history.js';
import { JsonFileStore } from '../infra/store.js';
import { CodexProvider } from '../providers/codex/codex-provider.js';
import { SDKLLMProvider } from '../providers/claude/sdk-provider.js';
import { OpenHumanProvider } from '../providers/openhuman/openhuman-provider.js';
import { ZCodeProvider } from '../providers/zcode/zcode-provider.js';
import { MiMoProvider } from '../providers/mimo/mimo-provider.js';
import { OpencodeProvider } from '../providers/opencode/opencode-provider.js';
import { ReasonixProvider } from '../providers/reasonix/reasonix-provider.js';
import { DshProvider } from '../providers/dsh/dsh-provider.js';
import { OpenClawProvider } from '../providers/openclaw/openclaw-provider.js';
import { GeminiProvider } from '../providers/gemini/gemini-provider.js';
import { HermesProvider } from '../providers/hermes/hermes-provider.js';
import { OpenAkitaProvider } from '../providers/openakita/openakita-provider.js';
import type { RuntimeName } from './types.js';
import { RUNTIME_CAPABILITIES, type ProviderCapabilities } from './capabilities.js';

export interface RuntimeDriver {
  readonly runtime: RuntimeName;
  readonly capabilities: ProviderCapabilities;
  prepare(): Promise<void>;
  streamTurn(params: StreamChatParams): Promise<ReadableStream<string>>;
  readSessionTitle(sessionId: string): Promise<string | null>;
  writeSessionTitle(sessionId: string, title: string): Promise<void>;
  dispose?(): Promise<void>;
}

abstract class BaseRuntimeDriver implements RuntimeDriver {
  abstract readonly runtime: RuntimeName;
  readonly capabilities: ProviderCapabilities;

  constructor(
    protected readonly store: JsonFileStore,
    protected readonly config: Config,
    runtime: RuntimeName,
  ) {
    this.capabilities = { ...RUNTIME_CAPABILITIES[runtime] };
  }

  abstract prepare(): Promise<void>;
  abstract streamTurn(params: StreamChatParams): Promise<ReadableStream<string>>;
  abstract readSessionTitle(sessionId: string): Promise<string | null>;
  abstract writeSessionTitle(sessionId: string, title: string): Promise<void>;
}

export class ClaudeRuntimeDriver extends BaseRuntimeDriver {
  readonly runtime = 'claude' as const;

  constructor(
    store: JsonFileStore,
    config: Config,
    private readonly providerLoader: () => Promise<SDKLLMProvider>,
  ) {
    super(store, config, 'claude');
  }

  async prepare(): Promise<void> {
    await this.providerLoader();
  }

  async streamTurn(params: StreamChatParams): Promise<ReadableStream<string>> {
    const provider = await this.providerLoader();
    return provider.streamChat(params);
  }

  async readSessionTitle(sessionId: string): Promise<string | null> {
    const nativeSessionId = this.store.getSessionSdkSessionId(sessionId);
    const session = this.store.getSession(sessionId);
    if (!nativeSessionId || !session?.working_directory) return null;
    return readClaudeSessionTitle(nativeSessionId, session.working_directory);
  }

  async writeSessionTitle(sessionId: string, title: string): Promise<void> {
    const nativeSessionId = this.store.getSessionSdkSessionId(sessionId);
    const session = this.store.getSession(sessionId);
    if (!nativeSessionId || !session?.working_directory) return;
    writeClaudeSessionTitle(nativeSessionId, session.working_directory, title);
  }
}

export class CodexRuntimeDriver extends BaseRuntimeDriver {
  readonly runtime = 'codex' as const;

  constructor(
    store: JsonFileStore,
    config: Config,
    private readonly providerLoader: () => Promise<CodexProvider>,
  ) {
    super(store, config, 'codex');
  }

  async prepare(): Promise<void> {
    const provider = await this.providerLoader();
    if (typeof (provider as CodexProvider).prepare === 'function') {
      await provider.prepare();
    }
  }

  async streamTurn(params: StreamChatParams): Promise<ReadableStream<string>> {
    const provider = await this.providerLoader();
    return provider.streamChat(params);
  }

  async readSessionTitle(sessionId: string): Promise<string | null> {
    const threadId = this.store.getCodexThreadId(sessionId) || this.store.getSessionSdkSessionId(sessionId);
    if (!threadId) return null;
    const provider = await this.providerLoader();
    return provider.readSessionTitle(threadId);
  }

  async writeSessionTitle(sessionId: string, title: string): Promise<void> {
    const threadId = this.store.getCodexThreadId(sessionId) || this.store.getSessionSdkSessionId(sessionId);
    if (!threadId) return;
    const provider = await this.providerLoader();
    await provider.writeSessionTitle(threadId, title);
  }

  async dispose(): Promise<void> {
    const provider = await this.providerLoader();
    if (typeof (provider as CodexProvider).close === 'function') {
      await provider.close();
    }
  }
}

export class OpenHumanRuntimeDriver extends BaseRuntimeDriver {
  readonly runtime = 'openhuman' as const;

  constructor(
    store: JsonFileStore,
    config: Config,
    private readonly providerLoader: () => Promise<OpenHumanProvider>,
  ) {
    super(store, config, 'openhuman');
  }

  async prepare(): Promise<void> {
    // OpenHuman 不需要 prepare，直接可用
  }

  async streamTurn(params: StreamChatParams): Promise<ReadableStream<string>> {
    const provider = await this.providerLoader();
    return provider.streamChat(params);
  }

  async readSessionTitle(_sessionId: string): Promise<string | null> {
    // OpenHuman 不支持 session title 存储
    return null;
  }

  async writeSessionTitle(_sessionId: string, _title: string): Promise<void> {
    // OpenHuman 不支持 session title 存储
  }
}

export class ZCodeRuntimeDriver extends BaseRuntimeDriver {
  readonly runtime = 'zcode' as const;

  constructor(
    store: JsonFileStore,
    config: Config,
    private readonly providerLoader: () => Promise<ZCodeProvider>,
  ) {
    super(store, config, 'zcode');
  }

  async prepare(): Promise<void> {
    const provider = await this.providerLoader();
    await provider.prepare();
  }

  async streamTurn(params: StreamChatParams): Promise<ReadableStream<string>> {
    const provider = await this.providerLoader();
    return provider.streamChat(params);
  }

  async readSessionTitle(_sessionId: string): Promise<string | null> {
    return null;
  }

  async writeSessionTitle(_sessionId: string, _title: string): Promise<void> {
    // ZCode 不支持 session title 存储
  }
}

export class MiMoRuntimeDriver extends BaseRuntimeDriver {
  readonly runtime = 'mimo' as const;

  constructor(
    store: JsonFileStore,
    config: Config,
    private readonly providerLoader: () => Promise<MiMoProvider>,
  ) {
    super(store, config, 'mimo');
  }

  async prepare(): Promise<void> {
    const provider = await this.providerLoader();
    await provider.prepare();
  }

  async streamTurn(params: StreamChatParams): Promise<ReadableStream<string>> {
    const provider = await this.providerLoader();
    return provider.streamChat(params);
  }

  async readSessionTitle(_sessionId: string): Promise<string | null> {
    return null;
  }

  async writeSessionTitle(_sessionId: string, _title: string): Promise<void> {
    // MiMo 不支持 session title 存储
  }
}

export class OpencodeRuntimeDriver extends BaseRuntimeDriver {
  readonly runtime = 'opencode' as const;

  constructor(
    store: JsonFileStore,
    config: Config,
    private readonly providerLoader: () => Promise<OpencodeProvider>,
  ) {
    super(store, config, 'opencode');
  }

  async prepare(): Promise<void> {
    const provider = await this.providerLoader();
    await provider.prepare();
  }

  async streamTurn(params: StreamChatParams): Promise<ReadableStream<string>> {
    const provider = await this.providerLoader();
    return provider.streamChat(params);
  }

  async readSessionTitle(_sessionId: string): Promise<string | null> {
    return null;
  }

  async writeSessionTitle(_sessionId: string, _title: string): Promise<void> {
    // Opencode 不支持 session title 存储
  }
}

export class OpenClawRuntimeDriver extends BaseRuntimeDriver {
  readonly runtime = 'openclaw' as const;

  constructor(
    store: JsonFileStore,
    config: Config,
    private readonly providerLoader: () => Promise<OpenClawProvider>,
  ) {
    super(store, config, 'openclaw');
  }

  async prepare(): Promise<void> {
    const provider = await this.providerLoader();
    await provider.prepare();
  }

  async streamTurn(params: StreamChatParams): Promise<ReadableStream<string>> {
    const provider = await this.providerLoader();
    return provider.streamChat(params);
  }

  async readSessionTitle(_sessionId: string): Promise<string | null> {
    return null;
  }

  async writeSessionTitle(_sessionId: string, _title: string): Promise<void> {
    // OpenClaw 不支持 session title 存储
  }
}

export class ReasonixRuntimeDriver extends BaseRuntimeDriver {
  readonly runtime = 'reasonix' as const;

  constructor(
    store: JsonFileStore,
    config: Config,
    private readonly providerLoader: () => Promise<ReasonixProvider>,
  ) {
    super(store, config, 'reasonix');
  }

  async prepare(): Promise<void> {
    const provider = await this.providerLoader();
    await provider.prepare();
  }

  async streamTurn(params: StreamChatParams): Promise<ReadableStream<string>> {
    const provider = await this.providerLoader();
    return provider.streamChat(params);
  }

  async readSessionTitle(_sessionId: string): Promise<string | null> {
    return null;
  }

  async writeSessionTitle(_sessionId: string, _title: string): Promise<void> {
    // Reasonix 不支持 session title 存储
  }
}

export class DshRuntimeDriver extends BaseRuntimeDriver {
  readonly runtime = 'dsh' as const;

  constructor(
    store: JsonFileStore,
    config: Config,
    private readonly providerLoader: () => Promise<DshProvider>,
  ) {
    super(store, config, 'dsh');
  }

  async prepare(): Promise<void> {
    const provider = await this.providerLoader();
    await provider.prepare();
  }

  async streamTurn(params: StreamChatParams): Promise<ReadableStream<string>> {
    const provider = await this.providerLoader();
    return provider.streamChat(params);
  }

  async readSessionTitle(_sessionId: string): Promise<string | null> {
    return null;
  }

  async writeSessionTitle(_sessionId: string, _title: string): Promise<void> {
    // DSH 不支持 session title 存储
  }
}

export class GeminiRuntimeDriver extends BaseRuntimeDriver {
  readonly runtime = 'gemini' as const;

  constructor(
    store: JsonFileStore,
    config: Config,
    private readonly providerLoader: () => Promise<GeminiProvider>,
  ) {
    super(store, config, 'gemini');
  }

  async prepare(): Promise<void> {
    const provider = await this.providerLoader();
    await provider.prepare();
  }

  async streamTurn(params: StreamChatParams): Promise<ReadableStream<string>> {
    const provider = await this.providerLoader();
    return provider.streamChat(params);
  }

  async readSessionTitle(_sessionId: string): Promise<string | null> {
    return null;
  }

  async writeSessionTitle(_sessionId: string, _title: string): Promise<void> {
    // Gemini 不支持 session title 存储
  }
}

export class HermesRuntimeDriver extends BaseRuntimeDriver {
  readonly runtime = 'hermes' as const;

  constructor(
    store: JsonFileStore,
    config: Config,
    private readonly providerLoader: () => Promise<HermesProvider>,
  ) {
    super(store, config, 'hermes');
  }

  async prepare(): Promise<void> {
    const provider = await this.providerLoader();
    await provider.prepare();
  }

  async streamTurn(params: StreamChatParams): Promise<ReadableStream<string>> {
    const provider = await this.providerLoader();
    return provider.streamChat(params);
  }

  async readSessionTitle(_sessionId: string): Promise<string | null> {
    return null;
  }

  async writeSessionTitle(_sessionId: string, _title: string): Promise<void> {
    // Hermes 不支持 session title 存储
  }
}

export class OpenAkitaRuntimeDriver extends BaseRuntimeDriver {
  readonly runtime = 'openakita' as const;

  constructor(
    store: JsonFileStore,
    config: Config,
    private readonly providerLoader: () => Promise<OpenAkitaProvider>,
  ) {
    super(store, config, 'openakita');
  }

  async prepare(): Promise<void> {
    const provider = await this.providerLoader();
    await provider.prepare();
  }

  async streamTurn(params: StreamChatParams): Promise<ReadableStream<string>> {
    const provider = await this.providerLoader();
    return provider.streamChat(params);
  }

  async readSessionTitle(_sessionId: string): Promise<string | null> {
    return null;
  }

  async writeSessionTitle(_sessionId: string, _title: string): Promise<void> {
    // OpenAkita 不支持 session title 存储
  }
}
