# agents-to-im 桥接协议文档

本文档说明如何接入新的 AI Agent 到 agents-to-im 系统。

## 架构概览

```
用户 (飞书)
  │
  ▼
Adapter (feishu/adapter.ts)
  │
  ▼
MultiplexLLMProvider (providers/multiplex.ts)
  │
  ├── RuntimeDriver (runtime/driver.ts)
  │     │
  │     └── LLMProvider (bridge/host.ts)
  │
  └── 具体 Provider 实现
        ├── ClaudeProvider
        ├── CodexProvider
        ├── MiMoProvider
        ├── ZCodeProvider (已废弃)
        └── OpenHumanProvider
```

## 接入新 Agent 的步骤

### 1. 定义 Runtime 类型

在 `src/runtime/types.ts` 中添加新的 runtime 名称：

```typescript
export type RuntimeName = 'claude' | 'codex' | 'openhuman' | 'zcode' | 'mimo' | 'your-new-agent';
```

### 2. 实现 Provider

Provider 负责与具体的 AI 服务通信。

**接口定义**（`src/bridge/host.ts`）：

```typescript
export interface LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string>;
  readSessionTitle(sessionId: string): Promise<string | null>;
  writeSessionTitle(sessionId: string, title: string): Promise<void>;
  dispose?(): Promise<void>;
}

export interface StreamChatParams {
  sessionId: string;
  message: string;
  cwd?: string;
  // ... 其他参数
}
```

**实现示例**（参考 `src/providers/mimo/mimo-provider.ts`）：

```typescript
import type { LLMProvider, StreamChatParams } from '../bridge/host.js';

export class YourNewProvider implements LLMProvider {
  async streamChat(params: StreamChatParams): Promise<ReadableStream<string>> {
    // 实现流式对话逻辑
    // 返回 ReadableStream<string>，每个 chunk 是 JSON 字符串
    // 格式：data: {"type": "content", "data": "响应内容"}
    // 格式：data: {"type": "done", "data": ""}
    // 格式：data: {"type": "error", "data": "错误信息"}
  }

  async readSessionTitle(sessionId: string): Promise<string | null> {
    // 读取会话标题（可选）
    return null;
  }

  async writeSessionTitle(sessionId: string, title: string): Promise<void> {
    // 写入会话标题（可选）
  }

  async dispose(): Promise<void> {
    // 清理资源（可选）
  }
}
```

### 3. 实现 RuntimeDriver

Driver 负责管理会话生命周期和流式输出。

**接口定义**（`src/runtime/driver.ts`）：

```typescript
export interface RuntimeDriver {
  prepare(): Promise<void>;
  streamTurn(params: StreamChatParams): ReadableStream<string>;
  readSessionTitle(sessionId: string): Promise<string | null>;
  writeSessionTitle(sessionId: string, title: string): Promise<void>;
  dispose?(): Promise<void>;
}
```

**实现示例**（参考 `src/runtime/driver.ts` 中的 `MiMoRuntimeDriver`）：

```typescript
import type { RuntimeDriver } from './driver.js';
import type { YourNewProvider } from '../providers/your-new/your-new-provider.js';

export class YourNewRuntimeDriver implements RuntimeDriver {
  constructor(
    private readonly store: JsonFileStore,
    private readonly config: Config,
    private readonly getProvider: () => Promise<YourNewProvider>,
  ) {}

  async prepare(): Promise<void> {
    // 初始化 provider
    await this.getProvider();
  }

  async streamTurn(params: StreamChatParams): Promise<ReadableStream<string>> {
    const provider = await this.getProvider();
    return provider.streamChat(params);
  }

  async readSessionTitle(sessionId: string): Promise<string | null> {
    return null;
  }

  async writeSessionTitle(sessionId: string, title: string): Promise<void> {
    // 可选：持久化会话标题
  }

  async dispose(): Promise<void> {
    const provider = await this.getProvider();
    await provider.dispose?.();
  }
}
```

### 4. 注册到 MultiplexLLMProvider

在 `src/providers/multiplex.ts` 中注册新的 provider 和 driver：

```typescript
import { YourNewProvider } from './your-new/your-new-provider.js';
import { YourNewRuntimeDriver } from '../runtime/driver.js';

export class MultiplexLLMProvider implements LLMProvider {
  private yourNewProvider: YourNewProvider | null = null;
  private yourNewDriver: YourNewRuntimeDriver | null = null;

  private async getYourNewProvider(): Promise<YourNewProvider> {
    if (this.yourNewProvider) return this.yourNewProvider;
    this.yourNewProvider = new YourNewProvider();
    return this.yourNewProvider;
  }

  protected async getProvider(runtime: RuntimeName): Promise<LLMProvider> {
    if (runtime === 'your-new-agent') return this.getYourNewProvider();
    // ... 其他 runtime
  }

  private getDriver(runtime: RuntimeName): RuntimeDriver {
    if (runtime === 'your-new-agent') {
      if (!this.yourNewDriver) {
        this.yourNewDriver = new YourNewRuntimeDriver(
          this.store,
          this.config,
          () => this.getProvider('your-new-agent') as Promise<YourNewProvider>,
        );
      }
      return this.yourNewDriver;
    }
    // ... 其他 runtime
  }
}
```

