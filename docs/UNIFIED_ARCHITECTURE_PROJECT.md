# agents-to-im 统一架构改造项目

## 项目背景

当前 agents-to-im 采用多实例架构，每个飞书 bot 对应一个独立的 agents-to-im 实例：
- feishu-claude → .agents-to-im-claude → claude-provider → Claude CLI
- feishu-codex → .agents-to-im-codex → codex-provider → Codex CLI
- feishu-mimo → .agents-to-im-mimo → mimo-provider → LiteLLM

**问题：**
- 需要维护多个实例，配置复杂
- 资源占用多（每个实例都要启动 Node.js 进程）
- 升级维护麻烦（需要逐个实例更新）

## 目标架构

```
多个飞书 bot (独立 app_id)
    ↓
单个 agents-to-im 实例
    ↓
根据 app_id 自动路由
    ↓
ACP 协议统一通信
    ↓
claude / codex / mimo / 其他 agent
```

**特点：**
- 飞书机器人保持独立（用户体验不变）
- 后端只有一个 agents-to-im 实例
- 根据 app_id 自动路由到对应的 agent
- 所有 agent 通过 ACP 协议通信

## 改造点分析

### 1. 多 app_id 支持
**当前：** 一个实例只能绑定一个飞书 app_id
**目标：** 一个实例绑定多个飞书 app_id

**改造内容：**
- 修改 `config.env` 配置格式，支持多个 app_id
- 修改 `adapter.ts`，支持多个飞书连接
- 添加 app_id → runtime 映射配置

**配置示例：**
```bash
# 多 bot 配置
CTI_BOTS=claude,codex,mimo

CTI_BOT_CLAUDE_APP_ID=cli_xxx
CTI_BOT_CLAUDE_APP_SECRET=***
CTI_BOT_CLAUDE_RUNTIME=claude

CTI_BOT_CODEX_APP_ID=cli_yyy
CTI_BOT_CODEX_APP_SECRET=***
CTI_BOT_CODEX_RUNTIME=codex

CTI_BOT_MIMO_APP_ID=cli_zzz
CTI_BOT_MIMO_APP_SECRET=***
CTI_BOT_MIMO_RUNTIME=mimo
```

### 2. app_id 路由机制
**当前：** 所有消息都走同一个 provider
**目标：** 根据 app_id 自动路由到对应的 provider

**改造内容：**
- 修改 `adapter.ts`，在收到消息时识别 app_id
- 修改 `multiplex.ts`，根据 app_id 选择对应的 provider
- 添加路由表：app_id → runtime → provider

**路由逻辑：**
```typescript
// 伪代码
function getRuntimeByAppId(appId: string): RuntimeName {
  return botConfig[appId]?.runtime || 'default';
}

// 在 adapter.ts 中
const runtime = getRuntimeByAppId(message.appId);
const provider = await this.getProvider(runtime);
```

### 3. ACP 协议适配
**当前：** 各 provider 使用不同的通信协议
**目标：** 所有 provider 统一使用 ACP 协议

**改造内容：**
- 创建 `acp-provider.ts`，实现 ACP 协议通信
- 改造 `claude-provider.ts`，支持 ACP 协议
- 改造 `codex-provider.ts`，支持 ACP 协议
- 改造 `mimo-provider.ts`，支持 ACP 协议

**ACP 协议优势：**
- 统一的 agent 通信标准
- 支持 session 管理、上下文保持
- 支持多个 agent 类型
- 已有实现：`/opt/acp` (claude-agent-acp)

### 4. 配置集中化
**当前：** 每个实例有独立的配置目录
**目标：** 一个配置目录，集中管理所有 bot

**改造内容：**
- 合并 `.agents-to-im-claude`、`.agents-to-im-codex`、`.agents-to-im-mimo` 为一个目录
- 统一配置文件格式
- 共享 LiteLLM 配置、API key 等

## 实现步骤

