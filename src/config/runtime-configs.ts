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
  role?: string;      // 团队角色描述（架构师/编码/测试等）
}

// CTI_HOME 解析：优先环境变量，否则使用用户主目录
const CTI_HOME = process.env.CTI_HOME || path.join(os.homedir(), '.agents-to-im');

// ── 团队运行数据（本地文件，勿提交）──
// 真实 open_id/chat_id/Multica UUID 放在 team-data.json（.gitignore 排除），
// 模板见 team-data.example.json。文件缺失时返回空结构，prompt 注入自动跳过。
interface TeamData {
  chatId: string;
  openIds: Record<string, string>;
  multicaWorkspaceId: string;
  multicaAgents: Record<string, string>;
  multicaSquads: Record<string, string>;
}

let _teamDataCache: TeamData | null = null;
function loadTeamData(): TeamData {
  if (_teamDataCache) return _teamDataCache;
  const empty: TeamData = { chatId: '', openIds: {}, multicaWorkspaceId: '', multicaAgents: {}, multicaSquads: {} };
  try {
    // 打包后 __dirname 为 dist/，dev 下为 src/config/；多候选路径兼容
    const candidates = [
      path.join(__dirname, 'team-data.json'),                 // dist/ 或 src/config/
      path.join(__dirname, '..', 'src', 'config', 'team-data.json'), // dist/ 回退到源码目录
      path.join(process.cwd(), 'src', 'config', 'team-data.json'),
    ];
    const dataPath = candidates.find((p) => fs.existsSync(p));
    if (!dataPath) {
      console.warn('[runtime-configs] team-data.json 不存在（本地团队数据文件未配置）');
      _teamDataCache = empty;
      return empty;
    }
    const raw = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    _teamDataCache = {
      chatId: raw.chatId || '',
      openIds: raw.openIds || {},
      multicaWorkspaceId: raw.multicaWorkspaceId || '',
      multicaAgents: raw.multicaAgents || {},
      multicaSquads: raw.multicaSquads || {},
    };
  } catch (e) {
    console.warn('[runtime-configs] team-data.json 读取失败，使用空配置:', e);
    _teamDataCache = empty;
  }
  return _teamDataCache;
}

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
 * 读取 Reasonix 的 config.toml，返回当前实际使用的 model 和 provider
 * Reasonix CLI 使用 ~/AppData/Roaming/reasonix/config.toml 的 default_model
 * 模型前缀即 provider（如 deepseek/xxx → deepseek，litellm/xxx → LiteLLM）
 */
function readReasonixConfig(): { model: string; provider: string } {
  try {
    const configPath = path.join(os.homedir(), 'AppData', 'Roaming', 'reasonix', 'config.toml');
    if (!fs.existsSync(configPath)) {
      return { model: 'deepseek-v4-flash', provider: 'deepseek' };
    }
    const content = fs.readFileSync(configPath, 'utf-8');
    // 匹配 default_model = "xxx"（跳过以 # 开头的注释行）
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const m = trimmed.match(/^default_model\s*=\s*"([^"]+)"/);
      if (m) {
        const raw = m[1]; // 如 "deepseek/deepseek-v4-flash" 或 "litellm/deepseek-v4f"
        const slashIdx = raw.indexOf('/');
        if (slashIdx > 0) {
          const prefix = raw.slice(0, slashIdx);
          const modelName = raw.slice(slashIdx + 1);
          const provider = prefix === 'litellm' ? 'LiteLLM' : prefix;
          console.log(`[runtime-configs] runtime=reasonix → model=${modelName} provider=${provider} (from config.toml)`);
          return { model: modelName, provider };
        }
        console.log(`[runtime-configs] runtime=reasonix → model=${raw} (from config.toml, no provider prefix)`);
        return { model: raw, provider: 'LiteLLM' };
      }
    }
    return { model: 'deepseek-v4-flash', provider: 'deepseek' };
  } catch (e) {
    console.error('[runtime-configs] 读取 Reasonix 配置失败，使用默认值:', e);
    return { model: 'deepseek-v4-flash', provider: 'deepseek' };
  }
}

/**
 * 读取 Opencode 的 opencode.json，返回当前实际使用的 model 和 provider
 * opencode CLI 使用 ~/.config/opencode/opencode.json，取 provider 下第一个模型
 */
