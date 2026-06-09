# 交接文档：飞书流式卡片问题（V3）

## 日期
2026-06-09

## 环境
- **运行机器**：debian13（本机）
- **服务**：`feishu-claude.service`（active，PID 809437）
- **代码**：`/opt/agents-to-im/`，分支 `my-changes`
- **最近提交**：`a67b4d4` + 未提交修改

## 当前未提交的修改（4个文件）

```
src/bridge/bridge-manager.ts           | +5   (添加 debug 日志)
src/feishu/cards/streaming-cards.ts    | -7   (删除 summary 字段)
src/feishu/services/preview-service.ts | +8/-1 (endPreview 添加 summary 更新)
dist/daemon.mjs                        | 已编译但未提交
```

### 修改 1：streaming-cards.ts — 删除 summary 字段
删除了卡片骨架中的 `config.summary`，让飞书不显示固定摘要文本。

### 修改 2：preview-service.ts — endPreview 添加 summary 更新
`endPreview` 中同时发送 `streaming_mode: false` 和 `summary` 更新为"✅ 回答完成"。

### 修改 3：bridge-manager.ts — replace_preview 路径
最终交付时用 `sendPreview` 更新原卡片（不发新消息），已改为：
```typescript
const previewResult = await adapter.sendPreview?.(msg.address, finalResponseText, previewState.draftId);
adapter.endPreview?.(msg.address, previewState.draftId);
```
添加了 `[replace_preview]` debug 日志。

---

## 未解决的问题

### 问题 1：仍然出现 2 张卡片
**现象**：用户发一条消息后出现 2 张卡片
- 卡片1：streaming card（思考内容）
- 卡片2：回答内容

**已尝试的修复**：
- replace_preview 路径改为 sendPreview 写原卡片（不再 deliverResponse 发新消息）
- 但日志中未看到 `[replace_preview]` 输出，说明该代码路径**可能未被执行**

**可能原因**：
1. `previewFinalDelivery` 可能不是 `'replace_preview'`（虽然 adapter 配置了这个值）
2. `previewState` 在到达该代码路径时为 null
3. 可能走了其他 else 分支（如 `remainingSegments.length > 1` 或 `streamedSegmentDelivery` 路径）
4. 需要查看 `[preview-setup]` 和 `[replace_preview-debug]` 日志确认

**排查方向**：
- 检查 `journalctl -u feishu-claude` 中 `[preview-setup]` 日志，确认 `finalDelivery` 值
- 检查 `[replace_preview-debug]` 日志是否输出
- 如果该路径未执行，说明问题在更上游（previewState 创建或 finalDelivery 值）

### 问题 2：状态未自动更新
**现象**：在飞书聊天列表中，卡片仍显示"努力回答中"或"生成中…"
**已尝试的修复**：
- 删除了 summary 字段 → 改为"生成中…"（部分生效但未彻底解决）
- endPreview 添加 summary 更新为"✅ 回答完成" → 未验证是否生效

**可能原因**：
- `endPreview` 可能未被调用（与问题 1 关联）
- 飞书 CardKit `card.settings` API 可能不支持更新 summary
- 需要确认 `endPreview` 是否真的执行了

### 问题 3：/stop 无法中断思考过程
**现象**：Claude 正在思考时，用户发送 /stop 无法中断
**可能原因**：agents-to-im 的中断机制问题，与流式卡片无关

### 问题 4：Claude 陷入无限循环（已自我修复）
**现象**：Claude 在调试过程中反复执行相同的 bash 命令，浪费大量 token
**原因**：上下文压缩后丢失了之前的执行结果，导致反复重试
**建议**：这是 Claude Code 的使用问题，不是 agents-to-im 的 bug

### 问题 5：思考过程过长
**现象**：Claude 的 thinking/reasoning 内容超级长
**原因**：与问题 4 关联，反复执行命令导致思考膨胀

---

## 关键代码路径（供 OpenClaw 排查）

### 卡片创建
```
primePreview (bridge-manager.ts:587)
  → adapter.primePreview (adapter.ts:556)
    → previewService.primePreview (preview-service.ts:83)
      → createPreviewArtifact (preview-service.ts:123)
        → cardkit.v1.card.create → cardkit.v1.card.sendCardByCardId
```

### 卡片更新
```
onPartialText (bridge-manager.ts:1797)
  → flushPreview (bridge-manager.ts:540)
    → adapter.sendPreview (adapter.ts:550)
      → previewService.sendPreview (preview-service.ts:31)
        → cardkit.v1.cardElement.content (更新 stream_content 元素)
```

### 最终交付（replace_preview 路径）
```
handleMessage 尾部 (bridge-manager.ts:2117)
  if (previewState && previewFinalDelivery === 'replace_preview')
    → adapter.sendPreview (更新原卡片最终文本)
    → adapter.endPreview (关闭 streaming_mode + 更新 summary)
```

### endPreview
```
previewService.endPreview (preview-service.ts:97)
  → cardkit.v1.card.settings (streaming_mode: false + summary)
```

## 需要 OpenClaw 做的

1. **排查为什么 2 张卡片**：检查日志确认 replace_preview 路径是否执行，如果不执行是为什么
2. **排查 summary 更新**：确认 endPreview 是否被调用，card.settings 是否支持更新 summary
3. **排查 /stop 中断**：agents-to-im 的中断机制是否正常
4. **考虑整体架构**：如果 replace_preview 路径有问题，可能需要重新设计最终交付逻辑

## 日志调试
```bash
# 查看关键日志
journalctl -u feishu-claude -f | grep -E "preview-setup|replace_preview|preview-service|endPreview"
```
