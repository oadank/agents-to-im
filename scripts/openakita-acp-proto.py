# -*- coding: utf-8 -*-
"""OpenAkita ACP 原型验证：测试 chat_with_session_stream 事件流"""
import asyncio, sys, io, time, os

# 必须在 import openakita 之前 chdir（settings.project_root 在 import 时按 cwd 初始化）
os.chdir(r"C:\Users\oadan\.openakita\workspaces\default")
os.environ["LLM_ENDPOINTS_CONFIG"] = os.path.join(
    os.getcwd(), "data", "llm_endpoints.json"
)

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

from openakita.main import get_agent
from openakita.sessions.session import Session


async def main():
    print("[proto] get_agent...", flush=True)
    agent = get_agent()
    print("[proto] agent.initialize()...", flush=True)
    await agent.initialize()
    print("[proto] initialized, brain model:", getattr(getattr(agent, 'brain', None), 'model', '?'), flush=True)

    session = Session(
        id="acp-proto-1",
        channel="cli",
        chat_id="acp-proto",
        user_id="test",
        working_directory=r"C:\temp",
    )

    print("[proto] running chat_with_session_stream...", flush=True)
    types = {}
    t0 = time.time()
    try:
        async for ev in agent.chat_with_session_stream(
            message="只回复两个字：收到",
            session_messages=[],
            session_id=session.id,
            session=session,
            gateway=None,
            mode="agent",
            thinking_mode="off",
        ):
            t = ev.get("type", "?")
            types[t] = types.get(t, 0) + 1
            content = str(ev.get("content", ""))[:60]
            print(f"[evt] {t}: {content}", flush=True)
            if t in ("done", "error"):
                break
            if time.time() - t0 > 45:
                print("[proto] timeout 45s, break", flush=True)
                break
    except Exception as e:
        print(f"[proto] EXC: {type(e).__name__}: {e}", flush=True)
    print("[proto] event types:", sorted(types.keys()), flush=True)
    print("[proto] DONE", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
