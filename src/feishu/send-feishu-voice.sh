#!/bin/bash
# 飞书语音发送一键脚本
# 用法: bash send-feishu-voice.sh "要说的话" <receive_id> <receive_id_type>
#   receive_id_type: open_id (私聊) 或 chat_id (群聊)

set -e

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
TEXT="${1:?用法: $0 \"要说的话\" <receive_id> <receive_id_type>}"
RECEIVE_ID="${2:?缺少 receive_id}"
RECEIVE_TYPE="${3:-chat_id}"

# 用 Python 完成所有步骤（避免 bash 特殊字符问题）
python3 << PYEOF
import json, subprocess, urllib.request, sys, os, glob

SKILL_DIR = "${SKILL_DIR}"
TEXT = """${TEXT}"""
RECEIVE_ID = "${RECEIVE_ID}"
RECEIVE_TYPE = "${RECEIVE_TYPE}"

print("[1/4] 合成语音...")
result = subprocess.run(
    ["node", f"{SKILL_DIR}/tts-wrapper.mjs", TEXT],
    stderr=subprocess.PIPE, stdout=subprocess.PIPE
)

# 从 stderr 中提取实际生成的文件路径
import re
stderr_text = result.stderr.decode('utf-8', errors='replace')
print(stderr_text, end='', file=sys.stderr)

# 查找 [TTS] xxx -> OPUS/MP3 之后的成功文件
# tts-wrapper 输出文件到 /tmp/openclaw/<provider>TTS.<format>
import glob
opus_files = sorted(glob.glob('/tmp/openclaw/*TTS.opus'), key=os.path.getmtime, reverse=True)
mp3_files = sorted(glob.glob('/tmp/openclaw/*TTS.mp3'), key=os.path.getmtime, reverse=True)
all_tts_files = opus_files + mp3_files

if not all_tts_files:
    print("❌ 未找到 TTS 输出文件")
    sys.exit(1)

audio_file = all_tts_files[0]
print(f"[音频文件] {audio_file}")

print("[2/4] 获取 token...")
import os
cti_bot = os.environ.get('CTI_BOT', '').lower()
if cti_bot == 'claude':
    import subprocess as sp
    secret = sp.run(["grep", "CTI_BOT_CLAUDE_APP_SECRET", "/opt/.agents-to-im/config.env"], capture_output=True, text=True).stdout.strip().split("=")[1]
    app_id = "cli_a9f54ba5f5b91cb5"
elif cti_bot == 'mimo':
    import subprocess as sp
    secret = sp.run(["grep", "CTI_BOT_MIMO_APP_SECRET", "/opt/.agents-to-im/config.env"], capture_output=True, text=True).stdout.strip().split("=")[1]
    app_id = "cli_aaa09df01322dcff"
elif cti_bot == 'gemini':
    import subprocess as sp
    secret = sp.run(["grep", "CTI_BOT_GEMINI_APP_SECRET", "/opt/.agents-to-im/config.env"], capture_output=True, text=True).stdout.strip().split("=")[1]
    app_id = "cli_aaaa4958ec7b1cfc"
elif cti_bot == 'codex':
    import subprocess as sp
    secret = sp.run(["grep", "CTI_BOT_CODEX_APP_SECRET", "/opt/.agents-to-im/config.env"], capture_output=True, text=True).stdout.strip().split("=")[1]
    app_id = "cli_aacba41108381cd9"
else:
    # OpenClaw default
    with open('/root/.openclaw/credentials/lark.secrets.json') as f:
        secret = json.load(f)['lark']['appSecret']
    app_id = "cli_aaabbd492f789ce3"

token_data = json.dumps({"app_id": app_id, "app_secret": secret}).encode()
req = urllib.request.Request(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    data=token_data, headers={"Content-Type": "application/json"}
)
resp = json.loads(urllib.request.urlopen(req).read())
token = resp.get('tenant_access_token')
if not token:
    print(f"❌ 获取 token 失败: {resp}")
    sys.exit(1)

print("[3/4] 上传音频...")
file_ext = os.path.splitext(audio_file)[1].lstrip('.') or 'opus'
upload_result = subprocess.run([
    "curl", "-s", "-X", "POST", "https://open.feishu.cn/open-apis/im/v1/files",
    "-H", f"Authorization: Bearer {token}",
    "-F", f"file_type={file_ext}",
    "-F", "file_name=voice.opus",
    "-F", f"file=@{audio_file}"
], capture_output=True, text=True)

upload_data = json.loads(upload_result.stdout)
file_key = upload_data.get('data', {}).get('file_key', '')
if not file_key:
    print(f"❌ 上传失败: {upload_result.stdout}")
    sys.exit(1)

print(f"[4/4] 发送语音到 {RECEIVE_ID} ({RECEIVE_TYPE})...")
send_data = json.dumps({
    "receive_id": RECEIVE_ID,
    "msg_type": "audio",
    "content": json.dumps({"file_key": file_key})
}).encode()
send_req = urllib.request.Request(
    f"https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type={RECEIVE_TYPE}",
    data=send_data,
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
)
send_resp = json.loads(urllib.request.urlopen(send_req).read())
code = send_resp.get('code')
if code == 0:
    print("✅ 语音发送成功")
else:
    print(f"❌ 发送失败: {json.dumps(send_resp)}")
    sys.exit(1)
PYEOF
