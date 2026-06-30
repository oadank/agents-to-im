#!/bin/bash
#
# agents-to-im 安装脚本
# 支持分进程部署（单 bot 模式）和统一进程部署（多 bot 模式）
#
# 用法:
#   bash scripts/setup.sh --help
#   bash scripts/setup.sh --mode multi --bots claude,codex,mimo,gemini
#   bash scripts/setup.sh --mode single --bots claude,mimo
#

set -euo pipefail

# ── 默认配置 ──
CTI_HOME="${CTI_HOME:-/opt/.agents-to-im}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="multi"              # single 或 multi
BOTS="claude,mimo,gemini,codex"
SKIP_SYSTEMD=false
SKIP_BUILD=false

# dashboard 端口起始值（分进程模式每个 bot 不同）
DASHBOARD_BASE_PORT=13580

# ── 颜色输出 ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[info]${NC} $*"; }
ok()    { echo -e "${GREEN}[ok]${NC} $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC} $*"; }
error() { echo -e "${RED}[error]${NC} $*" >&2; }

# ── 帮助 ──
show_help() {
  cat << 'EOF'
agents-to-im 安装脚本

用法:
  bash scripts/setup.sh [选项]

选项:
  --cti-home PATH      数据目录 (默认: /opt/.agents-to-im)
  --mode single|multi  部署模式:
                       single = 统一进程 (agents-to-im.service)
                       multi  = 分进程 (claude.service, codex.service, ...)
                       (默认: multi)
  --bots LIST          要部署的 bot，逗号分隔
                       (默认: claude,mimo,gemini,codex)
  --skip-build         跳过 npm install + build
  --skip-systemd       跳过 systemd 服务创建
  --help               显示帮助

示例:
  # 分进程部署全部 bot
  bash scripts/setup.sh --mode multi

  # 统一进程部署 claude + mimo
  bash scripts/setup.sh --mode single --bots claude,mimo

  # 指定数据目录
  bash scripts/setup.sh --cti-home /home/user/.agents-to-im

EOF
}

# ── 参数解析 ──
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cti-home)
        CTI_HOME="$2"; shift 2 ;;
      --mode)
        MODE="$2"; shift 2 ;;
      --bots)
        BOTS="$2"; shift 2 ;;
      --skip-build)
        SKIP_BUILD=true; shift ;;
      --skip-systemd)
        SKIP_SYSTEMD=true; shift ;;
      --help|-h)
        show_help; exit 0 ;;
      *)
        error "未知参数: $1"; show_help; exit 1 ;;
    esac
  done
}

# ── 前置检查 ──
check_deps() {
  info "检查依赖..."

  if ! command -v node > /dev/null 2>&1; then
    error "未找到 node.js，请先安装 Node.js (v20+)"
    exit 1
  fi

  NODE_VER=$(node --version | sed 's/v//')
  MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  if [[ "$MAJOR" -lt 20 ]]; then
    error "Node.js 版本过低: $NODE_VER，需要 >= 20"
    exit 1
  fi
  ok "Node.js $NODE_VER"

  if ! command -v npm > /dev/null 2>&1; then
    error "未找到 npm"
    exit 1
  fi
  ok "npm $(npm --version)"

  if ! command -v systemctl > /dev/null 2>&1; then
    warn "未找到 systemctl，跳过 systemd 服务创建"
    SKIP_SYSTEMD=true
  fi
}

# ── 编译 ──
build_project() {
  if [[ "$SKIP_BUILD" == true ]]; then
    warn "跳过编译 (--skip-build)"
    return
  fi

  info "安装依赖..."
  cd "$SOURCE_DIR"
  npm install

  info "编译..."
  npm run build
  ok "编译完成: dist/daemon.mjs"
}

# ── 创建目录结构 ──
setup_directories() {
  info "创建数据目录: $CTI_HOME"

  mkdir -p "$CTI_HOME"/{data,logs,runtime}
  mkdir -p "$CTI_HOME/data/messages"

  # 分进程模式：为每个 bot 创建子目录
  if [[ "$MODE" == "multi" ]]; then
    IFS=',' read -ra BOT_LIST <<< "$BOTS"
    for bot in "${BOT_LIST[@]}"; do
      bot=$(echo "$bot" | xargs)  # trim
      mkdir -p "$CTI_HOME/data/$bot/messages"
    done
  fi

  ok "目录结构创建完成"
}

