import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_FEISHU_PROFILE_ID = 'default';

export interface FeishuProfileConfig {
  id: string;
  appId?: string;
  appSecret?: string;
  domain?: 'lark';
  allowedUsers?: string[];
  showToolCallCards?: boolean;
  oauthRedirectUri?: string;
  enableUserMode?: boolean;
  /** 是否在消息底部显示分割线（Agent/Model/Provider 信息） */
  showAgentDivider?: boolean;
  /** Agent 名称（如 feishu-mimo），用于分割线显示 */
  agentName?: string;
  /** 模型组名（如 MiMo-OpenAI, codex-model, MiMogo），用于分割线显示 */
  modelGroup?: string;
  /** 服务商名（如 LiteLLM, Volcengine），用于分割线显示 */
  modelProvider?: string;
}

export interface CompactConfig {
  model: string;
  maxTokens: number;
  temperature: number;
  clearSdkSession: boolean;
}

export interface Config {
  defaultWorkDir: string;
  defaultRuntime: 'claude' | 'codex' | 'openhuman' | 'zcode' | 'mimo' | 'gemini';
  feishu: FeishuProfileConfig;
  /** 多 bot 配置列表（新格式） */
  bots?: BotConfig[];
  claudeCliExecutable?: string;
  compact: CompactConfig;
}

/** 单个 bot 的完整配置 */
export interface BotConfig {
  name: string;
  appId: string;
  appSecret: string;
  runtime: 'claude' | 'codex' | 'openhuman' | 'zcode' | 'mimo' | 'gemini';
  agentName?: string;
  modelGroup?: string;
  modelProvider?: string;
  domain?: 'lark';
  allowedUsers?: string[];
  showToolCallCards?: boolean;
  showAgentDivider?: boolean;
  oauthRedirectUri?: string;
  enableUserMode?: boolean;
}

export const DEFAULT_CTI_HOME = path.join(os.homedir(), '.agents-to-im');
export const CTI_HOME = process.env.CTI_HOME || DEFAULT_CTI_HOME;
export const CONFIG_PATH = path.join(CTI_HOME, 'config.env');

function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function loadFeishuConfig(env: Map<string, string>): FeishuProfileConfig {
  return {
    id: DEFAULT_FEISHU_PROFILE_ID,
    appId: env.get('CTI_FEISHU_APP_ID') || undefined,
    appSecret: env.get('CTI_FEISHU_APP_SECRET') || undefined,
    domain: env.get('CTI_FEISHU_DOMAIN') === 'lark' ? 'lark' : undefined,
    allowedUsers: splitCsv(env.get('CTI_FEISHU_ALLOWED_USERS') || undefined),
    showToolCallCards: parseBoolean(env.get('CTI_FEISHU_SHOW_TOOL_CALL_CARDS')) ?? false,
    oauthRedirectUri: env.get('CTI_FEISHU_OAUTH_REDIRECT_URI') || undefined,
    enableUserMode: parseBoolean(env.get('CTI_FEISHU_ENABLE_USER_MODE')) ?? false,
    showAgentDivider: parseBoolean(env.get('CTI_FEISHU_SHOW_AGENT_DIVIDER')) ?? true,
    agentName: env.get('CTI_AGENT_NAME') || undefined,
    modelGroup: env.get('CTI_MODEL_GROUP') || undefined,
    modelProvider: env.get('CTI_MODEL_PROVIDER') || undefined,
  };
}

function loadCompactConfig(env: Map<string, string>): CompactConfig {
  return {
    model: env.get('CTI_COMPACT_MODEL') || process.env.CTI_COMPACT_MODEL || 'codex-model',
    maxTokens: parseInt(env.get('CTI_COMPACT_MAX_TOKENS') || process.env.CTI_COMPACT_MAX_TOKENS || '3000'),
    temperature: parseFloat(env.get('CTI_COMPACT_TEMPERATURE') || process.env.CTI_COMPACT_TEMPERATURE || '0.2'),
    clearSdkSession: (env.get('CTI_COMPACT_CLEAR_SDK_SESSION') || process.env.CTI_COMPACT_CLEAR_SDK_SESSION || 'true') !== 'false',
  };
}

