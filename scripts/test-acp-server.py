# -*- coding: utf-8 -*-
"""测试 openakita-acp-server.py：spawn 进程，走完整 ACP 流程"""
import json
import os
import subprocess
import sys
import time

server = os.path.join(os.path.dirname(__file__), "openakita-acp-server.py")
py = r"C:\D\opt\openakita\venv\Scripts\python.exe"

proc = subprocess.Popen(
    [py, server],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    encoding="utf-8",
    errors="replace",
)

import threading

def _dump_stderr():
    for line in proc.stderr:
        line = line.rstrip()
        if line:
            print("[server-stderr]", line[:200])

threading.Thread(target=_dump_stderr, daemon=True).start()


def rpc(method, params, req_id):
    proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}) + "\n")
    proc.stdin.flush()


def read_responses(timeout=120):
    """读 server 输出直到 session/result 或超时"""
    import select
    lines = []
    t0 = time.time()
    buf = ""
    while time.time() - t0 < timeout:
        line = proc.stdout.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        lines.append(line)
        obj = json.loads(line)
        if obj.get("id") == 3 and "result" in obj:
            break
        if time.time() - t0 > timeout:
            break
    return lines


rpc("initialize", {}, 1)
rpc("session/new", {"cwd": r"C:\Users\oadan\.openakita\workspaces\default", "mcpServers": []}, 2)

# 读 init + session/new 响应
buf = ""
sid = None
t0 = time.time()
while time.time() - t0 < 30:
    line = proc.stdout.readline()
    if not line:
        break
    line = line.strip()
    if not line:
        continue
    obj = json.loads(line)
    print("[resp]", json.dumps(obj, ensure_ascii=False)[:150])
    if obj.get("id") == 2 and obj.get("result"):
        sid = obj["result"]["sessionId"]
        break

if not sid:
    print("FAIL: no sessionId")
    proc.kill()
    sys.exit(1)

print("=== sessionId:", sid, "===")
rpc("session/prompt", {"sessionId": sid, "prompt": "只回复两个字：收到"}, 3)

t0 = time.time()
update_count = {"thought": 0, "message": 0, "activity": 0, "tool": 0}
while time.time() - t0 < 150:
    line = proc.stdout.readline()
    if not line:
        break
    line = line.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        continue
    m = obj.get("method")
    if m == "session/update":
        u = obj.get("params", {}).get("update", {})
        su = u.get("sessionUpdate")
        if su == "agent_thought_chunk":
            update_count["thought"] += 1
        elif su == "agent_message_chunk":
            update_count["message"] += 1
            print("[text]", repr(u.get("content", {}).get("text", "")))
        elif su == "tool_call":
            update_count["tool"] += 1
        else:
            update_count["activity"] += 1
    elif obj.get("id") == 3 and "result" in obj:
        print("[RESULT]", json.dumps(obj["result"], ensure_ascii=False)[:300])
        print("counts:", update_count)
        break

proc.kill()
print("TEST DONE")
