/**
 * Runtime 配置 - 定义每个 runtime 的真实模型和提供商信息
 * 每次调用 getRuntimeConfig 时重新读取配置文件，支持热更新
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export interface RuntimeConfig {
  model: string;      // 实际模型名
  provider: string;   // 提供商
  displayName?: string; // 显示名称（可选）
}

// CTI_HOME 解析：优先环境变量，否则使用用户主目录
const CTI_HOME = process.env.CTI_HOME || path.join(os.homedir(), '.agents-to-im');

/**
 * 读取 Claude SDK 配置目录下的 settings.json 和 providers.json
 * 返回当前实际使用的 model 和 provider
 */
function readClaudeConfig(): { model: string; provider: string } {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'cc-haha', 'settings.json');
    const providersPath = path.join(os.homedir(), '.claude', 'cc-haha', 'providers.json');

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
  const configPath = path.join(CTI_HOME, 'config.env');
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
 * 读取 Gemini 运行时配置：从 ~/.gemini/settings.json 读取实际模型名
 * settings.json 由 main.ts generateMcpConfigs() 从 config.env 同步，
 * 所以 config.env 是唯一配置源，这里读取的是已同步的真实值。
 */
function readGeminiConfig(): { model: string; provider: string } {
  try {
    const settingsPath = path.join(os.homedir(), '.gemini', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const model = settings.model?.name;
      if (model) {
        const provider = process.env.CTI_BOT_GEMINI_MODEL_PROVIDER || 'LiteLLM';
        return { model, provider };
      }
    }
  } catch (e) {
    console.error('[runtime-configs] 读取 Gemini settings.json 失败:', e);
  }
  // fallback: 读 config.env
  const env = readConfigEnv();
  const model = env.CTI_BOT_GEMINI_MODEL_GROUP || 'gemini-model';
  const provider = env.CTI_BOT_GEMINI_MODEL_PROVIDER || 'LiteLLM';
  return { model, provider };
}

/**
 * 读取 MiMo 运行时配置：实时读 config.env
 * 直接显示真实配置（MODEL_GROUP + MODEL_PROVIDER），
 * 和 Claude/Gemini 一样，单一来源。
 */
function readMimoConfig(): { model: string; provider: string } {
  const env = readConfigEnv();
  const model = env.CTI_BOT_MIMO_MODEL_GROUP || 'MiMogo';
  const provider = env.CTI_BOT_MIMO_MODEL_PROVIDER || 'LiteLLM';
  return { model, provider };
}

/**
 * 读取 Hermes 运行时配置：实时读 config.env
 */