function parseBotConfigs(env: Map<string, string>): BotConfig[] {
  const botsStr = env.get('CTI_BOTS');
  if (!botsStr) return [];

  const botNames = botsStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const bots: BotConfig[] = [];

  for (const name of botNames) {
    const prefix = `CTI_BOT_${name.toUpperCase()}_`;
    const appId = env.get(`${prefix}APP_ID`);
    const appSecret = env.get(`${prefix}APP_SECRET`);
    if (!appId || !appSecret) {
      console.warn(`[config] Bot '${name}' missing APP_ID or APP_SECRET, skipping`);
      continue;
    }

    const runtimeStr = env.get(`${prefix}RUNTIME`) || 'claude';
    const runtime: BotConfig['runtime'] =
      runtimeStr === 'codex' ? 'codex'
        : runtimeStr === 'openhuman' ? 'openhuman'
          : runtimeStr === 'zcode' ? 'zcode'
            : runtimeStr === 'mimo' ? 'mimo'
              : runtimeStr === 'gemini' ? 'gemini'
                : 'claude';

    bots.push({
      name,
      appId,
      appSecret,
      runtime,
      agentName: env.get(`${prefix}AGENT_NAME`) || `feishu-${name}`,
      modelGroup: env.get(`${prefix}MODEL_GROUP`) || undefined,
      modelProvider: env.get(`${prefix}MODEL_PROVIDER`) || undefined,
      domain: env.get(`${prefix}DOMAIN`) === 'lark' ? 'lark' : undefined,
      allowedUsers: splitCsv(env.get(`${prefix}ALLOWED_USERS`) || env.get('CTI_FEISHU_ALLOWED_USERS')),
      showToolCallCards: parseBoolean(env.get(`${prefix}SHOW_TOOL_CALL_CARDS`)) ?? false,
      showAgentDivider: parseBoolean(env.get(`${prefix}SHOW_AGENT_DIVIDER`)) ?? true,
      oauthRedirectUri: env.get(`${prefix}OAUTH_REDIRECT_URI`) || undefined,
      enableUserMode: parseBoolean(env.get(`${prefix}ENABLE_USER_MODE`)) ?? false,
    });
  }

  return bots;
}

export function loadConfig(): Config {
  let env = new Map<string, string>();
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    env = parseEnvFile(content);
  } catch {
    // Config file doesn't exist yet — use defaults.
  }

  const runtimeStr = env.get('CTI_DEFAULT_RUNTIME') || 'claude';
  const defaultRuntime: 'claude' | 'codex' | 'openhuman' | 'zcode' | 'mimo' | 'gemini' =
    runtimeStr === 'codex' ? 'codex'
      : runtimeStr === 'openhuman' ? 'openhuman'
        : runtimeStr === 'zcode' ? 'zcode'
          : runtimeStr === 'mimo' ? 'mimo'
            : runtimeStr === 'gemini' ? 'gemini'
              : 'claude';

  const bots = parseBotConfigs(env);
  if (bots.length > 0) {
    console.log(`[config] Loaded ${bots.length} bot(s): ${bots.map(b => `${b.name}(${b.runtime})`).join(', ')}`);
  }

  return {
    defaultWorkDir: env.get('CTI_DEFAULT_WORKDIR') || process.cwd(),
    defaultRuntime,
    feishu: loadFeishuConfig(env),
    bots: bots.length > 0 ? bots : undefined,
    claudeCliExecutable: env.get('CTI_CLAUDE_CODE_EXECUTABLE') || undefined,
    compact: loadCompactConfig(env),
  };
}

function formatEnvLine(key: string, value: string | undefined): string {
  if (value === undefined || value === '') return '';
  return `${key}=${value}\n`;
}

function formatBooleanEnvLine(key: string, value: boolean | undefined): string {
  if (value === undefined) return '';
  return `${key}=${value ? 'true' : 'false'}\n`;
}

function formatFeishuLines(profile: FeishuProfileConfig): string {
  let out = '';
  out += formatEnvLine('CTI_FEISHU_APP_ID', profile.appId);
  out += formatEnvLine('CTI_FEISHU_APP_SECRET', profile.appSecret);
  out += formatEnvLine('CTI_FEISHU_DOMAIN', profile.domain);
  out += formatEnvLine('CTI_FEISHU_ALLOWED_USERS', profile.allowedUsers?.join(','));
  out += formatBooleanEnvLine('CTI_FEISHU_SHOW_TOOL_CALL_CARDS', profile.showToolCallCards);
  out += formatEnvLine('CTI_FEISHU_OAUTH_REDIRECT_URI', profile.oauthRedirectUri);
  out += formatBooleanEnvLine('CTI_FEISHU_ENABLE_USER_MODE', profile.enableUserMode);
  out += formatBooleanEnvLine('CTI_FEISHU_SHOW_AGENT_DIVIDER', profile.showAgentDivider);
  out += formatEnvLine('CTI_AGENT_NAME', profile.agentName);
  return out;
}

export function saveConfig(config: Config): void {
  let out = '';
  out += formatEnvLine('CTI_DEFAULT_WORKDIR', config.defaultWorkDir);
  out += formatFeishuLines(config.feishu);
  out += formatEnvLine('CTI_CLAUDE_CODE_EXECUTABLE', config.claudeCliExecutable);

  fs.mkdirSync(CTI_HOME, { recursive: true });
  const tmpPath = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmpPath, out, { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return '****';
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

export function configToSettings(config: Config): Map<string, string> {
  const settings = new Map<string, string>();
  const feishu = config.feishu;
  settings.set('remote_bridge_enabled', 'true');
  settings.set('bridge_feishu_enabled', 'true');
  settings.set('bridge_default_work_dir', config.defaultWorkDir);
  if (feishu.appId) settings.set('bridge_feishu_app_id', feishu.appId);
  if (feishu.appSecret) settings.set('bridge_feishu_app_secret', feishu.appSecret);
  if (feishu.domain) settings.set('bridge_feishu_domain', feishu.domain);
  if (feishu.allowedUsers) {
    settings.set('bridge_feishu_allowed_users', feishu.allowedUsers.join(','));
  }
  return settings;
}
