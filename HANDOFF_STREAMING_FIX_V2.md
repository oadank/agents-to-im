# 交接文档：飞书流式卡片问题（V2）

## 日期
2026-06-09

## 环境
- **运行机器**：debian13（本机，R7-7840HS）
- **服务**：`feishu-claude.service`（active，PID 771857，内存 569MB）
- **代码**：`/opt/agents-to-im/`，分支 `my-changes`
- **最近提交**：`38a775b` "fix: 修复飞书流式卡片多卡片问题 + 中文思考指令"

## 现状（比之前好，但仍有问题）

| 维度 | 之前 | 现在 |
|------|------|------|
| 卡片数量 | 几十张 | **2 张** |
| 内容显示 | — | 覆盖式，**最后才一起出来** |

## 问题 1：出现 2 张卡片

### 根因

`finalDelivery: 'replace_preview'` 的实际行为不是"替换"，而是"新建 + 关闭旧的"。

流程如下：
1. `primePreview` → 创建**流式卡片 #1**（CardKit，streaming_mode）
2. `sendPreview` → 更新卡片 #1（thinking + answer）
3. LLM 响应完成后 → `deliverResponse` → 发送**新消息卡片 #2**（line 2118）
4. `endPreview` → 关闭卡片 #1 的 streaming_mode

关键代码（`bridge-manager.ts:2115-2128`）：
```typescript
if (previewState && previewFinalDelivery === 'replace_preview') {
  const finalResponseText = result.responseText || remainingSegments.join('\n\n').trim();
  if (finalResponseText) {
    responseDelivery = await deliverResponse(   // ← 发送新消息！
      adapter, msg.address, finalResponseText,
      binding.codepilotSessionId, msg.messageId,
    );
    if (responseDelivery.ok) {
      adapter.endPreview?.(msg.address, previewState.draftId);  // ← 然后关闭旧卡片
      previewClosed = true;
    }
  }
}
```

`deliverResponse` → `deliver` → `adapter.sendMessage`，创建了**新消息**。然后才 `endPreview` 关闭流式卡片。用户看到 2 张卡片。

### 期望

`replace_preview` 模式应该：在已有流式卡片上更新最终文本，然后关闭 streaming_mode。不创建新消息。

## 问题 2：内容不是逐步显示，最后才一起出来

### 根因

内容显示依赖两个路径：
1. **onPartialText** → `flushPreview` → `sendPreview`（answer 部分）
2. **handleActivityEvent** → `reasoning_activity` → `sendPreview`（thinking 部分）

但实际行为是内容被覆盖而非累计：
- CardKit `cardElement.content` 是**替换**语义，不是追加
- 每次调用发送的是完整的 `combined = thinkingBlock + answer`
- 如果 LLM 响应速度快（非逐 token 流式），`onPartialText` 只触发一两次，用户看到的是"空白 → 直接出完整内容"

### 相关配置

```typescript
// bridge-manager.ts:132
const STREAM_DEFAULTS = {
  feishu: { intervalMs: 160, minDeltaChars: 18, maxChars: 99999, primeDelayMs: 900 },
};
```

- `primeDelayMs: 900` — 消息到达后等 900ms 才创建卡片
- `minDeltaChars: 18` — 新内容 < 18 字符不发送
- `intervalMs: 160` — 节流间隔 160ms

这些参数可能过于保守，导致更新频率不够。

## 已做的修复（commit 38a775b）

| 修复 | 位置 | 效果 |
|------|------|------|
| flushPreview 不重置 placeholderPrimed | bridge-manager.ts:549 | 防止重复创建 |
| reasoning_activity 永远 return | bridge-manager.ts:1744 | 不创建活动卡片 |
| endPreview 关闭 streaming_mode | preview-service.ts:82-96 | 正确关闭卡片 |
| activePreviewByAddress 追踪 | bridge-manager.ts:1342 | 新消息关闭旧卡片 |
| 卡片骨架初始内容为空 | streaming-cards.ts | 避免空白闪烁 |

## 需要 OpenClaw 修复的

### Fix 1：replace_preview 应该在原卡片上更新，不发新消息

`bridge-manager.ts:2115-2128` 应该改为：
- 用 `sendPreview` 把最终文本写入已有流式卡片
- 然后 `endPreview` 关闭 streaming_mode
- 不调用 `deliverResponse`（不发新消息）

### Fix 2：逐步显示优化（可选）

- 降低 `primeDelayMs`（900ms → 300ms）
- 降低 `minDeltaChars`（18 → 8）
- 确保 `onPartialText` 和 `reasoning_activity` 的更新能及时推送到卡片

## 关键文件

| 文件 | 作用 |
|------|------|
| `src/bridge/bridge-manager.ts` | 流式状态管理、onPartialText、handleActivityEvent、最终交付 |
| `src/feishu/services/preview-service.ts` | CardKit 卡片创建/更新/关闭 |
| `src/feishu/cards/streaming-cards.ts` | 卡片骨架 |
| `src/feishu/adapter.ts` | getPreviewCapabilities (line 538) |
| `src/bridge/types.ts` | StreamingPreviewState 类型 |
| `src/feishu/types.ts` | PreviewArtifact 类型 |

## 日志调试

服务日志查看：
```bash
journalctl -u feishu-claude -f
# 或
journalctl -u feishu-claude --since "10 min ago" | grep -E "preview|card|createPreview"
```

当前日志中已有关键 log：
- `[preview-service] sendPreview: key=..., exists=..., total=...`
- `[preview-service] createPreviewArtifact: chatId=..., draftId=..., existingArtifacts=...`
- `[preview-service] finalizePreview: draftId=..., found=..., activeRoute=..., total=...`
