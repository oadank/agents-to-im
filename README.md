# agents-to-im (Forked & Modified)

> AI coding agents are trapped in your terminal. Your team collaborates in Feishu. This bridges them — one group per session, local state, streamed cards.

**Forked from:** [francize/agents-to-im](https://github.com/francize/agents-to-im)

**This fork:** Optimized for multi-instance deployment (Claude + Codex simultaneously) with production-ready configuration.

---

## 🎯 Purpose & Goals

This fork customizes `agents-to-im` for **personal AI coding workflow** with the following goals:

1. **Dual Runtime Support**: Run Claude and Codex instances simultaneously, each with independent configuration
2. **Production Deployment**: Deploy as systemd user services for automatic startup and monitoring
3. **Isolated Workspaces**: Each AI instance maintains its own working directory and session state
4. **Zero Configuration Sharing**: Claude and Codex never share state, preventing cross-contamination

---

## 🔧 Modifications Made

### 1. Command Processing Logic (daemon.mjs)

**Problem:** Original code treated any text starting with `/` as a potential command, which caused conflicts when sharing workspace paths like `/opt/xxx`.

**Solution:** Implemented strict command whitelist:
```javascript
// Only recognized commands trigger handler, everything else is plain text
const knownCommands = ["/new", "/new:claude", "/new:codex", "/reset", "/stop", "/start", "/help", "/status", "/cwd", "/mode", "/bind", "/sessions"];
```

**Impact:**
- Paths like `/opt/.openclaw/workspace` are correctly treated as workspace references, not commands
- Cleaner message routing, no false command parsing
- Better compatibility with common Linux path patterns

### 2. New Session Creation (`/new`, `/new:claude`, `/new:codex`)

**Problem:** Original session creation logic had complex command parsing that could fail on edge cases.

**Solution:** Streamlined session creation flow:
- `/new` → Creates session using default runtime
- `/new:claude` → Explicitly creates Claude session
- `/new:codex` → Explicitly creates Codex session

Each command properly initializes the session, sets working directory, and binds to the Feishu group.

### 3. Multi-Instance Configuration

Added support for running multiple independent instances:
- `instances/feishu-claude/` - Claude instance configuration
- `instances/feishu-codex/` - Codex instance configuration
- `systemd/` - Service files for systemd deployment

---

## 📦 Repository Structure

```
agents-to-im/
├── src/                      # Original source code
├── dist/
│   └── daemon.mjs           # ⚠️ MODIFIED - Command processing logic
├── instances/
│   ├── feishu-claude/
│   │   └── config.env        # Claude instance config template
│   └── feishu-codex/
│       └── config.env        # Codex instance config template
├── systemd/
│   ├── feishu-claude.service
│   └── feishu-codex.service
├── package.json
├── config.env.example
└── README.md
```

---

## 🚀 Deployment Guide

### Prerequisites

1. Install the original package:
```bash
npm install -g agents-to-im
```

2. Create Feishu apps for Claude and Codex respectively
   - Enable Bot capability
   - Configure message permissions
   - Set up event subscriptions

### Installation

1. Clone this repository:
```bash
git clone https://github.com/oadank/agents-to-im.git
cd agents-to-im
```

2. Install Claude instance:
```bash
mkdir -p ~/.agents-to-im-claude
cp instances/feishu-claude/config.env.example ~/.agents-to-im-claude/config.env
$EDITOR ~/.agents-to-im-claude/config.env  # Fill in APP_ID and APP_SECRET

cp systemd/feishu-claude.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now feishu-claude.service
```

3. Install Codex instance (same steps):
```bash
mkdir -p ~/.agents-to-im-codex
cp instances/feishu-codex/config.env.example ~/.agents-to-im-codex/config.env
# ... configure APP_ID and APP_SECRET ...

cp systemd/feishu-codex.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now feishu-codex.service
```

### Verify Status

```bash
systemctl --user status feishu-claude.service
systemctl --user status feishu-codex.service
```

---

## 📋 Configuration Variables

### Required (must be filled in)

| Variable | Description |
|----------|-------------|
| `CTI_FEISHU_APP_ID` | Feishu app ID from your custom app |
| `CTI_FEISHU_APP_SECRET` | Feishu app secret |
| `CTI_DEFAULT_RUNTIME` | `claude` or `codex` |
| `CTI_DASHBOARD_PORT` | Dashboard port (unique per instance) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `CTI_FEISHU_SHOW_TOOL_CALL_CARDS` | `true` | Show tool call cards in Feishu |
| `CTI_DISABLE_PERMISSION_CHECK` | `false` | Disable permission checks |
| `CTI_DEFAULT_WORKDIR` | `~` | Default working directory |
| `CTI_LOG_LEVEL` | `info` | Log level |

---

## 🔄 Upstream Sync

This fork tracks the upstream repository [francize/agents-to-im](https://github.com/francize/agents-to-im).

To sync with upstream:
```bash
git remote add upstream https://github.com/francize/agents-to-im.git
git fetch upstream
git merge upstream/main
# Resolve any conflicts, then push
```

---

## 📄 License

MIT License - Same as upstream

---

## 🙏 Acknowledgments

- Original project: [francize/agents-to-im](https://github.com/francize/agents-to-im)
- Claude Code: [Anthropic](https://www.anthropic.com)
- Codex: [OpenAI](https://openai.com)