function readHermesConfig(): { model: string; provider: string } {
  const env = readConfigEnv();
  const model = env.CTI_BOT_HERMES_MODEL_GROUP || 'codex-model';
  const provider = env.CTI_BOT_HERMES_MODEL_PROVIDER || 'LiteLLM';
  return { model, provider };
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

  // Hermes runtime：实时读取 config.env
  if (runtime === 'hermes') {
    const { model, provider } = readHermesConfig();
    console.log(`[runtime-configs] runtime=hermes → model=${model} provider=${provider} (from config.env)`);
    return { model, provider, displayName: 'Hermes' };
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
    hermes:     { model: 'codex-model',   provider: 'LiteLLM',   displayName: 'Hermes' },
    openakita:  { model: 'codex-model',   provider: 'LiteLLM',   displayName: 'OpenAkita' },
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

---

${LARK_CLI_INSTRUCTIONS}
`.trim();
}

/**
 * lark-cli 飞书操作能力指令 + MCP 工具指引 + 知识循环
 * 由 conversation engine 注入到用户 prompt 中，让所有 AI Agent 知道可以用 lark-cli 操作飞书。
 * 身份规则：统一使用 user 身份（默认），不加 --as 参数。
 */
export const LARK_CLI_INSTRUCTIONS = `
## 飞书操作能力 (lark-cli) — 必须使用，禁止用 Python 脚本替代

你可以通过 shell 命令调用 lark-cli 直接操作飞书。命令默认输出 JSON 格式。命令超时请加 --timeout 参数。如需帮助可运行 lark-cli <command> --help。

**铁律：所有飞书操作必须通过 lark-cli 完成。禁止写 Python/Node 脚本调用飞书 API，这会绕过认证和权限管理，效率低且不可维护。**

### 身份选择规则
- **统一使用 user 身份**（默认，不加 --as 参数）。user 身份可以操作所有群和私聊。
- 发送消息示例：
  \`\`\`bash
  # 发送消息（user 身份）
  lark-cli im +messages-send --chat-id <目标群id> --text "消息内容"
  # @ 某人发送消息
  lark-cli im +messages-send --chat-id <目标群id> --text '<at user_id="ou_xxx">名字</at> 消息内容'
  \`\`\`

### 常用命令
- lark-cli im +messages-send --chat-id <id> --text "消息"           # 发送消息
- lark-cli im +messages-send --chat-id <id> --text '<at user_id="ou_xxx">名字</at> 消息'  # @某人发消息
- lark-cli im +chat-messages-list --chat-id <id>                    # 列出群消息
- lark-cli im +messages-reply --message-id <om_xxx> --text "回复"   # 回复消息
- lark-cli im +chat-search --keyword "群名"                          # 搜索群
- lark-cli contact search <name>                                    # 搜索联系人
- lark-cli contact get <open_id>                                    # 获取联系人信息
- lark-cli doc read <token>                                         # 读取文档
- lark-cli sheets read <token>                                      # 读取表格
- lark-cli calendar today                                           # 今日日程
- lark-cli task list                                                # 查看任务

### URL 解析
当用户给出飞书链接（feishu.cn 或 doubao.com），可以直接使用 lark-cli 打开/读取。
链接中的 token 可以通过 lark-cli 命令直接操作。

## MCP 工具使用指引 — 必须通过工具调用机制，禁止 HTTP POST

你已配置以下 MCP 服务器，可通过原生工具调用机制使用（无需 curl/fetch/HTTP POST）：

### agentmemory 服务器（经验记忆）
- \`memory_smart_search\` — 智能搜索历史经验（任务开始前必用）
- \`memory_recall\` — 回忆过往会话上下文
- \`memory_lesson_save\` — 保存经验教训（任务完成后必用）
- \`memory_save\` — 保存当前会话观察
- \`memory_profile\` — 查询用户画像

### wiki 服务器（共享知识库）
- \`wiki_recall\` — 搜索知识库内容（任务开始前必用）
- \`wiki_remember\` — 保存知识到共享知识库（任务完成后必用）
- \`wiki_query\` — 查询知识库
- \`wiki_brief\` — 获取简要摘要

### 三阶段知识循环（每个任务必须执行）
1. **任务开始前 → 搜索经验**：用 \`memory_smart_search\` + \`wiki_recall\` 搜索相关经验，避免重复踩坑
2. **任务执行中 → 遇到问题即时查**：遇到报错先搜索历史解决方案，发现新问题记录下来
3. **任务完成后 → 保存经验**：用 \`memory_lesson_save\` 保存经验，用 \`wiki_remember\` 保存共享知识

**铁律：不搜索就开工 = 白费力气重复踩坑；不保存就结束 = 经验流失下次还犯。**

### 多 Agent 协作绑定 lark-cli
如果你检测到其他 agent（如 Hermes、Gemini、MiMo、Codex）反馈 lark-cli "未绑定"，你可以主动帮忙：

1. **直接帮其他 agent 绑定 source**（推荐）：
   \`\`\`bash
   npx @larksuite/cli config bind --source hermes --identity bot-only
   \`\`\`
   - \`--source claude\` → 绑定到 Claude
   - \`--source hermes\` → 绑定到 Hermes
   - \`--source gemini\` → 绑定到 Gemini
   - \`--source mimo\` → 绑定到 MiMo
   - \`--source codex\` → 绑定到 Codex
   
   同一个应用可以绑定到多个 source，互不影响。

2. **通过飞书消息通知对方自己绑定**：
   \`\`\`bash
   lark-cli im +messages-send --chat-id <chat_id> --text "请执行：npx @larksuite/cli config bind --source hermes --identity bot-only"
   \`\`\`

这不是重复申请凭证，只是把同一个 app 的绑定关系写到对应的 source 目录下。
`.trim();
