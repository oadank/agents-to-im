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
  // 统一配置：CTI_MODEL_GROUP 同时控制路由和显示
  // 向后兼容：未设置时回退到各 runtime 默认值
  const ctiModel = process.env.CTI_MODEL_GROUP || undefined;
  const ctiProvider = process.env.CTI_MODEL_PROVIDER || undefined;

  const defaults: Record<string, { model: string; provider: string; displayName: string }> = {
    claude:     { model: "claude-3-5-sonnet-20241022", provider: "anthropic",   displayName: "Claude" },
    codex:      { model: "gpt-4-codex",              provider: "openai",       displayName: "Codex" },
    mimo:       { model: "MiMogo",                    provider: "LiteLLM",     displayName: "MimoCode" },
    zcode:      { model: "zcode-v1",                  provider: "zcode",       displayName: "ZCode" },
    openhuman:  { model: "openhuman-v1",              provider: "openhuman",   displayName: "OpenHuman" },
    gemini:     { model: "gemini-2.5-flash",          provider: "Google",      displayName: "Gemini" },
  };

  const d = defaults[runtime] || defaults.mimo;
  const config: RuntimeConfig = {
    model: ctiModel || d.model,
    provider: ctiProvider || d.provider,
    displayName: d.displayName,
  };

  // 模型路由日志，便于调试
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
