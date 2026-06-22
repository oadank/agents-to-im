# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Dynamic divider display for Model/Provider in adapter (`adapter.ts`).
- BRIDGE_PROTOCOL.md documentation for bridge protocol reference.
- README multi-runtime support section and divider feature docs.

### Fixed
- `/new` and `/new:mimo` commands auto-create mimocode session in p2p chat.
- Feishu-mimo `/new` command binds to p2p chat with mimocode model.

### Changed
- zcode-provider supports `mcpServers.json` configuration.
- Refactor: remove unused imports and functions in adapter.ts.
- Remove stale `.bak` backup files.
- Updated README with multi-runtime support and divider feature.

## [0.0.6] - 2026-05-11

### Security
- **BREAKING:** Empty `CTI_FEISHU_ALLOWED_USERS` now rejects every inbound sender. Previously an empty allowlist allowed everyone, which let any user able to DM the bot (or share a group with it) drive Claude/Codex on the host machine. Existing 0.0.5 installs that relied on the implicit allow-all behavior must either set the variable to specific `open_id` values, or explicitly set it to the single wildcard `*` (only honored when it is the sole entry).
- Enforce the allowlist on Feishu card button callbacks as well, not just inbound text/image messages. Earlier versions only gated the message entry, so a non-allowlisted group member could still click "approve" on permission cards or drive structured-input flows — equivalent to an auth bypass on the card channel.
- Stop loading `~/.agents-to-im/config.env` via `set -a; source config.env` in `scripts/daemon.sh`. A tampered config containing `EVIL=$(rm -rf ~)` or backtick payloads would otherwise execute as shell at daemon startup. The new loader reads the file through Node's `--env-file=` strict `KEY=VALUE` parser, then `scripts/dump-env.mjs` re-emits POSIX-escaped `export` lines for `eval`, so values are never interpreted as shell.

### Changed
- **BREAKING:** Raise `engines.node` to `>=20.6.0`. The new `config.env` loader relies on `node --env-file=`, which is only stable from Node 20.6.
- Default the onboarding wizard to "restrict to specific users" and surface explicit warnings when the operator chooses allow-all (`*`), including the concrete capabilities a third party would gain.
- Bundle `scripts/dump-env.mjs` in the published package `files` list so the bash daemon can locate the safe env loader on fresh installs.
- Expand `SECURITY.md` and `config.env.example` to document the allowlist semantics, the wildcard caveat, and the new "config.env is never executed as a shell script" guarantee.
- Extend regression coverage for the bash daemon env loader, the Feishu adapter authorization checks, the card-action authorization gate, and package metadata.

### References
- Issue: #13

### Self-help prompt for upgraders
If your 0.0.5 deployment stops responding after upgrading, send the following to Claude Code / Codex to diagnose:

```
请帮我排查 agents-to-im 升级到 0.0.6 后 bot 不再响应的问题。
1. 读取 ~/.agents-to-im/config.env，检查 CTI_FEISHU_ALLOWED_USERS 是否已设置（必须是具体 open_id 或单独的 *）
2. 读取 ~/.agents-to-im/logs/bridge.log 最近 100 行，搜索 "Dropped" / "unauthorized" 字样
3. 运行 bash ~/.claude/skills/agents-to-im/scripts/doctor.sh 并分析输出
4. 根据日志和配置给出具体的修复建议
```

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
- Clarify in docs that the toggle covers MCP/tool, command execution, and file-change activity cards.

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
