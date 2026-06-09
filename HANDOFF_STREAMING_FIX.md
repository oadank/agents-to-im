# 飞书流式卡片问题交接文档

## 项目信息
- 项目：agents-to-im（飞书桥梁框架）
- 源码：`/opt/agents-to-im/`
- 服务：`feishu-claude.service`（systemd 管理）
- 编译：`cd /opt/agents-to-im && npm run build`
- 重启：`sudo systemctl restart feishu-claude.service`

## 要解决的问题

飞书群聊中，AI 回复时创建了**多张卡片**，而不是一张。用户看到"几十条"卡片刷屏。

### 期望行为（参考 OpenClaw）
- 一张卡片，thinking + answer 在同一张卡片中流式显示
- 不创建新卡片，不删除旧卡片
- 回复结束后卡片保留，显示最终内容

### 实际行为
- 每个 thinking 事件或文本段可能创建新卡片
- 旧卡片未被正确关闭（streaming_mode 仍为 true）
- 用户看到大量卡片刷屏

## 相关文件

| 文件 | 作用 |
|------|------|
| `src/feishu/services/preview-service.ts` | 流式卡片生命周期：创建、更新、关闭 |
| `src/bridge/bridge-manager.ts` | 桥接逻辑：事件处理、preview 状态管理 |
| `src/feishu/cards/streaming-cards.ts` | 卡片骨架定义 |
| `src/feishu/adapter.ts` | 飞书适配器：send、finalize 等 |
| `src/bridge/types.ts` | 类型定义：StreamingPreviewState 等 |
| `src/feishu/types.ts` | 类型定义：PreviewArtifact 等 |
| `src/bridge/channel-adapter.ts` | 适配器接口定义 |

## 核心流程

```
用户消息 → handleMessage() → 创建 previewState (draftId)
  → SDK 流式响应开始
    → reasoning_activity 事件 → handleActivityEvent() → 更新卡片
    → text_delta 事件 → onPartialText() → flushPreview() → 更新卡片
  → 响应结束
    → deliverResponse() → adapter.send() → finalizePreview() → 关闭卡片
```

## 关键代码位置

### 1. 卡片创建
- `preview-service.ts` → `createPreviewArtifact()`：用 CardKit API 创建卡片
- `bridge-manager.ts` → `primePreview()`：首次需要卡片时调用
- `bridge-manager.ts` → `flushPreview()`：文本更新时调用 `adapter.sendPreview`

### 2. 卡片更新
- `preview-service.ts` → `sendPreview()`：用 `cardElement.content()` 更新 `stream_content` 元素
- `bridge-manager.ts` → `handleActivityEvent()`：reasoning_activity 构建合并文本发送

### 3. 卡片关闭
- `preview-service.ts` → `finalizePreview()`：PATCH `streaming_mode: false`
- `preview-service.ts` → `endPreview()`：清理内部状态

### 4. 问题代码
- `bridge-manager.ts` → `onPartialText()` 第 1788 行：检查 `!ps.placeholderPrimed` 触发 `primePreview`
- `bridge-manager.ts` → `flushPreview()` 第 551 行：`state.placeholderPrimed = false` 重置标志
- `preview-service.ts` → `sendPreview()` 第 40-50 行：检查 `previewArtifacts.has(key)` 决定创建或更新

## 已知问题

1. **多卡片根因未找到**：尽管加了 `previewArtifacts.has(key)` 守卫，仍然创建多张卡片。可能原因：
   - `placeholderPrimed` 在 `flushPreview` 中被重置为 false
   - 下一次 `onPartialText` 又触发 `primePreview`
   - 或者有其他代码路径在创建新卡片

2. **旧卡片未关闭**：当新消息到达时，旧消息的 `previewState` 被覆盖，旧卡片的 streaming_mode 未被关闭

3. **调试日志不显示**：`console.log` 在 preview-service.ts 中添加了，但 journalctl 中看不到输出

## 参考实现

OpenClaw 的飞书流式实现在：
`/opt/.openclaw/npm/projects/openclaw-feishu-dc69f44688/node_modules/@openclaw/feishu/dist/monitor.account-BvKcwxaW.js`

关键特点：
1. **单元素卡片**：只有一个 `content` 元素
2. **增量追加**：用 `/elements/content/content` 端点追加文本，不替换
3. **关闭不删卡**：只 PATCH `streaming_mode: false`
4. **智能节流**：160ms 节流 + 自然断句检测

## 编译和测试

```bash
# 编译
cd /opt/agents-to-im && npm run build

# 重启
sudo systemctl restart feishu-claude.service

# 查看日志
journalctl -u feishu-claude.service -f

# 检查服务状态
sudo systemctl status feishu-claude.service
```

## 注意事项

- 编译产物在 `dist/daemon.mjs`
- 服务用 `Type=simple`，stdout 应该进入 journalctl
- TypeScript 编译有 zcode-provider 的预存错误，可忽略
- 测试时发一条消息，观察创建了几张卡片