function readOpencodeConfig(): { model: string; provider: string } {
  try {
    const configPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
    if (!fs.existsSync(configPath)) {
      return { model: 'deepseek-v4-flash', provider: 'deepseek' };
    }
    const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    // 优先读顶层 model 字段（opencode CLI 实际使用的模型，格式 provider/model 或 litellm/xxx）
    const topModel = typeof data?.model === 'string' ? data.model : '';
    if (topModel) {
      const slashIdx = topModel.indexOf('/');
      if (slashIdx > 0) {
        const provider = topModel.slice(0, slashIdx);
        const model = topModel.slice(slashIdx + 1);
        console.log(`[runtime-configs] runtime=opencode → model=${model} provider=${provider} (from opencode.json top-level model)`);
        return { model, provider: provider === 'litellm' ? 'LiteLLM' : provider };
      }
      console.log(`[runtime-configs] runtime=opencode → model=${topModel} (from opencode.json top-level model, no provider prefix)`);
      return { model: topModel, provider: 'LiteLLM' };
    }
    // fallback：读第一个 provider 的第一个模型
    const providers = data?.provider || {};
    const names = Object.keys(providers);
    if (names.length === 0) {
      return { model: 'deepseek-v4-flash', provider: 'deepseek' };
    }
    const provider = names[0];
    const models = Object.keys(providers[provider]?.models || {});
    const model = models[0] || provider;
    console.log(`[runtime-configs] runtime=opencode → model=${model} provider=${provider} (from opencode.json)`);
    return { model, provider };
  } catch (e) {
    console.error('[runtime-configs] 读取 Opencode 配置失败，使用默认值:', e);
    return { model: 'deepseek-v4-flash', provider: 'deepseek' };
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
    return { model, provider, displayName: 'Claude', role: '文案/编剧队长：负责文案/剧本/编剧/内容创作，通过 Multica 调度文案助手/编剧拆解/配音剪辑专家团' };
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

  // Reasonix runtime：实时读取 config.toml（Deepseek CLI 真实模型）
  if (runtime === 'reasonix') {
    const { model, provider } = readReasonixConfig();
    return { model, provider, displayName: 'Reasonix' };
  }

  // Opencode runtime：实时读取 opencode.json（真实模型）
  if (runtime === 'opencode') {
    const { model, provider } = readOpencodeConfig();
    return { model, provider, displayName: 'OpenCode', role: '生图队长：正常对话直接回答；收到生图需求时，通过 Multica 调度生图小队（视觉导演+生图工程师）出图，再把图片发回飞书。同时可协助简单编码/通用问题' };
  }

  // 其他 runtime 保持原有逻辑（环境变量 + 默认值）
  const runtimeUpper = runtime.toUpperCase();
  const botModelKey = `CTI_BOT_${runtimeUpper}_MODEL_GROUP`;
  const botProviderKey = `CTI_BOT_${runtimeUpper}_MODEL_PROVIDER`;

  const ctiModel = process.env[botModelKey] || process.env.CTI_MODEL_GROUP || undefined;
  const ctiProvider = process.env[botProviderKey] || process.env.CTI_MODEL_PROVIDER || undefined;

  const defaults: Record<string, { model: string; provider: string; displayName: string; role: string }> = {
    codex:      { model: 'codex-model',   provider: 'LiteLLM',   displayName: 'Codex',    role: '代码/插件队长：负责代码类任务（编码、脚本、插件、应用），通过 Multica 调度编码/全栈/后端专家团' },
    mimo:       { model: 'MiMogo',        provider: 'LiteLLM',   displayName: 'MimoCode', role: '微信公众号队长：负责公众号内容（选题→文案→审核→发布），通过 Multica 调度文案助手/安全审查/发布智能体' },
    reasonix:   { model: 'codex-model',   provider: 'LiteLLM',   displayName: 'Reasonix', role: '总控/主控：接需求、判断任务类型、@对应队长、验收汇总，维护任务看板' },
  openclaw:   { model: 'codex-model',   provider: 'LiteLLM',   displayName: 'Openclaw',  role: '深度调研队长：研究方向→深挖→详细报告存wiki，通过 Multica 调度调研/研究助理' },
    opencode:   { model: 'codex-model',   provider: 'LiteLLM',   displayName: 'OpenCode', role: '生图队长：正常对话直接回答；收到生图需求时，通过 Multica 调度生图小队（视觉导演+生图工程师）出图，再把图片发回飞书。同时可协助简单编码/通用问题' },
    zcode:      { model: 'zcode-v1',      provider: 'zcode',     displayName: 'ZCode' },
    openhuman:  { model: 'openhuman-v1',  provider: 'openhuman', displayName: 'OpenHuman' },
    gemini:     { model: 'gemini-model',  provider: 'LiteLLM',   displayName: 'Gemini',   role: '视频/音频队长：负责生视频/配音/剪辑/成片，通过 Multica 调度视频语音/配音剪辑专家' },
    hermes:     { model: 'codex-model',   provider: 'LiteLLM',   displayName: 'Hermes',   role: '测试队长：各队产出测试质检，通过 Multica 调度测试工程师' },
    openakita:  { model: 'codex-model',   provider: 'LiteLLM',   displayName: 'OpenAkita', role: 'GitHub 推送队长：负责将团队产物/代码推送到 GitHub 仓库（commit/branch/PR/发布），通过 Multica 调度交付工程师/编码工程师' },
  };

  const d = defaults[runtime] || defaults.mimo;
  const config: RuntimeConfig = {
    model: ctiModel || d.model,
    provider: ctiProvider || d.provider,
    displayName: d.displayName,
    role: d.role,
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
  const team = loadTeamData();
  return `
# 团队协作规范（必须遵守）
- 团队总控：Reasonix——负责需求拆解、任务派发、验收汇总
- 团队群：${team.chatId || '<未配置>'}
- 协作模式：总控按任务复杂度裁剪流程（简单 2 人、中等 3-4 人、复杂拆子团队并行）
- **PM2 重启协作机制（重要）**：需要全量重启所有 bot 时——
  · 若你本身是 bot 进程（会被 pm2 restart all 中断自己）：先 pm2 restart **除自己以外的所有 bot**，等它们全部 online 后，**私聊其中某个 agent，让它执行 pm2 restart <你自己的pm2名>**（消息能送达 = 你当下已干完活，不怕被中断）
  · 若你非 bot（如桌面 CLI/手动操作）：环境正常时可直接 pm2 restart all（快速简单）
  · 你的 pm2 名 = 你的 bot 身份名（如 claude/codex/gemini/hermes/mimo/openakita/openclaw/opencode/reasonix）

# 交接铁律
1. 任务完成后，**主动 @ 下一位接单人**（open_id 见通讯录）
2. 回复总控/发起人时，**主动 @ 对方**
3. 不要只在文本里写 @名字，要真正 @ 到人（用 lark-cli 的 @ 功能）

# 产物要求（重要）
- 任务产物写入固定目录：C:\\D\\opt\\team-artifacts\\<任务ID>\\
- 各阶段产物：task.md（任务单）/ design.md（设计）/ code\\（代码）/ test.md（测试）/ delivery.md（交付）
- 只写你自己负责的那部分产物，不覆盖他人文件
- 完成后在回复中说明产物路径

# 验证铁律
- 交付前必须实际验证（运行/检查），不轻信"应该能跑"
- 验证脚本直接执行，不要调 lark-cli 做验证（会卡死）

# 知识循环
- 任务前：memory_smart_search + wiki_recall 搜经验
- 执行中：遇问题先搜历史
- 完成后：memory_lesson_save + wiki_remember 沉淀

---
${LARK_CLI_INSTRUCTIONS}
`.trim();
}

/**
 * lark-cli 飞书操作能力指令 + MCP 工具指引 + 知识循环
 * 由 conversation engine 注入到用户 prompt 中，让所有 AI Agent 知道可以用 lark-cli 操作飞书。
 * 身份规则：默认使用自己 bot 身份发消息（POST /api/send），只有代发时才用 user 身份（lark-cli）。
 */
export const LARK_CLI_INSTRUCTIONS = `
## 飞书操作能力（2026-08-07 更新）— bot 发消息用 /api/send，lark-cli 用于只读操作和 user 身份代发
**发消息**：bot 身份用 agents-to-im 的 POST /api/send（SDK 直发，最可靠）；user 身份（代发/私聊联系）用 lark-cli。**只读查询**（列消息/搜索/联系人/文档）用 lark-cli。命令默认输出 JSON 格式。命令超时请加 --timeout 参数。如需帮助可运行 lark-cli <command> --help。

**铁律（2026-08-07 更新）：发消息一律用 /api/send（bot 身份），不要写 Python/Node 脚本直接调飞书开放 API（绕过认证和管理）；lark-cli 不再用于 bot 发消息（只读 + user 身份代发保留）。**

### 工具调用纪律（重要）
- **一次只调用一个工具，串行执行**：先等前一个工具返回结果，再调用下一个。**严禁并行/同时发起多个工具调用**（多个 bash 或 MCP 工具一起发会导致执行挂起卡死）。
- 需要多个检查时（如同时查任务计划+注册表+服务），**逐个顺序执行**，每个都等结果。

### 身份选择规则（2026-08-07 更新：bot 发消息走 /api/send，lark-cli 只剩 user 身份）
- **发消息两种身份**：
  - **自己 bot 身份**（默认，推荐）：通过 agents-to-im 的 **POST /api/send**（bot 身份 SDK 直发），以自己的 bot 身份发（飞书自动显示 bot 名）。**不再用 lark-cli --as bot 发消息**
  - **user 身份**（仅代发时）：用 lark-cli --as user 以用户陈丹身份发（如转达他人消息、私聊互相联系），必须带 [你的身份名] 前缀
- **⚠️ 身份标识铁律（重要，2026-08-07 修正）**：判断用谁的身份，**看接收者是谁**：
  · **发给用户/群里展示**（回复、发图、汇报）→ **自己的 bot 身份**（POST /api/send 自己端口），显示自己 bot 名，无需前缀
  · **发给其他 bot**（派活、委托执行、bot间通信）→ **必须 user 身份**（lark-cli --as user + 内容带 [你的身份名] 前缀如 [Codex]）——因为 agents-to-im 过滤 sender_type=app，任何 bot 用 bot 身份发的消息任何 bot 都收不到
  · 一句话：bot 身份 = 给人看；user 身份 = 给 bot 传话（必须带身份前缀）
- **⚠️ 飞书实操要点（2026-08-08 实测补充，必读）**：
  1. **中文编码**：发任何含中文的消息（文字/URL/汇报），必须用 python/node（UTF-8）发送，禁止 PowerShell 直接拼中文（会乱码成 ????）。PowerShell 传中文先转 UTF-8 或改用 python urllib/node。
  2. **图片发到哪**："发图片给我" = 发到**当前飞书对话的 chat_id**（用户私聊你的那个）。不是团队群，不是桌面端。只有明确说"发群里"才发团队群（oc_b598b5209ec736d96c53e4b5b3cad491）。
  3. **发图姿势（2026-08-08 修正，实测）**：**lark-cli 没有 \`images create\` 命令**（报 unknown command）。正确姿势：
     - **方法A（推荐，bot 身份）**：POST 自己的 /api/send（msgType=image, content={\"image_key\":\"<img_xxx>\"}）——需要先用 lark-cli 上传拿 image_key，或用已有 image_key。
     - **方法B（lark-cli 直接发图）**：\`cd <图片所在目录>\` 后用**相对路径**：\`lark-cli im +messages-send --chat-id <目标> --image \"文件名.jpg\" --as user\`。**⚠️ --image 只接受当前目录的相对路径，绝对路径会被拒**（报 \"must be a relative path within the current directory\"）。**中文文件名没问题**（相对路径下中文可正常上传）；报“中文打不开”其实是绝对路径被拒的误判，不要复制到英文路径绕弯，cd 到图片目录用相对路径即可。
  4. **联系其他 bot**：用 user 身份（全局 lark-cli，不带 --profile）+ [你的身份名] 前缀。全局 lark-cli 配置在 ~/.lark-cli/，不需要你的专属 source。
  5. **⚠️ 禁止发到"陈丹的飞书 CLI"机器人**：~/.lark-cli/ 里那个 bot（appId cli_aad3d4bbaaf8dbb3）是 lark-cli 工具用的机器人，**不是团队智能体**——发到它的私聊没人看。只发到：团队群、用户真实私聊、或其它 bot 的私聊。
  6. **⚠️ 当前对话 = 飞书对话**：你是通过飞书 bot 接入的，用户和你对话的 chat_id 就是飞书 chat_id。**没有"ACP 桌面通道"这种说法**——用 /api/send 发到该 chat_id 就是对的。别被"桌面端/ACP"迷惑。
  7. **完成后必回**：任务做完一定要回复当前对话（哪怕失败也报原因），不要沉默。
- 发送消息示例：
  \`\`\`bash
  # 自己 bot 身份发消息（推荐）：POST /api/send，bot 身份 SDK 直发
  # 每个 bot 一个端口（claude=13580 codex=13581 mimo=13582 gemini=13583 hermes=13584 openakita=13585 reasonix=13586 openclaw=13587 opencode=13588）
  # 用 bash/PowerShell/curl 调本机端口：
  #   curl -X POST http://127.0.0.1:<自己端口>/api/send -H "Content-Type: application/json" -d '{"chatId":"<目标群id>","msgType":"text","content":"消息内容"}'
  #   @ 某人（post 富文本格式）：msgType=post, content 为 {"zh_cn":{"title":"","content":[[{"tag":"at","user_id":"目标open_id","user_name":"目标名"}],[{"tag":"text","text":"消息"}]]}}
  #   PowerShell: Invoke-RestMethod -Uri "http://127.0.0.1:<端口>/api/send" -Method Post -Body (ConvertTo-Json @{chatId='<群id>';msgType='text';content='消息'}) -ContentType 'application/json'
  # user 身份发消息（仅代发/私聊联系）：lark-cli im +messages-send --chat-id <目标群id> --text "消息内容"
  \`\`\`

### 团队群通讯录（真实 open_id 由运行环境注入，见 buildAgentPersona 输出的【团队通讯录】段落）
- 找不到某成员 open_id 时，用 \`lark-cli contact search <姓名>\` 查询后使用

### 主动 @ 协作（重要）
- **你可以主动 @ 其他 agent**（派活/确认/交接）——**注意：@ 其他 bot 用 user 身份发**（bot 身份发的消息其他 bot 收不到，见上面身份铁律）
- 任务完成后，**主动 @ 下一位接单人**（瀑布流交接）。
- 需要 @ 谁，用【团队通讯录】里的 open_id（由运行环境注入）。

### 向总控私聊汇报（2026-08-08 添加，重要）
- **总控要求私聊汇报时**（如认知更新结果），用你自己的 /api/send（bot 身份）发到 Reasonix 私聊 chat_id = oc_d8a3abf10296551ffeb332381bc26e96
- 姿势：POST http://127.0.0.1:<你自己端口>/api/send，body {"chatId":"oc_d8a3abf10296551ffeb332381bc26e96","msgType":"text","content":"[你的身份名] 汇报内容"}
- 中文必须 UTF-8（python urllib / node，禁止 PowerShell 拼中文）
- ⚠️ 不要发到团队群汇报（会打扰全员）；总控要求私聊就私聊 Reasonix

### 回复 @ 铁律（重要）
- **群聊回复时，必须主动 @ 原消息发起人**（用 /api/send 的 post 格式 @ 能力，open_id 从通讯录查询），让发起人/总控能收到你的回复。
- 若原消息由某 bot（如总控 Reasonix）发起，回复时 @ 该 bot（open_id 见通讯录）。
- 不要只在文本里写 @名字，要真正 @ 到人（/api/send msgType=post 的 @ 功能）。

### 常用命令（2026-08-07 更新）
- **发消息（bot 身份）**：POST http://127.0.0.1:<自己端口>/api/send，body {"chatId":"<id>","msgType":"text|post|image","content":"..."}
- **发消息（user 身份，仅代发/私聊联系）**：lark-cli im +messages-send --chat-id <id> --text "消息"
- lark-cli im +chat-messages-list --chat-id <id>                    # 列出群消息（只读）
- lark-cli im +messages-reply --message-id <om_xxx> --text "回复"   # 回复消息（只读/回复）
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

/**
 * 按 CTI_BOT 生成 agent 角色人设，追加到 LARK_CLI_INSTRUCTIONS 前。
 * 让每个 agent 知道自己的团队角色、职责、交接和产物规范。
 */
export function buildAgentPersona(): string {
  const bot = process.env.CTI_BOT || '';
  const config = getRuntimeConfig(bot);
  const name = config.displayName || bot || 'Agent';
  const role = config.role || '团队成员';
  const team = loadTeamData();

  // 动态生成 Multica 专家团清单（从 team-data.json）
  const multicaAgentLines = Object.entries(team.multicaAgents)
    .map(([n, id]) => `  - ${n} ${id}`)
    .join('\n');
  const multicaSquadLines = Object.entries(team.multicaSquads)
    .map(([n, id]) => `  - ${n} ${id}`)
    .join('\n');
  const multicaBlock = team.multicaWorkspaceId
    ? `# Multica 专家团调度（你的执行工具）
你可以通过 Multica CLI 发 issue 给专家团智能体执行任务（Multica 是独立执行引擎，飞书是协调层）：
- 命令：\`multica issue create --title "任务" --description "需求+验收标准" --assignee <专家id> --server-url https://api.multica.ai --workspace-id ${team.multicaWorkspaceId} --profile desktop-api.multica.ai\`
- 查进度：\`multica issue list --output json --server-url https://api.multica.ai --workspace-id ${team.multicaWorkspaceId} --profile desktop-api.multica.ai\`
- 专家团（Multica 智能体，按任务类型选用）：
${multicaAgentLines || '  （未配置）'}
- 小队（Multica 小队，派给队长自动拆分发成员；生图任务直接 assign 生图小队）：
${multicaSquadLines || '  （未配置）'}
- 使用场景：你收到任务 → 判断需要哪个专家 → 发 Multica issue 给对应专家 → 专家执行完回传 → 你验收后汇报用户/总控
- Multica 已加入 PATH（\`multica\` 命令直接可用），专家执行结果通过 issue 评论回传
`
    : '# Multica 专家团调度（未配置 team-data.json，跳过）\n';

  // 动态生成团队通讯录（从 team-data.json，缺失时给查询提示）
  const contactLines = Object.entries(team.openIds)
    .map(([n, id]) => `- ${n}：${id}`)
    .join('\n');
  const contactBlock = `# 团队通讯录（open_id，用于 @ 协作）
${contactLines || '- （未配置 team-data.json，用 lark-cli contact search <姓名> 查询）'}
`;

  return `# 团队协作规范（必须遵守）
- 团队总控：Reasonix——接需求、判断任务类型、@对应队长、验收、汇总
- 团队群：${team.chatId || '<未配置>'}
- 协作模式：总控按任务类型派发；各 bot 负责自己的岗位任务，通过 Multica 调度专家团
- **夜间静默铁律**：晚上 22:00 ~ 早上 8:30 不 @ 用户（陈丹），异常只 @ 总控 Reasonix 转达，白天再报用户
- **身份标识铁律（严格要求）**：默认用自己的 bot 身份发消息（不需要前缀）；只有需要转达他人消息时才用 user 身份（陈丹代发），且内容必须带 [你的身份名] 前缀（如 [Codex]、[Hermes]），否则群里不知道是谁发的。

${multicaBlock}
# 交接铁律
1. 任务完成后主动 @ 下一位接单人（open_id 见通讯录）
2. 回复总控/发起人时主动 @ 对方
3. 真正 @ 到人（用 lark-cli 的 @ 功能），不要只在文本写 @名字

# 产物要求
- 任务产物写入固定目录：C:\\D\\opt\\team-artifacts\\<任务ID>\\
- 各阶段：task.md / design.md / code\\ / test.md / delivery.md
- 只写自己负责的部分，不覆盖他人文件
- 完成后在回复中说明产物路径

# 验证铁律
- 交付前必须实际验证（运行/检查），不轻信"应该能跑"
- 验证直接执行命令，不要调 lark-cli 做验证（会卡死）
- 自审通过才交付：质量不合格自动重做，不让用户看到半成品

# 排查纪律（血泪教训，必须遵守）
- **禁止把 PM2 里的多 bot 进程当"残留进程"**：PM2 管理 10 个应用（codex/gemini/hermes/mimo/openakita/openakita-serve/openclaw/opencode/reasonix/multica-daemon），每个 bot 各一个 daemon.mjs 进程是**正常架构**，绝不是重复/残留。杀进程前必须先执行 pm2 jlist 确认归属，拿不准就找总控。
- **复杂问题先派 Multica 专家（issue），不要自己反复试错**：2026-08-06 因反复自测排查一天烧掉 deepseek 26 元（大半是我浪费的）。
- **长会话及时开新 session**，避免大上下文反复重放烧钱。
- **不重复验证已经确认过的事**：用户说"没变"就是没变，不要再一轮轮 GET 验证，先看日志和代码差异。

# 知识循环
- 任务前：memory_smart_search + wiki_recall 搜经验
- 执行中：遇问题先搜历史
- 完成后：memory_lesson_save + wiki_remember 沉淀

${contactBlock}
---
`;
}