### 阶段 1：多 app_id 支持（预计 2-3 天）
1. 修改配置格式，支持多 bot 配置
2. 修改 adapter.ts，支持多个飞书连接
3. 测试：一个实例绑定多个 bot，能收到消息

### 阶段 2：app_id 路由（预计 1-2 天）
1. 实现 app_id → runtime 映射
2. 修改 multiplex.ts，根据 app_id 选择 provider
3. 测试：不同 bot 的消息路由到不同的 provider

### 阶段 3：ACP 协议适配（预计 3-5 天）
1. 创建 acp-provider.ts
2. 改造 claude-provider 支持 ACP
3. 改造 codex-provider 支持 ACP
4. 改造 mimo-provider 支持 ACP
5. 测试：所有 provider 通过 ACP 通信

### 阶段 4：配置集中化（预计 1 天）
1. 合并配置目录
2. 迁移现有配置
3. 测试：所有 bot 正常工作

### 阶段 5：清理和文档（预计 1 天）
1. 删除旧的实例配置
2. 更新文档
3. 更新 systemd 服务

**总预计时间：8-12 天**

## 风险评估

### 高风险
1. **ACP 协议兼容性** - 不是所有 agent 都原生支持 ACP，可能需要适配层
2. **飞书多 bot 绑定** - 需要验证一个实例能否同时绑定多个飞书 app
3. **上下文隔离** - 不同 bot 的会话上下文需要隔离，避免混淆

### 中风险
1. **配置迁移** - 现有配置复杂，迁移可能出错
2. **性能问题** - 单实例处理多个 bot，可能有性能瓶颈
3. **错误处理** - 一个 bot 出错不能影响其他 bot

### 低风险
1. **代码改动** - 主要改动在配置和路由，核心逻辑变化不大
2. **测试覆盖** - 可以逐个 bot 测试，风险可控

## 替代方案

### 方案 A：保持多实例，共享配置（保守方案）
- 保持当前的多实例架构
- 但共享一些配置（如 LiteLLM 地址、API key 等）
- **优点：** 改动小，风险低
- **缺点：** 资源占用多，配置复杂

### 方案 B：统一架构（激进方案）
- 完全按照上述改造计划实施
- **优点：** 资源少，配置简单
- **缺点：** 改动大，风险高

### 方案 C：混合架构（折中方案）
- 保持多实例，但用 ACP 协议统一通信
- 每个 bot 还是独立实例，但都通过 ACP 协议
- **优点：** 改动中等，风险可控
- **缺点：** 还是多实例，资源占用没减少

## 建议

**推荐方案 B（统一架构）**，理由：
1. 长期来看，统一架构更简洁、易维护
2. 资源占用少，性能更好
3. 符合未来扩展需求（新增 agent 更方便）

**实施策略：**
1. 先在测试环境验证
2. 分阶段实施，每个阶段独立测试
3. 保留回滚方案（保留旧的多实例配置）

## 下一步行动

1. **创建测试环境** - 在远程机器上搭建测试环境
2. **验证多 bot 绑定** - 测试一个实例能否绑定多个飞书 app
3. **实现阶段 1** - 多 app_id 支持
4. **逐步推进** - 每个阶段完成后测试验证

## 相关文件

- 桥接协议文档：`/opt/agents-to-im/docs/BRIDGE_PROTOCOL.md`
- Agent 切换备份：`/opt/agents-to-im/docs/backups/agent-switching/README.md`
- ACP 实现：`/opt/acp` (claude-agent-acp)
- 当前配置：`/opt/.agents-to-im-*`

## 参考资源

- ACP 协议：https://github.com/agentclientprotocol/claude-agent-acp
- agents-to-im 源码：https://github.com/oadank/agents-to-im
- 飞书开放平台：https://open.feishu.cn/app

---
**状态：** 规划中
**优先级：** P1（重要但不紧急）
**预计开始：** 待定
**负责人：** 待定
