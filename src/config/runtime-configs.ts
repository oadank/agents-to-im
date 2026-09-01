/**
 * Runtime 配置 - 定义每个 runtime 的真实模型和提供商信息
 * 每次调用 getRuntimeConfig 时重新读取配置文件，支持热更新
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// ── 提示词外置（config/prompts/*.md）──
// 改 md 文件即可更新人设/统一注入，新会话（/new）自动生效，无需编译重启。
// 编译产物在 dist/（一级 ../ = agents-to-im 根）；dev 在 src/config/（两级 ../）
const _promptDirCandidates = [
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'prompts'),
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'prompts'),
  path.join(process.cwd(), 'config', 'prompts'),
];

function readPromptFile(name: string): string {
  for (const dir of _promptDirCandidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        /* try next */
      }
    }
  }
  console.warn(`[runtime-configs] prompt file missing: ${name}`);
  return '';
}

/** 惰性读取 lark-instructions.md（改文件即生效，无需编译重启） */
export function larkInstructions(): string {
  return readPromptFile('lark-instructions.md');
}

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

  // DSH runtime：模型由 dsh-bot ACP 配置决定（cordis.yml），这里实时读 config.env
  if (runtime === 'dsh') {
    const env = readConfigEnv();
    const model = env.CTI_BOT_DSH_MODEL_GROUP || 'deepseek-v4-flash';
    const provider = env.CTI_BOT_DSH_MODEL_PROVIDER || 'deepseek';
    console.log(`[runtime-configs] runtime=dsh → model=${model} provider=${provider} (from config.env)`);
    return { model, provider, displayName: 'DSH', role: '总控/主控：接需求、判断任务类型、@对应队长、验收汇总，维护任务看板' };
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
  const common = readPromptFile('system-common.md')
    .replaceAll('{{TEAM_CHAT_ID}}', team.chatId || '<未配置>');
  const lark = readPromptFile('lark-instructions.md');
  return `${common}\n\n---\n${lark}`.trim();
}

/**
 * 按 CTI_BOT 生成 agent 角色人设。
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
  // 已实测验收通过的小队（✅ 标注；2026-08-09 起维护，新增实测团队在此追加名字即可）
  const testedSquads = ['生图小队', '文案创作小队'];
  const multicaSquadLines = Object.entries(team.multicaSquads)
    .map(([n, id]) => `  - ${n} ${id}${testedSquads.includes(n) ? ' ✅实测通过' : ''}`)
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
- ✅实测通过 = 该小队已经过全链路实测验收（可直接派活，无需再测）。当前已实测：生图小队（OpenCode 队长，文生图全流程）、文案创作小队（MiMo 队长，公众号选题→文案→配图→建稿→发布全链路）。后续新增实测团队会在此追加 ✅ 标注。
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

  const personaCommon = readPromptFile('agent-persona-common.md')
    .replaceAll('{{TEAM_CHAT_ID}}', team.chatId || '<未配置>')
    .replaceAll('{{MULTICA_BLOCK}}', multicaBlock)
    .replaceAll('{{CONTACT_BLOCK}}', contactBlock);
  return personaCommon.trim();
}