# ── 生成 config.env 模板 ──
generate_config_env() {
  local config_path="$CTI_HOME/config.env"

  if [[ -f "$config_path" ]]; then
    warn "config.env 已存在，跳过生成"
    warn "如需重新生成，请手动删除 $config_path"
    return
  fi

  info "生成 config.env 模板..."

  cat > "$config_path" << EOF
# ═══════════════════════════════════════════════════════════════
# agents-to-im 配置文件
# 请先填写所有 <TODO> 项，然后启动服务
# ═══════════════════════════════════════════════════════════════

# ── 全局设置 ──
CTI_DEFAULT_WORKDIR=/opt
CTI_FEISHU_ALLOWED_USERS=*
CTI_DISABLE_PERMISSION_CHECK=false

# ── Bot 注册 ──
# 统一进程模式: CTI_BOTS=claude,mimo,gemini,codex
# 分进程模式: 每个 systemd 服务设置 CTI_BOT=xxx，不需要 CTI_BOTS
CTI_BOTS=$BOTS

EOF

  IFS=',' read -ra BOT_LIST <<< "$BOTS"
  for bot in "${BOT_LIST[@]}"; do
    bot=$(echo "$bot" | xargs)
    local upper=$(echo "$bot" | tr '[:lower:]' '[:upper:]')

    cat >> "$config_path" << EOF
# ── Bot: $bot ──
CTI_BOT_${upper}_APP_ID=cli_<TODO: 飞书应用 app_id>
CTI_BOT_${upper}_APP_SECRET=<TODO: 飞书应用 app_secret>
CTI_BOT_${upper}_RUNTIME=$bot
CTI_BOT_${upper}_AGENT_NAME=feishu-$bot
CTI_BOT_${upper}_MODEL_GROUP=${bot}-model
CTI_BOT_${upper}_MODEL_PROVIDER=LiteLLM
CTI_BOT_${upper}_SHOW_TOOL_CALL_CARDS=false
CTI_BOT_${upper}_SHOW_AGENT_DIVIDER=true

EOF
  done

  chmod 600 "$config_path"
  ok "config.env 模板已生成: $config_path"
  warn "⚠️  请先编辑 $config_path，填写所有 <TODO> 项（app_id 和 app_secret）"
}

# ── 生成 systemd 服务文件 ──
generate_systemd_services() {
  if [[ "$SKIP_SYSTEMD" == true ]]; then
    warn "跳过 systemd 服务创建 (--skip-systemd)"
    return
  fi

  info "创建 systemd 服务..."

  local systemd_dir="/etc/systemd/system"

  if [[ "$MODE" == "single" ]]; then
    # 统一进程模式
    cat > "$systemd_dir/agents-to-im.service" << EOF
[Unit]
Description=Unified agents-to-im Bridge ($BOTS)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$SOURCE_DIR
Environment=CTI_HOME=$CTI_HOME
EnvironmentFile=$CTI_HOME/config.env
ExecStart=/usr/bin/node $SOURCE_DIR/dist/daemon.mjs
Restart=always
RestartSec=5
RestartSteps=10
RestartMaxDelaySec=30

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable agents-to-im.service
    ok "统一进程服务已创建: agents-to-im.service"

  else
    # 分进程模式
    IFS=',' read -ra BOT_LIST <<< "$BOTS"
    local port=$DASHBOARD_BASE_PORT

    for bot in "${BOT_LIST[@]}"; do
      bot=$(echo "$bot" | xargs)
      local svc="$systemd_dir/$bot.service"

      cat > "$svc" << EOF
[Unit]
Description=agents-to-im $bot bridge
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$SOURCE_DIR
Environment=CTI_HOME=$CTI_HOME
Environment=CTI_BOT=$bot
Environment=CTI_DASHBOARD_PORT=$port
EnvironmentFile=$CTI_HOME/config.env
ExecStart=/usr/bin/node $SOURCE_DIR/dist/daemon.mjs
Restart=always
RestartSec=5
RestartSteps=10
RestartMaxDelaySec=30

[Install]
WantedBy=multi-user.target
EOF

      systemctl daemon-reload
      systemctl enable "$bot.service"
      ok "$bot.service 已创建 (dashboard port: $port)"
      ((port++))
    done
  fi
}

# ── 提示 OAuth 授权 ──
show_oauth_hint() {
  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║                     下一步操作                               ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""

  if [[ "$MODE" == "single" ]]; then
    echo "1. 编辑 $CTI_HOME/config.env，填写 app_id 和 app_secret"
    echo "2. 启动 OAuth 回调服务:"
    echo "   nohup python3 \$SOURCE_DIR/scripts/oauth-callback-server.py > \$CTI_HOME/logs/oauth-callback.log 2>&1 &"
    echo "3. 浏览器访问 OAuth 授权链接（见 config.env 中的 app_id）"
    echo "4. 授权完成后，启动服务:"
    echo "   systemctl start agents-to-im.service"
    echo "5. 查看日志:"
    echo "   journalctl -u agents-to-im.service -f"
  else
    echo "1. 编辑 $CTI_HOME/config.env，填写所有 bot 的 app_id 和 app_secret"
    echo "2. 启动 OAuth 回调服务:"
    echo "   nohup python3 \$SOURCE_DIR/scripts/oauth-callback-server.py > \$CTI_HOME/logs/oauth-callback.log 2>&1 &"
    echo "3. 浏览器访问 OAuth 授权链接（用 config.env 中第一个 bot 的 app_id）"
    echo "4. 授权完成后，启动所有服务:"
    IFS=',' read -ra BOT_LIST <<< "$BOTS"
    for bot in "${BOT_LIST[@]}"; do
      bot=$(echo "$bot" | xargs)
      echo "   systemctl start $bot.service"
    done
    echo "5. 查看日志:"
    echo "   journalctl -u claude.service -f"
  fi

  echo ""
  echo -e "${YELLOW}注意: OAuth 回调服务需要持续运行，建议配置 systemd 或 supervisord${NC}"
  echo ""
}

# ── 主流程 ──
main() {
  parse_args "$@"

  echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║           agents-to-im 安装脚本                              ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  info "源码目录: $SOURCE_DIR"
  info "数据目录: $CTI_HOME"
  info "部署模式: $MODE"
  info "部署 bots: $BOTS"
  echo ""

  check_deps
  build_project
  setup_directories
  generate_config_env
  generate_systemd_services

  echo ""
  ok "安装完成！"
  show_oauth_hint
}

main "$@"
