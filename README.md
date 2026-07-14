# agents-to-im

> 把 AI 编码 Agent 桥接到飞书（Claude / Codex / MiMo / OpenHuman）

基于 [francize/agents-to-im](https://github.com/francize/agents-to-im) 二次开发，支持多 Runtime、多实例部署、动态模型显示。

---

## 解决什么问题

Claude Code 和 Codex 都是好用的终端 AI 编码工具，但有几个痛点：

1. **只能在终端用**：团队协作在飞书，但 AI 编码只能在本地终端，来回切换麻烦
2. **单实例限制**：原版只能运行一个实例，无法同时跑 Claude 和 Codex
3. **命令误判**：原版把 `/opt/xxx` 这类路径识别为命令，导致工作目录设置失败
4. **部署不持久**：手动启动容易丢失，重启后需要重新配置

本项目解决这些问题：
- ✅ 双实例同时运行（Claude + Codex 各自独立配置和状态）
- ✅ systemd 用户服务自动启动，重启不丢失
- ✅ 命令白名单机制，路径不再被误判为命令
- ✅ 独立工作目录，互不干扰
- ✅ 飞书用户身份发送消息（OAuth 授权，以用户而非机器人身份发消息）
- ✅ 多 Agent 路由（GLM / Gemini / Opencode 通过 MiMo 网关统一调度）

---

## 架构

```
用户 (飞书)
  │
  ├─ feishu-mimo ──→ LiteLLM ──→ MiMo-Go / DsV4go / codex-model
  │   (独立配置)      (代理层)
  │
  ├─ feishu-claude ──→ LiteLLM ──→ claude-model / MiMo-Anthropic
  │   (独立配置)      (代理层)
  │
  ├─ feishu-codex ──→ LiteLLM ──→ codex-model
  │   (独立配置)      (代理层)
  │
  └─ feishu-openhuman ──→ LiteLLM ──→ claude-model
      (独立配置)      (代理层)
```

每个实例独立运行，有自己的：
- 飞书应用配置（APP_ID / APP_SECRET）
- 端口（Dashboard 互不冲突）
- 工作目录
- 会话状态
- 模型配置（通过 LiteLLM 代理）

---

## 相比原版改了什么

### 1. 命令处理逻辑

**原版问题：** 把所有 `/` 开头的文本当作命令，导致 `/opt/.openclaw/workspace` 这类路径被误判为命令。

**修改：** 加入命令白名单，只有这些命令才触发处理：

```
/new  /new:claude  /new:codex  /new:glm  /new:gemini  /new:opencode
/reset  /stop  /start  /help  /status  /cwd  /mode  /bind  /sessions
```

其他 `/` 开头的文本（如路径）都当作普通消息处理。

### 2. 会话创建流程

**原版问题：** `/new:claude` 和 `/new:codex` 的处理逻辑分散，容易出错。

**修改：** 统一到一个处理函数，根据命令后缀自动选择运行时：
- `/new` → 用默认运行时
- `/new:claude` → 强制 Claude
- `/new:codex` → 强制 Codex

### 3. 多实例部署支持

新增配置模板和服务文件，支持同时部署 Claude 和 Codex 两个实例。

### 4. 飞书用户身份发送消息

支持以飞书用户身份（而非机器人身份）发送消息，让 AI 回复显示为用户自己发出，适用于 OpenHuman 等场景。

**工作原理：**
- 通过飞书 OAuth 2.0 授权流程获取 `user_access_token`
- Dashboard 提供 `/api/auth/url` 生成授权链接，`/oauth/callback` 处理回调
- `lark-client.ts` 中 `withUserAccessToken` 方法自动附加用户令牌
- `adapter.ts` 中 `shouldUseUserToken()` 判断是否使用用户身份

**新增配置项：**

| 变量 | 说明 |
|------|------|
| `CTI_OAUTH_REDIRECT_URI` | OAuth 回调地址 |
| `CTI_ENABLE_USER_MODE` | 启用用户身份模式 |

### 5. 多 Runtime 支持

支持多种 AI 编码工具作为 Runtime：

| Runtime | 说明 | 命令 |
|---------|------|------|
| claude | Claude Code CLI | `/new:claude` |
| codex | Codex CLI | `/new:codex` |
| mimo | MiMo 通过 LiteLLM | `/new:mimo` |
| openhuman | OpenHuman Agent | `/new:openhuman` |

- 每个 Runtime 独立配置模型和 Provider
- 通过 LiteLLM 代理层统一管理模型路由
- 支持动态切换模型（修改配置后重启服务）

### 6. Divider 动态显示

每条消息底部自动显示 Agent 信息：

```
Agent: feishu-mimo | Model: MiMogo | Provider: LiteLLM
```

**配置项：**

| 变量 | 说明 | 示例 |
|------|------|------|
| `CTI_FEISHU_SHOW_AGENT_DIVIDER` | 是否显示消息底部 divider | `true` |
| `CTI_AGENT_NAME` | Agent 名称（显示在 divider） | `feishu-mimo` |
| `CTI_MODEL_GROUP` | 模型组名（显示在 divider） | `MiMogo` |
| `CTI_MODEL_PROVIDER` | 服务商名（显示在 divider） | `LiteLLM` |

**特点：**
- 所有 Runtime 统一配置方式
- 修改配置后重启服务即生效
- 支持动态切换模型，divider 自动更新

---

## 部署

### 前置条件

- Node.js 20.6+
- 已安装 Claude Code CLI 和/或 Codex CLI
- 两个飞书应用（分别给 Claude 和 Codex 用）

### 安装

```bash
# 安装原版包
npm install -g agents-to-im

# 克隆本仓库
git clone https://github.com/oadank/agents-to-im.git
cd agents-to-im
```

### 配置 Claude 实例

```bash
# 创建实例目录
mkdir -p ~/.agents-to-im-claude

# 复制配置模板
cp instances/feishu-claude/config.env.example ~/.agents-to-im-claude/config.env

# 编辑配置，填写飞书应用密钥
$EDITOR ~/.agents-to-im-claude/config.env

# 安装 systemd 服务
cp systemd/feishu-claude.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now feishu-claude.service
```

### 配置 Codex 实例

```bash
mkdir -p ~/.agents-to-im-codex
cp instances/feishu-codex/config.env.example ~/.agents-to-im-codex/config.env
$EDITOR ~/.agents-to-im-codex/config.env

cp systemd/feishu-codex.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now feishu-codex.service
```

### 验证

```bash
# 查看服务状态
systemctl --user status feishu-claude.service
systemctl --user status feishu-codex.service

# 查看日志
journalctl --user -u feishu-claude.service -f
```

---

## 配置说明

### Claude 实例配置 (`~/.agents-to-im-claude/config.env`)

```bash
CTI_DEFAULT_WORKDIR=/opt                    # 默认工作目录
CTI_FEISHU_APP_ID=cli_XXXXXXXXXXXXX        # 飞书应用 ID
CTI_FEISHU_APP_SECRET=XXXXXXXXX             # 飞书应用密钥
CTI_FEISHU_SHOW_TOOL_CALL_CARDS=false       # 不显示工具调用卡片
CTI_DEFAULT_RUNTIME=claude                  # 默认运行时
CTI_DASHBOARD_PORT=13579                    # Dashboard 端口
CTI_DISABLE_PERMISSION_CHECK=true           # 禁用权限检查
```

### Codex 实例配置 (`~/.agents-to-im-codex/config.env`)

```bash
CTI_DEFAULT_WORKDIR=/opt
CTI_FEISHU_APP_ID=cli_YYYYYYYYYYYYYYYY     # 另一个飞书应用
CTI_FEISHU_APP_SECRET=YYYYYYYYY
CTI_FEISHU_SHOW_TOOL_CALL_CARDS=false
CTI_DEFAULT_RUNTIME=codex                   # 默认运行时改为 codex
CTI_DASHBOARD_PORT=13580                    # 端口与 Claude 不同
CTI_DISABLE_PERMISSION_CHECK=true
```

### 关键变量

| 变量 | 说明 |
|------|------|
| `CTI_FEISHU_APP_ID` | 飞书开放平台的应用 ID |
| `CTI_FEISHU_APP_SECRET` | 飞书应用密钥 |
| `CTI_DEFAULT_RUNTIME` | `claude`、`codex`、`mimo` 或 `openhuman` |
| `CTI_DASHBOARD_PORT` | 控制面板端口，每个实例必须不同 |
| `CTI_DEFAULT_WORKDIR` | 默认工作目录 |
| `CTI_FEISHU_SHOW_AGENT_DIVIDER` | 是否显示消息底部 divider（默认 `true`） |
| `CTI_AGENT_NAME` | Agent 名称，显示在 divider |
| `CTI_MODEL_GROUP` | 模型组名，显示在 divider |
| `CTI_MODEL_PROVIDER` | 服务商名，显示在 divider |

---

## 飞书应用配置

每个实例需要一个独立的飞书应用：

1. 在 [飞书开放平台](https://open.feishu.cn/app) 创建自定义应用
2. 启用 **机器人** 能力
3. 添加权限：`im:message`、`im:chat`、`im:chat.group` 等
4. 事件订阅：`im.message.receive_v1`
5. 长连接模式：启用 WebSocket
6. 发布应用

详细步骤参考：[原项目 Setup Guide](https://github.com/francize/agents-to-im/blob/main/references/setup-guides.md)

---

## 日常使用

在飞书里直接对话：

```
/new:claude     # 创建 Claude 会话
/new:codex      # 创建 Codex 会话
/new:mimo       # 创建 MiMo 会话
/new:openhuman  # 创建 OpenHuman 会话
/reset          # 重置当前会话
/stop           # 停止当前输出
/status         # 查看状态
/help           # 帮助
```

---

## Windows 11 NSSM 服务配置完整指南（踩坑实录）

> ⚠️ **这是生产环境部署的核心文档**。我们花了整整 3 天踩坑调试，每一步都是血泪教训，照着做可以节省你至少 20 小时。

### 为什么用 NSSM 而不是其他方式

在 Windows 上部署后台服务有几种方式：
- **pm2**: 不适用（Node.js 应用，但我们的 ACP 子进程需要 Windows Session 0 特殊处理）
- **winsw**: XML 配置复杂，Debug 困难
- **nssm**: Windows 原生服务管理器，C 编写，轻量可靠，调试信息完整 → **推荐**

### 前置条件

```powershell
# 安装 NSSM（用 scoop 或 chocolatey）
scoop install nssm
# 或
choco install nssm

# 验证安装
nssm version
```

### 第一步：准备环境变量（最容易踩的坑）

**必须在 `config.env` 里明确设置以下变量**，不要依赖系统环境变量：

```bash
# 工作目录要用绝对路径，不要用 ~ 或 %USERPROFILE%
CTI_DEFAULT_WORKDIR=C:\D\opt

# 飞书配置
CTI_FEISHU_APP_ID=cli_XXXXXXXXXXXXX
CTI_FEISHU_APP_SECRET=XXXXXXXXXXXXXX

# 必须禁用工具调用卡片（NSSM Session 0 下有问题）
CTI_FEISHU_SHOW_TOOL_CALL_CARDS=false

# Dashboard 端口（每个 Provider 不同）
CTI_DASHBOARD_PORT=13581

# ACP 子进程环境配置（关键！）
APPDATA=C:\Users\你的用户名\AppData\Roaming
USERPROFILE=C:\Users\你的用户名
```

### 第二步：NSSM 服务安装配置

以 `agents-hermes` 为例，其他 Provider（codex/gemini/mimo）完全相同。

#### 方式一：图形界面（推荐，不容易错）

```powershell
# 必须用管理员权限打开 PowerShell！
nssm install agents-hermes
```

弹出图形界面后，按以下配置：

| 标签页 | 配置项 | 值 | 说明 |
|--------|--------|----|------|
| **Application** | Path | `C:\Program Files\nodejs\node.exe` | Node 绝对路径，不要用相对路径 |
| | Startup directory | `C:\D\opt\agents-to-im` | 项目根目录，**绝对路径** |
| | Arguments | `C:\D\opt\agents-to-im\dist\daemon.mjs` | daemon.mjs 的绝对路径 |
| **Log on** | Log on as | `Local System account` | **勾选** `Allow service to interact with desktop` ← 这是 Session 0 关键 |
| **Process** | Console window | ✅ `Create console window` | 这是解决 Session 0 死锁的关键 |
| | Priority | `Normal` | 默认即可 |
| | Affinity | All | 默认即可 |
| **I/O** | Output (stdout) | `C:\Users\你的用户名\.agents-to-im\logs\hermes-stdout.log` | 路径必须存在，否则服务启不来 |
| | Error (stderr) | `C:\Users\你的用户名\.agents-to-im\logs\hermes-stderr.log` | 同上 |
| | File rotation | ✅ `Replace existing files` | 自动轮转日志 |
| **Environment** | Environment variables | 把 `config.env` 的所有变量一行一行粘贴进来 | 每一行 `KEY=VALUE` 格式 |
| **Exit action** | Exit action | `Restart application` | 崩溃自动重启 |
| | Restart delay | `1000 ms` | 1 秒后重启 |
| | Throttle restart | `60000 ms` | 1 分钟内连续重启超过 5 次就停止（防止死循环） |

#### 方式二：命令行（自动化脚本）

```powershell
# 必须管理员权限！
$serviceName = "agents-hermes"

# 1. 创建服务
nssm install $serviceName C:\Program Files\nodejs\node.exe

# 2. 配置参数
nssm set $serviceName AppDirectory C:\D\opt\agents-to-im
nssm set $serviceName AppParameters C:\D\opt\agents-to-im\dist\daemon.mjs

# 3. 关键！允许服务与桌面交互（解决 Session 0 死锁）
nssm set $serviceName Type SERVICE_WIN32_OWN_PROCESS + SERVICE_INTERACTIVE_PROCESS

# 4. 日志路径（路径必须先存在！）
mkdir C:\Users\你的用户名\.agents-to-im\logs -Force
nssm set $serviceName AppStdout C:\Users\你的用户名\.agents-to-im\logs\hermes-stdout.log
nssm set $serviceName AppStderr C:\Users\你的用户名\.agents-to-im\logs\hermes-stderr.log
nssm set $serviceName AppStdoutCreationDisposition 4  # 覆盖而非追加
nssm set $serviceName AppStderrCreationDisposition 4

# 5. 环境变量（把 config.env 的内容全部设进去）
$envVars = @(
  "CTI_BOT=hermes",
  "CTI_DEFAULT_RUNTIME=hermes",
  "CTI_DASHBOARD_PORT=13581",
  "CTI_DEFAULT_WORKDIR=C:\D\opt",
  "APPDATA=C:\Users\你的用户名\AppData\Roaming",
  "USERPROFILE=C:\Users\你的用户名",
  "PATH=C:\Windows\System32;C:\Program Files\nodejs"  # 关键！确保 node 和 nssm 能找到子进程
)

foreach ($env in $envVars) {
  nssm set $serviceName AppEnvironment $env
}

# 6. 设置自动重启
nssm set $serviceName AppExit Default Restart
nssm set $serviceName AppRestartDelay 1000
nssm set $serviceName AppThrottle 60000

# 7. 设置启动类型为自动
Set-Service -Name $serviceName -StartupType Automatic
```

### 第三步：Session 0 隔离的核心坑点（划重点）

这是这次调试 3 天的核心发现：

#### ❌ 坑 1：Windows Session 0 没有真实控制台

**现象**：
- 手动 `node dist/daemon.mjs` 运行一切正常
- NSSM 服务启动后，发飞书消息永远卡死在 `conversation turn:`
- 没有报错，没有超时，进程状态正常，就是不响应

**根因**：
Windows Session 0（服务运行的隔离环境）没有真实的 `conhost.exe`。当 Python/Node.js 子进程做以下操作时会**永久死锁**：

1. `git status` / `git rev-parse` 等 git 命令（Hermes 的 `coding_system_blocks()`）
2. `subprocess.run()` 捕获 stdout/stderr 时，句柄继承失败
3. Windows API `GetConsoleWindow()` 返回 `NULL` 导致无限等待

**解决方案**（必须同时满足）：
1. ✅ NSSM 中勾选 `Allow service to interact with desktop`
2. ✅ NSSM 中勾选 `Create console window`
3. ✅ 代码层对 `platform == "acp"` 跳过 git/filesystem 探测（见下文）

#### ❌ 坑 2：PYTHONUNBUFFERED 不是万能的

**现象**：加了 `PYTHONUNBUFFERED=1` 还是卡死。

**根因**：这个环境变量只解决 Python 的 stdout 缓冲问题，不解决 `git` 子进程的 Windows API 级死锁。

#### ❌ 坑 3：SQLite 并发锁理论不成立

**现象**：一开始以为是 SQLite 数据库锁。加了 WAL、加了 timeout、试了内存模式，全部无效。

**根因**：卡死发生在 `build_system_prompt()` 的 git 探测阶段，根本还没到 SQLite 写入的 `_ensure_db_session()`。

#### ❌ 坑 4：环境变量必须全部显式声明

**现象**：Hermes 启动后提示找不到 `.hermes` 目录。

**根因**：Session 0 下 `os.homedir()` 返回 `C:\Windows\System32\config\systemprofile` 而非用户目录。

**解决方案**：`AppEnvironment` 中必须显式设置 `USERPROFILE` 和 `APPDATA`。

### 第四步：代码层修复（四个 Provider 各有各的坑）

#### 1. Hermes 特殊修复（最复杂）

Hermes 是唯一用 Python ACP 的，Session 0 死锁最严重。

**修复位置**：`C:\Users\oadan\AppData\Local\hermes\hermes-agent\agent\system_prompt.py`

```python
# 在 coding_system_blocks() 调用前加条件（约 350 行）
# NOTE: Skip for ACP platform — non-interactive service (NSSM/Session 0)
# can hang in git/filesystem probes; ACP clients don't need workspace context.
if agent.valid_tool_names and agent.platform != "acp":
    # ... 原来的 coding_system_blocks() 代码 ...

# 在 env_probe 调用前加同样条件（约 380 行）
if getattr(agent, "_environment_probe", True) and agent.platform != "acp":
    # ... 原来的 env_probe 代码 ...
```

**同时**：`hermes-app-server-client.ts` spawn 时必须传正确的 env：

```typescript
const proc = spawn(this.executable, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    HOME: os.homedir(),
    HERMES_HOME: resolveHermesHome(),
    USERPROFILE: os.homedir(),
    APPDATA: process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    PYTHONUNBUFFERED: '1',  // 虽然解决不了死锁，但还是要加
  },
  windowsHide: true,  // 只隐藏窗口，不影响句柄
});
```

#### 2. Codex 修复（异步化）

**修复位置**：`src/providers/codex/codex-provider.ts`

```typescript
// execSync → exec（异步），避免阻塞事件循环
import { exec } from 'node:child_process';  // 不要用 execSync

// fs 同步 → fs/promises
import fs from 'node:fs/promises';

// running 事件必须在 try 之前 emit
emitCanonicalTurnEvent(controller, { type: 'status', data: { status: 'running' } });
try {
  // ... 工具执行 ...
} catch (e) {
  // ...
}
```

#### 3. MiMo 修复（ReferenceError 静默吞没）

**修复位置**：`src/providers/mimo/mimo-provider.ts`

```typescript
// 必须先声明 env，再传给 spawn
function buildSpawnEnv(): NodeJS.ProcessEnv {
  return { ... };
}

const env = buildSpawnEnv();  // 不要漏掉这行！
const child = spawn(command, ['acp', ...], {
  env,  // 用声明的变量，不要直接写 buildSpawnEnv()
  // ...
});

// streamChat 入口必须加 async try/catch，防止 void runAcp 吞掉错误
async streamChat(params: StreamChatParams): ReadableStream<string> {
  try {
    // ...
  } catch (e) {
    console.error('[mimo-provider] Error:', e);
    throw e;
  }
}
```

#### 4. Gemini 修复（drain 等待无超时）

**修复位置**：`src/providers/gemini/gemini-provider.ts`

```typescript
// drain 等待必须加超时，否则 wakeQueue 永远不 resolve
const MAX_DRAIN_WAIT_MS = 3000;
const drainStart = Date.now();

// 在 drain 循环里
() => {
  const elapsed = Date.now() - drainStart;
  if (elapsed >= MAX_DRAIN_WAIT_MS || queue.length > 0) {
    if (queue.length === 0) return Promise.reject(new Error('drain-done'));
    return;
  }
  const remainingMs = MAX_DRAIN_WAIT_MS - elapsed;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('drain-done')), remainingMs);
    wakeQueue = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}
```

### 第五步：验证服务

```powershell
# 启动服务
Start-Service agents-hermes

# 查看状态
Get-Service agents-hermes
# Status 应该是 Running

# 查看进程（应该有 2 个：node daemon.mjs + hermes acp 子进程）
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*hermes*" } | Select-Object ProcessId, CommandLine

# 查看日志
Get-Content C:\Users\你的用户名\.agents-to-im\logs\hermes-stderr.log -Tail 50 -Wait
```

### 第六步：发送第一条消息验证

1. 去飞书找到对应的 Bot
2. 发消息 "测试"
3. 如果 10 秒内有回复，成功了！
4. 如果超过 30 秒没回复：
   - 看日志有没有 `conversation turn:` — 有说明走到了 Python 层
   - 如果卡在 `conversation turn:` 后面不动，说明还是 Session 0 死锁
   - 回查 NSSM 的 `Allow service to interact with desktop` 和 `Create console window` 是否勾选
   - 回查 Python `system_prompt.py` 里 `platform != "acp"` 是否正确

### 四个 Provider 端口分配建议

| Provider | 服务名 | Dashboard 端口 |
|----------|--------|----------------|
| Claude | agents-claude | 13579 |
| Codex | agents-codex | 13580 |
| Gemini | agents-gemini | 13581 |
| MiMo | agents-mimo | 13582 |
| Hermes | agents-hermes | 13583 |

### 常见问题排查速查表

| 问题 | 排查方向 | 解决方案 |
|------|---------|---------|
| 服务启动后立即退出 | 日志文件路径是否存在、Node 路径是否正确、环境变量是否正确 | `nssm edit agents-xxx` 检查 I/O 标签页路径是否有写入权限 |
| 能建立 session，但发消息卡死 | Python 层 Session 0 死锁 | 检查 `coding_system_blocks()` 跳过逻辑 + NSSM 的两个 checkbox |
| 回复很慢（90秒） | drain 等待超时 | 检查 `MAX_DRAIN_WAIT_MS` setTimeout 逻辑（Gemini/MiMo） |
| 能建立 session，但不发消息 | ReferenceError 被 void 吞掉 | 检查 spawn env 变量是否先声明（MiMo/Hermes） |
| 工具调用不显示卡片 | 事件循环阻塞 | 检查是否用了 `execSync` 或同步 fs 调用（Codex） |

---

## 已知问题修复记录（生产环境踩坑史）

> 这些都是实际生产环境遇到的问题，每一个都导致服务至少 1 小时不可用。

### 1. Hermes Session 0 死锁

**时间**: 2026-07-14

**现象**: 手动运行正常，NSSM 服务发消息永久卡死在 `conversation turn:`

**根因**: Windows Session 0 下 `coding_system_blocks()` 的 git 探测导致子进程死锁

**修复文件**:
- `C:\Users\oadan\AppData\Local\hermes\hermes-agent\agent\system_prompt.py`（核心 Python 修复）
- `src/providers/hermes/hermes-app-server-client.ts`（TypeScript spawn env 修复）

**Commit**: `9372bda`

### 2. MiMo env 变量未声明 ReferenceError

**时间**: 2026-07-14

**现象**: `session/new` 返回成功，但后续 `session/prompt` 永远不执行，锁 90 秒超时

**根因**: `createCacheEntry()` 引用未声明的 `env` 变量，抛 `ReferenceError` 被 `void runAcp` 静默吞掉

**修复文件**: `src/providers/mimo/mimo-provider.ts`

**Commit**: `cd8893b`

### 3. Gemini drain 等待无超时（90秒慢响应）

**时间**: 2026-07-14

**现象**: LLM 2-3 秒生成完，但要等 90 秒才在飞书显示

**根因**: drain 等待逻辑中 `wakeQueue = resolve` 没有新通知唤醒，永久等待直到全局 90 秒超时

**修复文件**: `src/providers/gemini/gemini-provider.ts`

**Commit**: `ac36b89`

### 4. Codex 同步 exec 阻塞事件循环

**时间**: 2026-07-12

**现象**: 工具执行正常，但三栏预览的"正在运行"卡片永远不显示

**根因**: `execSync()` 阻塞 Node.js 事件循环，`running` 事件无法 emit

**修复文件**: `src/providers/codex/codex-provider.ts`

**Commit**: `cf7fd2e`

---

## 许可证

MIT License

## 致谢

- 原项目：[francize/agents-to-im](https://github.com/francize/agents-to-im)
- Claude Code：[Anthropic](https://www.anthropic.com)
- Codex：[OpenAI](https://openai.com)
- NSSM：[Non-Sucking Service Manager](https://nssm.cc/)
