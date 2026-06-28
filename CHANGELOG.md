# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### 新增
- 适配器动态分割线显示 Model/Provider（`adapter.ts`）。
- 新增 BRIDGE_PROTOCOL.md 桥接协议文档。
- README 增加 multi-runtime 支持章节与分割线特性说明。
- **统一多 bot 架构**：claude/mimo/gemini 三合一统一服务，配置集中化（`eadd9ad`）。
- **动态模型切换**：runtime 配置实时生效，无需重启（`eeb99da`）。
- **动态 agent 显示**：agent 名称、模型、Provider 实时从配置读取（`eeb99da`）。
- **Gemini/MiMo 实时配置**：模型与 Provider 从 `config.env` 读取，显示名动态生成（`b12b61e`）。
- **MCP 配置集中化**：`mcpServers.json` 统一管理，各 runtime 共享（`eadd9ad`）。
- **记忆隔离**：各 bot 独立记忆目录，互不干扰（`eadd9ad`）。
- **Gemini 适配 LiteLLM**：新增 `GeminiProvider`（OpenAI 兼容格式），通过 LiteLLM 路由到 OpenCode Go（mimo-v2.5 主力 / deepseek-v4-flash 备选）。
- 启动顺序调整：agents-to-im 在 LiteLLM 之后启动，避免依赖竞态（`b12b61e`）。

### 修复
- `/new` 与 `/new:mimo` 命令在 p2p 聊天中自动创建 mimocode 会话。
- Feishu-mimo `/new` 命令绑定到 p2p 聊天并使用 mimocode 模型。
- **AskUserQuestion 飞书卡片不渲染**：`finalDelivery` 改为 `replace_preview`（`20dc496`）。
- **Dashboard 显示问题**：gateway `bind=lan` + `.env` 改 tailnet IP（`b12b61e`）。
- **飞书复制失效 + 卡在"生成中"状态**：流式卡片状态机修复（`38ff6e7`）。
- **esbuild ESM 兼容**：为 Lark SDK 添加 `__dirname` polyfill 到 banner（`50832a6`）。
- **MiMo-Anthropic 模型 thinking block 提取**：增加 fallback 路径（`compact.ts`）。

### 变更
- zcode-provider 支持 `mcpServers.json` 配置。
- 重构 adapter.ts：移除未使用的 import 和函数。
- 清理陈旧的 `.bak` 备份文件。
- README 更新 multi-runtime 支持与分割线特性说明。
- **Gemini runtime 从 `GeminiCliProvider` 切换为 `GeminiProvider`**（OpenAI 格式 → LiteLLM）。
- 移除已失效的 `mimo-gemini-proxy` 直连配置，统一走 LiteLLM 路由。
- dist 编译产物同步更新。

## [0.0.5] - 2026-04-23

### Fixed
- Surface recently used Claude Code and Codex projects in the `/new:claude` and `/new:codex` workspace dropdowns by scanning `~/.claude/projects/*/*.jsonl` and `~/.codex/sessions/**/*.jsonl` (plus `archived_sessions/`).
- Recover the authoritative `cwd` from jsonl records instead of trying to reverse the lossy `~/.claude/projects/<dir>` name, which otherwise drops paths containing `-`, `.`, or non-ASCII characters.
- Aggregate native sessions by normalized `cwd` with the newest jsonl mtime as `updatedAt`, then merge with existing channel bindings in `listRecentWorkspaces`.

### Changed
- Raise the workspace dropdown limit from 5 to 10 so recovered native projects have room to show.
- Extend `listRecentWorkspaces` to accept an `extraSources` argument and dedupe while keeping the newer timestamp per path.
- Extend regression coverage for Claude native workspace parsing (non-ASCII cwds, missing-cwd files) and Codex native workspace parsing across `sessions/` and `archived_sessions/`.

### References
- Issue: #11

## [0.0.4] - 2026-04-14

### Fixed
- Add `CTI_FEISHU_SHOW_TOOL_CALL_CARDS` so Feishu/Lark sessions can hide noisy tool-call cards while keeping normal assistant cards.
- Apply the tool-card toggle consistently to Claude tool activity, Codex command-execution, and file-change cards.
- Make `onboard` step skips advance directly to the next step instead of asking follow-up prompts and extra Enter confirmations.

### Changed
- Guide the tool-card toggle during `agents-to-im onboard` and persist the chosen value into `config.env`.
- Clarify in config/docs that the toggle covers MCP/tool, command execution, and file-change cards.
- Trim the example config by removing the platform-specific Claude CLI path sample line.
- Extend regression coverage for config parsing, onboarding flow, Feishu activity-card projection, and bridge-side suppression handling.

## [0.0.4-beta.1] - 2026-04-14

### Fixed
- Apply `CTI_FEISHU_SHOW_TOOL_CALL_CARDS=false` to Codex command-execution and file-change cards as well, not just generic MCP/tool activity cards.

### Changed
- Clarify in docs that the tool-card toggle covers MCP/tool, command execution, and file-change activity cards.
- Extend regression coverage for suppressed Codex command activity projections.

## [0.0.4-beta.0] - 2026-04-14

### Fixed
- Add `CTI_FEISHU_SHOW_TOOL_CALL_CARDS` so Feishu/Lark sessions can hide tool-call activity cards while keeping normal assistant cards.
- Default tool-call activity cards to off to reduce group-session noise.
- Make `onboard` step skips advance directly to the next step instead of asking follow-up prompts and extra Enter confirmations.

### Changed
- Guide the tool-card toggle during `agents-to-im onboard` and persist the chosen value into `config.env`.
- Extend regression coverage for config parsing, onboarding flow, Feishu activity-card projection, and bridge-side suppression handling.

### References
- Issue: #7

## [0.0.3] - 2026-04-14

### Fixed
- Ignore stale `CTI_CLAUDE_CODE_EXECUTABLE` values that do not match the current host platform.
- Fall back to local Claude CLI discovery when an explicit Claude CLI override is cross-platform and unusable.
- Stop `onboard` from pre-filling Windows Claude paths on macOS/Linux hosts, or POSIX paths on Windows hosts.

### Changed
- Extend regression coverage for cross-platform Claude CLI override normalization and fallback discovery.

### References
- Issue: #5

## [0.0.2] - 2026-04-14

### Fixed
- Accept `CTI_CLAUDE_CODE_EXECUTABLE` as an explicit Claude CLI override for local daemon startup.
- Resolve Windows npm-installed `claude.cmd` shims to the real Claude Code `cli.js` entrypoint.
- Run JS-based Claude CLI entrypoints through Node during preflight instead of treating them as native binaries.
- Rebuild release artifacts so `dist/daemon.mjs`, `dist/cli.js`, `dist/cli-bin.mjs`, and `dist/cli.mjs` match current source behavior.

### Changed
- Document the Windows/npm Claude CLI path workaround and the need to restart the bridge after installing or updating Claude Code.
- Extend regression coverage for config persistence, CLI preflight, Windows path discovery, provider wiring, and CLI wrapper compatibility.

### References
- Issue: #3
