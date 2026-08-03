#!/usr/bin/env pwsh
# agents-to-im codex bot 启动脚本
# 运行在 Session 1（用户桌面），解决 Session 0 隔离问题

$ErrorActionPreference = 'Stop'

# 工作目录
Set-Location 'C:\D\opt\'

# 环境变量
$env:CTI_HOME = 'C:\Users\oadan\.agents-to-im'
$env:CTI_BOT = 'codex'

# codex bot 配置（密钥从 config.env 读取，不硬编码）
$env:CTI_BOT_CODEX_APP_ID = 'cli_aacba41108381cd9'
$env:CTI_BOT_CODEX_RUNTIME = 'codex'
$env:CTI_BOT_CODEX_AGENT_NAME = 'codex'
$env:CTI_BOT_CODEX_MODEL_GROUP = 'codex-model'
$env:CTI_BOT_CODEX_MODEL_PROVIDER = 'LiteLLM'
$env:CTI_BOT_CODEX_SHOW_TOOL_CALL_CARDS = 'true'
$env:CTI_BOT_CODEX_SHOW_AGENT_DIVIDER = 'true'

# 从 config.env 加载 APP_SECRET
$configEnv = Join-Path $env:CTI_HOME 'config.env'
if (Test-Path $configEnv) {
  $line = Get-Content $configEnv | Where-Object { $_ -match '^CTI_BOT_CODEX_APP_SECRET=' }
  if ($line) {
    $env:CTI_BOT_CODEX_APP_SECRET = ($line -replace '^CTI_BOT_CODEX_APP_SECRET=', '').Trim('"', "'")
  }
}
if (-not $env:CTI_BOT_CODEX_APP_SECRET) {
  Write-Error "CTI_BOT_CODEX_APP_SECRET not found in $configEnv"
  exit 1
}

# 日志
$logFile = "$env:CTI_HOME\logs\codex-stdout.log"
$errFile = "$env:CTI_HOME\logs\codex-stderr.log"

# 启动 daemon
& node.exe "C:\D\opt\agents-to-im\dist\daemon.mjs" 2>&1 | Tee-Object -FilePath $logFile
