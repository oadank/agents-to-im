# agents-to-im

> 把 Claude Code 和 Codex 桥接到飞书，让团队在 IM 里直接用 AI 编码。

基于 [francize/agents-to-im](https://github.com/francize/agents-to-im) 二次开发，针对多实例部署做了优化。

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

---

## 架构

```
用户 (飞书)
  │
  ├─ Claude Bot ──→ feishu-claude.service ──→ Claude Code CLI
  │   (独立配置)      (端口 13579)           (工作目录: /opt)
  │
  └─ Codex Bot ──→ feishu-codex.service ──→ Codex CLI
      (独立配置)      (端口 13580)           (工作目录: /opt)
```

每个实例独立运行，有自己的：
- 飞书应用配置（APP_ID / APP_SECRET）
- 端口（Dashboard 互不冲突）
- 工作目录
- 会话状态

---

## 相比原版改了什么

### 1. 命令处理逻辑

**原版问题：** 把所有 `/` 开头的文本当作命令，导致 `/opt/.openclaw/workspace` 这类路径被误判为命令。

**修改：** 加入命令白名单，只有这些命令才触发处理：

```
/new  /new:claude  /new:codex  /reset  /stop
/start  /help  /status  /cwd  /mode  /bind  /sessions
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
| `CTI_DEFAULT_RUNTIME` | `claude` 或 `codex` |
| `CTI_DASHBOARD_PORT` | 控制面板端口，每个实例必须不同 |
| `CTI_DEFAULT_WORKDIR` | 默认工作目录 |

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
/reset          # 重置当前会话
/stop           # 停止当前输出
/status         # 查看状态
/help           # 帮助
```

---

## 许可证

MIT License

## 致谢

- 原项目：[francize/agents-to-im](https://github.com/francize/agents-to-im)
- Claude Code：[Anthropic](https://www.anthropic.com)
- Codex：[OpenAI](https://openai.com)
