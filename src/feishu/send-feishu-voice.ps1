#!/usr/bin/env pwsh
param([Parameter(Mandatory=$true)][string]$Text,[Parameter(Mandatory=$true)][string]$ReceiveId,[string]$ReceiveType="chat_id")
$ErrorActionPreference = "Stop"
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$CONFIG_PATH = "C:\Users\oadan\.agents-to-im\config.env"
$BOT = ($env:CTI_BOT ?? "codex").ToUpper()
$dir = Join-Path $env:TEMP "openclaw"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$env:TTS_CHANNEL = "feishu"
$null = node "$SCRIPT_DIR\tts-wrapper.mjs" $Text 2>&1
$audioFile = Get-ChildItem -Path $dir -Filter "*TTS.opus" | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $audioFile -or -not (Test-Path $audioFile)) { exit 1 }
$config = Get-Content $CONFIG_PATH -Encoding UTF8
$appId = ($config | Select-String "CTI_BOT_${BOT}_APP_ID=").ToString().Split("=",2)[1].Trim()
$appSecret = ($config | Select-String "CTI_BOT_${BOT}_APP_SECRET=").ToString().Split("=",2)[1].Trim()
$tokenBody = @{app_id=$appId;app_secret=$appSecret} | ConvertTo-Json -Compress
$tokenResp = Invoke-RestMethod -Uri "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" -Method POST -ContentType "application/json" -Body $tokenBody
$token = $tokenResp.tenant_access_token
# 上传音频文件（pwsh 7 的 -Form 方式，multipart 由 Invoke-RestMethod 自动处理，更可靠）
$uploadResp = Invoke-RestMethod -Uri "https://open.feishu.cn/open-apis/im/v1/files" -Method POST `
  -Headers @{ Authorization = "Bearer $token" } `
  -Form @{
    file_type = "opus"
    file_name = "voice.opus"
    file = Get-Item $audioFile
  }
$fileKey = $uploadResp.data.file_key
$contentJson = @{file_key=$fileKey} | ConvertTo-Json -Compress
$sendBody = @{receive_id=$ReceiveId;msg_type="audio";content=$contentJson} | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=$ReceiveType" -Method POST -Headers @{Authorization="Bearer $token";"Content-Type"="application/json"} -Body $sendBody | Out-Null
Write-Host "OK"
