# agents-to-im

> **把 AI 编码 Agent 桥接到飞书/Lark —— 一个机器人，接入你的整个 AI 团队。**

基于 [francize/agents-to-im](https://github.com/francize/agents-to-im) 深度二次开发，原生支持 **11 种 AI 运行时**、**语音收发**、**缓存命中率监控**、**多机器人团队协作**与**统一认知注入**。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.6-green.svg)](https://nodejs.org/)

[English](README.md) · [中文](README.zh-CN.md)

---

## 为什么你需要它（痛点）

Claude Code、Codex、Gemini、Hermes……每个 AI 编码工具都很强，但**它们都困在你的终端里**：

| 痛点 | 每天在发生 |
|------|-----------|
| 🔄 **工具切换地狱** | Claude 写代码、Codex 查资料、Gemini 生图……每个都要打开独立终端、记各自的命令和 API Key |
| 👁️ **黑盒不可见** | AI 在终端里闷头跑，你看不到它在想什么、调了什么工具、花了多少 token |
| 💸 **重复烧钱** | 不知道缓存命中率，长对话反复重放上下文，API 费用悄悄涨 |
| 🗣️ **只能在电脑前** | 团队在飞书协作，AI 却只能在你座位上用，离开电脑就失联 |
| 🧩 **无法协作** | 多个 AI 各干各的，没有统一调度，没有团队认知共享 |

**agents-to-im 把这一切搬进飞书**——你的 AI 团队 24 小时在线，随时随地在聊天里干活。

---

## 核心亮点（本项目的增强）

### 1️⃣ 统一对接：一个机器人接入所有 AI，不用逐个配置 API

不用为每个 AI 工具单独申请 App、单独配 Webhook、单独写适配层。**一个飞书应用实例 = 一个 AI 运行时**，11 种运行时开箱即用：

| 运行时 | 说明 |
|--------|------|
| **Claude Code** | Anthropic 官方编码 Agent |
| **Codex** | OpenAI 编码 Agent（原生 Rust CLI） |
| **Gemini** | Google 多模态模型 |
| **Hermes** | 测试/巡检专用 Agent |
| **MiMo** | 国产大模型（通过 LiteLLM 网关） |
| **OpenAkita** | 开源 Agent 框架 |
| **OpenClaw** | 深度调研 Agent |
| **OpenCode** | 生图/前端 Agent |
| **OpenHuman** | 人设 Agent |
| **Reasonix** | 总控/调度 Agent |
| **ZCode** | 额外编码运行时 |

每个运行时通过 **LiteLLM 统一代理层**路由模型——换模型、换服务商只改一行配置，**不用动任何业务代码**。

### 2️⃣ 分层可见：思考层 / 工具执行层 / 正文，一目了然

不再是一个黑盒回复。飞书消息卡片**分层展示 AI 的完整工作过程**：

```
┌─────────────────────────────────────┐
│ 💭 思考层    "先分析需求，拆成3步…"      │
│ 🔧 工具执行  调用 Bash → 读取文件 → 编辑   │
│ 📝 正文      "已完成：新增登录接口…"      │
├─────────────────────────────────────┤
│ Agent: codex │ Model: qwen3.7 │ 缓存: 99.2% │
└─────────────────────────────────────┘
```

- **思考层（reasoning）**：AI 的推理过程单独展示，不污染正文
- **工具执行层（tool_use）**：每一步调了什么工具、传入什么参数、返回什么结果，全部可见
- **正文**：最终交付内容
- **底部 meta 行**：**哪个机器人、用的什么模型、哪个服务商、session ID、缓存命中率**（最近一轮 + 当日平均）——每次回复都透明可见

### 3️⃣ 缓存命中率监控：省钱看得见

自动统计每个 session 的**缓存命中率**（`cache_read_input_tokens` / 总输入 token），每条回复底部实时显示**最近一轮 + 当日平均命中率**：

- **Claude / Codex / OpenCode**（走 SDK/SSE 并上报 usage）：显示**各自真实**的缓存命中率，长对话命中率可达 **95-99%**，token 开销压到最低
- **Reasonix**（ACP 直连）：读取本地 stats 文件显示真实命中率
- **其他运行时**（未上报 usage 的）：显示 `--`（未统计），**不会用其他 bot 的数据顶替**
- 数据按 session 独立统计，方便对比不同模型的成本表现

> ⚠️ 已知限制：缓存命中率依赖运行时上报 `cache_read_input_tokens`，只有支持该字段的运行时才有真实数据；未上报的显示 `--` 而非编造数值。

### 4️⃣ 语音收发：在飞书里用语音指挥 AI

- **🎤 语音输入**：用户发语音 → 自动 ASR 转文字 → 带 `[Audio]` 标记进对话，AI 理解意图
- **🔊 语音输出**：AI 回复自动/手动 TTS 合成语音（小米 → Edge → 本地多级回退），发回飞书
- 语音转写不准时，AI 结合上下文猜测真实意图（如 "wiki" 被转成 "rick" 也能理解）

### 5️⃣ 统一注入：团队认知自动同步给所有机器人

通过 `runtime-configs.ts` + `team-data.json`，**一套配置同时注入所有 bot 的系统提示词**：

- 团队协作规范、角色分工、通讯录（open_id）、交接铁律
- 常用工具姿势（发消息/发图/语音/查 wiki）、MCP 指引
- 知识循环（任务前搜经验 → 任务后沉淀）
- **改一处，全部 bot 生效**——不用挨个维护每个人的 prompt

### 6️⃣ 多机器人团队协作：一个群里一支 AI 团队

不只一个机器人——**9 个 bot 在同一个飞书群各司其职**（总控/编码/文案/生图/测试/推送/巡检…），通过 Multica 调度专家团：

- 总控接需求 → 拆解 → @ 对应队长 → 验收汇总，完整闭环
- 每个 bot 独立会话、独立身份、独立模型
- 定时巡检（autopilot）自动检查系统健康，**正常静默、异常才打扰**
- bot 间消息过滤（`sender_type=app` 拦截），避免机器人互相刷屏

---

## 基础功能（原版能力，本仓库完整保留）

- **私聊控制面 + 专属会话群**：`/new:claude` 创建独立飞书群绑定唯一会话，多会话互不干扰
- **本地状态持久化**：会话/绑定/消息历史存在本地，重启后完整恢复
- **CardKit 流式卡片**：AI 回复实时流式渲染，工具调用卡片单独展示
- **权限系统**：allowlist 白名单控制谁能驱动 bot；危险操作需审批（permission request 卡片）
- **命令白名单**：`/new /reset /stop /help /status /cwd /mode /bind /sessions` 等，路径不再被误判为命令
- **多实例部署**：每个 bot 独立 App/端口/工作目录，互不干扰
- **飞书用户身份发送**（OAuth）：可选以用户而非机器人身份发消息
- **动态模型切换**：改配置重启即换模型，divider 自动更新
- **飞书/Lark 双域支持**：`CTI_FEISHU_DOMAIN` 一键切换国际版

---

## 架构

```
飞书用户
  │
  ├─ feishu-claude ──→ LiteLLM ──→ claude-model
  ├─ feishu-codex ──→ LiteLLM ──→ codex-model
  ├─ feishu-gemini ──→ LiteLLM ──→ gemini-model
  ├─ feishu-hermes ──→ LiteLLM ──→ codex-model
  ├─ feishu-mimo ──→ LiteLLM ──→ deepseek-v4f
  ├─ …（共 9-11 个实例）…
  │
  └─ 统一注入: runtime-configs.ts + team-data.json（团队认知同步）
        │
        ▼
  每个 bot 系统提示词 = 基础指令 + 团队规范 + 语音/卡片/MCP 指引
```

每个实例独立：飞书 App 配置、端口、工作目录、会话状态、模型路由。

---

## 快速开始

### 前置条件

- Node.js ≥ 20.6
- 至少一个已安装并登录的 AI CLI（Claude Code / Codex / …）
- 一个飞书自定义应用（开放平台创建，开启机器人能力）

### 安装

```bash
npm install -g agents-to-im

# 克隆本仓库
git clone https://github.com/oadank/agents-to-im.git
cd agents-to-im
npm install && npm run build
```

### 配置

```bash
# 创建配置目录
mkdir -p ~/.agents-to-im
cp config.env.example ~/.agents-to-im/config.env

# 编辑：填入飞书 App ID/Secret、允许的用户、默认工作目录
$EDITOR ~/.agents-to-im/config.env
```

最小配置：

```bash
CTI_DEFAULT_WORKDIR=/path/to/your/project
CTI_FEISHU_APP_ID=cli_XXXXXXXXXXXXX
CTI_FEISHU_APP_SECRET=your-secret
CTI_FEISHU_ALLOWED_USERS=ou_your_open_id     # 安全：只允许你自己
CTI_DEFAULT_RUNTIME=claude                    # 或 codex/gemini/hermes/...
CTI_DASHBOARD_PORT=13580                      # 每个实例独立端口
```

### 启动

```bash
# 开发模式
npm run dev

# 生产模式（推荐）
npm start                # 或 scripts/daemon.ps1 / daemon.sh
```

**Windows 推荐 PM2 托管**（多 bot 场景）：

```bash
pm2 start ecosystem.config.js
pm2 save && pm2 startup   # 开机自启
```

---

## 配置参考（主要变量）

| 变量 | 说明 |
|------|------|
| `CTI_FEISHU_APP_ID` / `CTI_FEISHU_APP_SECRET` | 飞书应用凭证 |
| `CTI_FEISHU_ALLOWED_USERS` | 允许驱动的用户白名单（安全关键） |
| `CTI_DEFAULT_RUNTIME` | 默认运行时（claude/codex/gemini/hermes/mimo/openakita/openclaw/opencode/openhuman/reasonix/zcode） |
| `CTI_DASHBOARD_PORT` | 控制面板端口（多实例各不同） |
| `CTI_DEFAULT_WORKDIR` | 默认工作目录 |
| `CTI_FEISHU_DOMAIN` | `feishu`（默认）或 `lark`（国际版） |
| `CTI_FEISHU_SHOW_TOOL_CALL_CARDS` | 是否显示工具调用卡片 |
| `CTI_FEISHU_SHOW_AGENT_DIVIDER` | 是否显示底部 Agent/模型/缓存 meta 行 |
| `CTI_AGENT_NAME` / `CTI_MODEL_GROUP` / `CTI_MODEL_PROVIDER` | meta 行显示的 Agent/模型/服务商 |
| `CTI_STUCK_TIMEOUT_MS` | 流式响应卡死超时（默认 5 分钟自动中断） |

语音相关：`TTS_PROVIDER`（指定 TTS 服务商）、`CTI_BOT`（语音脚本使用的 bot 身份）。

---

## 常见命令

| 命令 | 作用 |
|------|------|
| `/new[:runtime]` | 创建新会话群（可指定运行时） |
| `/reset` | 重置当前会话 |
| `/stop` | 停止当前任务 |
| `/status` | 查看状态 |
| `/cwd` | 查看/切换工作目录 |
| `/mode` | 切换模式 |
| `/bind` / `/sessions` | 会话绑定管理 |

---

## 项目结构

```
src/
├── providers/       # 11 个运行时适配（claude/codex/gemini/hermes/mimo/openakita/openclaw/opencode/openhuman/reasonix/zcode）
├── bridge/          # 会话引擎、流式处理、缓存统计、权限
├── feishu/
│   ├── cards/       # CardKit 卡片（流式/工具调用/会话/权限）
│   ├── handlers/    # 入站消息/卡片回调/会话处理
│   ├── adapter.ts   # 飞书适配 + meta 行（Agent/模型/缓存命中率）
│   ├── tts-cli.mjs / edge-tts.mjs / asr-service.mjs  # 语音收发
│   └── send-feishu-voice.ps1 / .sh   # 语音发送脚本
└── config/
    ├── runtime-configs.ts  # 统一注入（所有 bot 系统提示词）
    └── team-data.json      # 团队通讯录/协作配置
```

---

## License

MIT
