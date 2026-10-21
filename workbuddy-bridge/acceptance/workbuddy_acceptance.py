#!/usr/bin/env python3
"""Acceptance checks for the WorkBuddy bridge + OmniRoute setup.

Every check hits a real endpoint and asserts on the response body. The last
check reads OmniRoute's persisted call log to prove that a shared model id
(`hy3`) requested through `workbuddy-ai/` was routed to the WorkBuddy AI
connection, not the CN one.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import urllib.request
from pathlib import Path

BRIDGE = "http://127.0.0.1:11459"
OMNI = "http://127.0.0.1:20128"
BRIDGE_KEY = Path.home().joinpath(".omniroute/workbuddy-bridge/.bridge-key").read_text().strip()
# The OmniRoute connection id for the WorkBuddy AI provider. It is a per-install
# row id, so it is not pinned in the repo; override it in the environment.
AI_CONNECTION = os.environ.get("WB_AI_CONNECTION_ID", "")
DB = Path.home().joinpath(".omniroute/storage.sqlite")

results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str) -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")


def http_json(url: str, key: str, body: dict | None = None, timeout: int = 120):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="GET" if body is None else "POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=timeout) as resp:
        return resp.status, json.loads(resp.read().decode())


def chat(base: str, key: str, model: str, prompt: str) -> tuple[int, str]:
    status, payload = http_json(
        f"{base}/v1/chat/completions",
        key,
        {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "max_tokens": 256,
        },
    )
    choices = payload.get("choices") or []
    content = choices[0].get("message", {}).get("content", "") if choices else ""
    return status, content or ""


def main() -> int:
    status, health = http_json(f"{BRIDGE}/healthz", BRIDGE_KEY)
    variants = {v["id"]: v for v in health.get("variants", [])}
    record(
        "bridge health",
        status == 200 and health.get("ok") is True and health.get("models", 0) >= 38,
        f"http={status} models={health.get('models')}",
    )
    for variant_id in ("workbuddy", "workbuddy-ai"):
        v = variants.get(variant_id, {})
        record(
            f"{variant_id} signed in",
            v.get("signedIn") is True and v.get("models", 0) > 0,
            f"signedIn={v.get('signedIn')} models={v.get('models')}",
        )

    status, content = chat(BRIDGE, BRIDGE_KEY, "hy3", "Reply exactly BRIDGE-CN-OK")
    record("bridge CN chat", status == 200 and bool(content), f"http={status} content={content[:40]!r}")

    status, content = chat(BRIDGE, BRIDGE_KEY, "kimi-k3", "Reply exactly BRIDGE-AI-OK")
    record("bridge AI chat", status == 200 and bool(content), f"http={status} content={content[:40]!r}")

    # OmniRoute uses its own gateway key; read the local dashboard key from DB.
    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as conn:
        row = conn.execute("select key from api_keys where name='js' limit 1").fetchone()
    omni_key = row[0] if row else ""

    for model, label in (
        ("workbuddy/hy3", "omniroute CN chat"),
        ("workbuddy-ai/kimi-k3", "omniroute AI-only model"),
        ("workbuddy-ai/hy3", "omniroute AI shared model"),
    ):
        status, content = chat(OMNI, omni_key, model, "Reply exactly OMNI-OK")
        record(label, status == 200 and bool(content), f"model={model} http={status} content={content[:40]!r}")

    with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as conn:
        routed = conn.execute(
            "select requested_model, connection_id, status, timestamp from call_logs "
            "where requested_model='workbuddy-ai/hy3' order by timestamp desc limit 1"
        ).fetchone()
    record(
        "omniroute AI routing persisted",
        bool(routed)
        and AI_CONNECTION != ""
        and routed[1] == AI_CONNECTION
        and routed[2] == 200,
        f"row={routed}",
    )

    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print("failed:", ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
