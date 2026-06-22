# Agent 切换功能备份

## 功能说明

agents-to-im 支持通过命令切换不同的 AI Agent（GLM、Gemini、OpenCode），所有 Agent 都通过 MiMo 网关运行。

## 当前状态

**暂时禁用**：由于 zcode 不再使用，切换功能暂时禁用。但代码已保留在 `src/providers/zcode/zcode-provider.ts` 中。

## 切换命令

在飞书中发送以下命令切换 Agent：

- `/agent:glm` - 使用 GLM（智谱）
- `/agent:gemini` - 使用 Gemini（Google）
- `/agent:opencode` - 使用 OpenCode

## 技术实现

### 1. 命令解析

在 `src/providers/zcode/zcode-provider.ts` 中：

```typescript
function parseAgent(model?: string): AgentName {
  if (model?.startsWith('agent:')) {
    const name = model.slice(6) as AgentName;
    if (name in AGENT_CLI) return name;
  }
  return 'glm'; // 默认
}
```

### 2. Agent 配置

```typescript
const AGENT_CLI: Record<AgentName, AgentCliConfig> = {
  glm: {
    bin: 'zcode-acp',
    args: () => ['acp'],
    json: false,
    useSandboxCwd: false,
  },
  gemini: {
    bin: 'node',
    args: () => ['/opt/zcode/resources/gemini/gemini.js', '--acp'],
    json: false,
    useSandboxCwd: true,
  },
  opencode: {
    bin: '/opt/zcode/resources/opencode/opencode',
    args: () => ['acp'],
    json: false,
    useSandboxCwd: true,
  },
};
```

### 3. 架构

所有 Agent 都通过 ACP 协议与 MiMo 网关通信：

```
用户 → /agent:xxx → zcode-provider → ACP 协议 → MiMo 网关 → 实际模型
```

- **GLM**: zcode-acp → MiMo (OpenAI 格式)
- **Gemini**: gemini.js → mimo-gemini-proxy:8901 → MiMo (Google API ↔ OpenAI 格式转换)
- **OpenCode**: opencode → MiMo (原生 OpenAI 格式)

## 如何重新启用

### 步骤 1：确保 zcode 服务运行

```bash
systemctl start feishu-zcode
```

### 步骤 2：在 inbound-handler.ts 中添加命令处理

在 `src/feishu/handlers/inbound-handler.ts` 中添加：

```typescript
if (text === '/agent:glm') {
  await ctx.handleAgentSwitchCommand(sender, inbound, 'glm');
  return;
}
if (text === '/agent:gemini') {
  await ctx.handleAgentSwitchCommand(sender, inbound, 'gemini');
  return;
}
if (text === '/agent:opencode') {
  await ctx.handleAgentSwitchCommand(sender, inbound, 'opencode');
  return;
}
```

### 步骤 3：实现 handleAgentSwitchCommand

在 `src/feishu/handlers/session-handler.ts` 中添加：

```typescript
async handleAgentSwitchCommand(
  sender: string,
  inbound: InboundMessage,
  agent: 'glm' | 'gemini' | 'opencode',
): Promise<void> {
  const address = this.resolveAddress(inbound);
  const store = this.getStore();
  const binding = store.getChannelBinding(this.channelType, address.chatId, this.profileId);
  
  if (!binding) {
    await this.sendAsPost(address, '请先使用 /new:zcode 创建会话', inbound.messageId);
    return;
  }
  
  // 更新 session 的 model 字段
  const session = store.getSession(binding.codepilotSessionId);
  if (session) {
    store.updateSessionModel(binding.codepilotSessionId, `agent:${agent}`);
    await this.sendAsPost(address, `已切换到 ${agent} Agent`, inbound.messageId);
  }
}
```

### 步骤 4：确保 Gemini proxy 运行

```bash
systemctl start mimo-gemini-proxy
```

## 注意事项

1. **Gemini 需要 proxy**：Gemini 使用 Google API 格式，需要 mimo-gemini-proxy 做格式转换
2. **会话隔离**：每个 Agent 的会话是独立的，切换 Agent 会创建新的会话
3. **上下文不共享**：不同 Agent 之间的对话历史不共享

## 未来计划

考虑将切换功能集成到 `/new:zcode` 命令中：

```
/new:zcode glm      # 创建 GLM 会话
/new:zcode gemini   # 创建 Gemini 会话
/new:zcode opencode # 创建 OpenCode 会话
```

或者支持在会话中动态切换：

```
/switch glm         # 在当前会话中切换到 GLM
/switch gemini      # 在当前会话中切换到 Gemini
```

## 相关代码

- `src/providers/zcode/zcode-provider.ts` - Agent 切换核心逻辑
- `src/feishu/handlers/inbound-handler.ts` - 命令处理
- `src/feishu/handlers/session-handler.ts` - 会话管理
- `src/runtime/driver.ts` - Runtime 驱动
