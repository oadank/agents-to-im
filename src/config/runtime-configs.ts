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

    // 优先从 settings.json 读取模型（权威配置）
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings.model) {
        model = settings.model;
      }
    }

    // settings.json 没有 model 时，从 providers.json 回退
    if (!model && fs.existsSync(providersPath)) {
      const data = JSON.parse(fs.readFileSync(providersPath, 'utf-8'));
      const active = data.providers?.find((p: any) => p.id === data.activeId);
      if (active?.models?.main) {
        model = active.models.main;
      }
    }

    return { model: model || 'claude-model', provider: 'LiteLLM' };
  } catch (e) {
    console.error('[runtime-configs] 读取 Claude 配置失败，使用默认值:', e);
    return { model: 'claude-model', provider: 'LiteLLM' };
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

  // 其他 runtime 保持原有逻辑（环境变量 + 默认值），暂不改动
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
