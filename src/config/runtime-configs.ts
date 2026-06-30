/**
 * Runtime 配置 - 定义每个 runtime 的真实模型和提供商信息
 * 每次调用 getRuntimeConfig 时重新读取配置文件，支持热更新
 */

import fs from 'fs';

export interface RuntimeConfig {
  model: string;      // 实际模型名
  provider: string;   // 提供商
  displayName?: string; // 显示名称（可选）
}

/**
 * 读取 Claude SDK 配置目录下的 settings.json 和 providers.json
 * 返回当前实际使用的 model 和 provider
 */
function readClaudeConfig(): { model: string; provider: string } {
  try {
    const settingsPath = '/root/.claude/cc-haha/settings.json';
    const providersPath = '/root/.claude/cc-haha/providers.json';

    let model: string | undefined;
    let provider: string | undefined;

    // 优先从 settings.json 读取模型（权威配置）
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings.model) {
        model = settings.model;
      }
    }

    // 从 providers.json 读取 provider name（非硬编码）
    if (fs.existsSync(providersPath)) {
      const data = JSON.parse(fs.readFileSync(providersPath, 'utf-8'));
      const active = data.providers?.find((p: any) => p.id === data.activeId);
      if (active?.name) {
        provider = active.name;
      }
      // settings.json 没有 model 时，从 providers.json 回退
      if (!model && active?.models?.main) {
        model = active.models.main;
      }
    }

    return { model: model || 'claude-model', provider: provider || 'LiteLLM' };
  } catch (e) {
    console.error('[runtime-configs] 读取 Claude 配置失败，使用默认值:', e);
    return { model: 'claude-model', provider: 'LiteLLM' };
  }
}

/**
 * 读取 config.env 文件，返回键值对
 * config.env 是 agents-to-im 的统一配置文件，每次调用都重新读取
 */
function readConfigEnv(): Record<string, string> {
  const configPath = '/opt/.agents-to-im/config.env';
  const result: Record<string, string> = {};
  try {
    if (!fs.existsSync(configPath)) return result;
    const content = fs.readFileSync(configPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      result[key] = value;
    }
  } catch (e) {
    console.error('[runtime-configs] 读取 config.env 失败:', e);
  }
  return result;
}

/**
 * 读取 Gemini 运行时配置：实时读 config.env
 * 直接显示真实配置（MODEL_GROUP + MODEL_PROVIDER），
 * 不再使用 DISPLAY_MODEL 写死字符串，和 Claude 一样实时反映配置文件。
 */
function readGeminiConfig(): { model: string; provider: string } {
  const env = readConfigEnv();
  const model = env.CTI_BOT_GEMINI_MODEL_GROUP || 'gemini-model';
  const provider = env.CTI_BOT_GEMINI_MODEL_PROVIDER || 'LiteLLM';
  return { model, provider };
}

/**
 * 读取 MiMo 运行时配置：实时读 config.env 和 mimocode.json
 * - CTI_BOT_MIMO_DISPLAY_MODEL 优先（真实底层模型，用于显示）
 * - mimocode.json 的 model 字段作为 fallback（内部 ID）
 */
function readMimoConfig(): { model: string; provider: string } {
  const env = readConfigEnv();
  if (env.CTI_BOT_MIMO_DISPLAY_MODEL) {
    return { model: env.CTI_BOT_MIMO_DISPLAY_MODEL, provider: env.CTI_BOT_MIMO_MODEL_PROVIDER || 'LiteLLM' };
  }
  const defaultModel = 'mimo-v2.5';
  try {
    const configPath = '/opt/.mimocode/config/mimocode.json';
    if (!fs.existsSync(configPath)) {
      return { model: defaultModel, provider: 'LiteLLM' };
    }
    const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const rawModel = data.model || defaultModel;
    // mimocode.json 的 model 是 "provider/model" 格式（如 mimo-litellm/MiMogo），取 / 后部分作为显示
    const model = rawModel.includes('/') ? rawModel.split('/').pop()! : rawModel;
    return { model, provider: 'LiteLLM' };
  } catch (e) {
    console.error('[runtime-configs] 读取 mimocode.json 失败，使用默认值:', e);
    return { model: defaultModel, provider: 'LiteLLM' };
  }
}

/**
 * 获取指定 runtime 的配置（每次调用时重新读取配置文件）
 * @param runtime runtime 名称
 * @returns RuntimeConfig 配置对象
 */
export function getRuntimeConfig(runtime: string): RuntimeConfig {
  // Claude runtime：实时读取配置文件，单配置源
  if (runtime === 'claude') {
    const { model, provider } = readClaudeConfig();
    console.log(`[runtime-configs] runtime=claude → model=${model} provider=${provider} (from config files)`);
    return { model, provider, displayName: 'Claude' };
  }

  // Gemini runtime：实时读取 config.env
  if (runtime === 'gemini') {
    const { model, provider } = readGeminiConfig();
    console.log(`[runtime-configs] runtime=gemini → model=${model} provider=${provider} (from config.env)`);
    return { model, provider, displayName: 'Gemini' };
  }

  // MiMo runtime：实时读取 mimocode.json
  if (runtime === 'mimo') {
    const { model, provider } = readMimoConfig();
    console.log(`[runtime-configs] runtime=mimo → model=${model} provider=${provider} (from mimocode.json)`);
    return { model, provider, displayName: 'MimoCode' };
  }

  // 其他 runtime 保持原有逻辑（环境变量 + 默认值）
  const runtimeUpper = runtime.toUpperCase();
  const botModelKey = `CTI_BOT_${runtimeUpper}_MODEL_GROUP`;
  const botProviderKey = `CTI_BOT_${runtimeUpper}_MODEL_PROVIDER`;

  const ctiModel = process.env[botModelKey] || process.env.CTI_MODEL_GROUP || undefined;
  const ctiProvider = process.env[botProviderKey] || process.env.CTI_MODEL_PROVIDER || undefined;

  const defaults: Record<string, { model: string; provider: string; displayName: string }> = {
    codex:      { model: 'codex-model',   provider: 'LiteLLM',   displayName: 'Codex' },
    mimo:       { model: 'MiMogo',        provider: 'LiteLLM',   displayName: 'MimoCode' },
    zcode:      { model: 'zcode-v1',      provider: 'zcode',     displayName: 'ZCode' },
    openhuman:  { model: 'openhuman-v1',  provider: 'openhuman', displayName: 'OpenHuman' },
    gemini:     { model: 'gemini-model',  provider: 'LiteLLM',   displayName: 'Gemini' },
  };

  const d = defaults[runtime] || defaults.mimo;
  const config: RuntimeConfig = {
    model: ctiModel || d.model,
    provider: ctiProvider || d.provider,
    displayName: d.displayName,
  };

  console.log(`[runtime-configs] runtime=${runtime} → model=${config.model} provider=${config.provider}`);
  return config;
}

/**
 * 构建系统提示词
 * @param runtime runtime 名称
 * @returns 系统提示词字符串
 */
export function buildSystemPrompt(runtime: string): string {
  const config = getRuntimeConfig(runtime);
  return `
你是 ${config.displayName || config.model}，由 ${config.provider} 提供。
当前模型：${config.model}

请根据用户的问题提供帮助。如果用户询问你的身份，请如实告知你的模型信息。
`.trim();
}
