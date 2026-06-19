/**
 * Runtime 配置 - 定义每个 runtime 的真实模型和提供商信息
 * 每次调用 getRuntimeConfig 时重新读取环境变量，支持热更新
 */

export interface RuntimeConfig {
  model: string;      // 实际模型名
  provider: string;   // 提供商
  displayName?: string; // 显示名称（可选）
}

/**
 * 获取指定 runtime 的配置（每次调用时重新读取环境变量）
 * @param runtime runtime 名称
 * @returns RuntimeConfig 配置对象
 */
export function getRuntimeConfig(runtime: string): RuntimeConfig {
  const configs: Record<string, RuntimeConfig> = {
    claude: {
      model: process.env.CTI_MODEL_GROUP || process.env.CLAUDE_MODEL || "claude-3-5-sonnet-20241022",
      provider: process.env.CTI_MODEL_PROVIDER || process.env.CLAUDE_PROVIDER || "anthropic",
      displayName: "Claude"
    },
    codex: {
      model: process.env.CTI_MODEL_GROUP || process.env.CODEX_MODEL || "gpt-4-codex",
      provider: process.env.CTI_MODEL_PROVIDER || process.env.CODEX_PROVIDER || "openai",
      displayName: "Codex"
    },
    mimo: {
      model: process.env.CTI_MODEL_GROUP || process.env.MIMO_MODEL || "MiMogo",
      provider: process.env.CTI_MODEL_PROVIDER || process.env.MIMO_PROVIDER || "LiteLLM",
      displayName: "MimoCode"
    },
    zcode: {
      model: process.env.CTI_MODEL_GROUP || process.env.ZCODE_MODEL || "zcode-v1",
      provider: process.env.CTI_MODEL_PROVIDER || process.env.ZCODE_PROVIDER || "zcode",
      displayName: "ZCode"
    },
    openhuman: {
      model: process.env.CTI_MODEL_GROUP || process.env.OPENHUMAN_MODEL || "openhuman-v1",
      provider: process.env.CTI_MODEL_PROVIDER || process.env.OPENHUMAN_PROVIDER || "openhuman",
      displayName: "OpenHuman"
    }
  };

  return configs[runtime] || configs.mimo;
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