### 5. 添加配置项

在 `src/config/config.ts` 中添加配置：

```typescript
export interface Config {
  // ... 现有配置
  yourNewAgentConfig?: {
    apiKey?: string;
    baseUrl?: string;
    // ... 其他配置
  };
}
```

在 `config.env` 中添加：

```bash
CTI_YOUR_NEW_AGENT_API_KEY=***
YOUR_NEW_AGENT_BASE_URL=https://api.example.com
```

### 6. 添加命令支持

在 `src/feishu/handlers/inbound-handler.ts` 中添加命令：

```typescript
if (text === '/new:your-new-agent') {
  await ctx.handleCreateSessionCommand(sender, inbound, 'your-new-agent');
  return;
}
```

### 7. 添加 Divider 支持

在 `src/config/runtime-configs.ts` 中添加：

```typescript
export const RUNTIME_CONFIGS: Record<RuntimeName, RuntimeConfig> = {
  // ... 现有配置
  'your-new-agent': {
    model: process.env.YOUR_NEW_AGENT_MODEL || 'default-model',
    provider: process.env.YOUR_NEW_AGENT_PROVIDER || 'YourProvider',
  },
};
```

## 通信协议

### 流式响应格式

Provider 的 `streamChat` 方法返回 `ReadableStream<string>`，每个 chunk 是 JSON 字符串：

```typescript
// 内容块
data: {"type": "content", "data": "响应内容片段"}

// 完成
data: {"type": "done", "data": ""}

// 错误
data: {"type": "error", "data": "错误信息"}

// 工具调用（可选）
data: {"type": "tool_use", "data": {"name": "工具名", "input": {...}}}
```

### 会话管理

- 每个会话有唯一的 `sessionId`
- 会话信息存储在 `JsonFileStore` 中
- 可以通过 `store.getSessionExt(sessionId)` 获取会话扩展信息

## 示例：接入 OpenAI 兼容 API

假设要接入一个 OpenAI 兼容的 API（如 DeepSeek、Qwen 等）：

```typescript
// src/providers/openai-compatible/openai-compatible-provider.ts
import type { LLMProvider, StreamChatParams } from '../bridge/host.js';

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}

  async streamChat(params: StreamChatParams): Promise<ReadableStream<string>> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: params.message }],
        stream: true,
      }),
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    return new ReadableStream<string>({
      async start(controller) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

            for (const line of lines) {
              const data = line.slice(6);
              if (data === '[DONE]') {
                controller.enqueue(`data: ${JSON.stringify({ type: 'done', data: '' })}\n`);
                continue;
              }

              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content;
                if (content) {
                  controller.enqueue(`data: ${JSON.stringify({ type: 'content', data: content })}\n`);
                }
              } catch {}
            }
          }
          controller.close();
        } catch (error) {
          controller.enqueue(`data: ${JSON.stringify({ type: 'error', data: String(error) })}\n`);
          controller.close();
        }
      },
    });
  }

  async readSessionTitle(): Promise<string | null> {
    return null;
  }

  async writeSessionTitle(): Promise<void> {}
}
```

## 常见问题

### Q: 如何处理权限检查？
A: 参考 `src/providers/claude/permission-gateway.ts`，实现权限检查逻辑。

### Q: 如何处理工具调用？
A: 在流式响应中发送 `{"type": "tool_use", "data": {...}}`，参考 CodexProvider 的实现。

### Q: 如何处理会话标题？
A: 实现 `readSessionTitle` 和 `writeSessionTitle` 方法，可以存储在本地文件或数据库中。

### Q: 如何处理错误？
A: 在流式响应中发送 `{"type": "error", "data": "错误信息"}`。

## 参考实现

- **MiMo Provider**: `src/providers/mimo/mimo-provider.ts` - 简单的 OpenAI 兼容 API
- **Claude Provider**: `src/providers/claude/sdk-provider.ts` - 完整的权限和工具调用支持
- **Codex Provider**: `src/providers/codex/codex-provider.ts` - 进程管理和线程管理

## 测试

1. 启动服务：`systemctl start feishu-your-new-agent`
2. 在飞书中发送 `/new:your-new-agent`
3. 发送测试消息，验证流式响应
4. 检查 divider 是否显示正确的 Model 和 Provider
