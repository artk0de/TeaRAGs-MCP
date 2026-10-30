#!/usr/bin/env python3
"""Compact trace per case: tool calls in order + final answer. Usage: summarize.py <run dir> [--codex|--claude] [maxanswer]"""
import json, sys
from pathlib import Path

run = Path(sys.argv[1])
kind = sys.argv[2] if len(sys.argv) > 2 else "--codex"
maxa = int(sys.argv[3]) if len(sys.argv) > 3 else 1500


def short(v, n=220):
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + "…"


out = {}
if kind == "--codex":
    for case in sorted((run / "cases").iterdir()):
        tr = case / "actor/thread-read.json"
        steps, answer = [], ""
        if not tr.exists():
            out[case.name] = {"status": json.loads((case / "actor/status.json").read_text()) if (case / "actor/status.json").exists() else "missing"}
            continue
        d = json.loads(tr.read_text())
        for turn in d.get("thread", {}).get("turns", []):
            for it in turn.get("items", []):
                t = it.get("type")
                if t == "commandExecution":
                    steps.append("shell: " + short(it.get("command")))
                elif t == "mcpToolCall":
                    steps.append("mcp " + str(it.get("tool")) + ": " + short(it.get("arguments")))
                elif t in ("agentMessage",):
                    answer = it.get("text", "")
                elif t not in ("userMessage", "reasoning", "hookPrompt"):
                    steps.append(t + ": " + short({k: v for k, v in it.items() if k not in ("id", "type")}, 160))
        out[case.name] = {"steps": steps, "answer": answer[:maxa]}
else:
    for case in sorted(p for p in run.iterdir() if p.is_dir()):
        steps, answer, init = [], "", {}
        for line in (case / "stream.jsonl").read_text().splitlines():
            e = json.loads(line)
            if e.get("type") == "system" and e.get("subtype") == "init":
                init = {"plugins": e.get("plugins"), "mcp": e.get("mcp_servers"), "model": e.get("model")}
            if e.get("type") == "assistant":
                for c in e["message"].get("content", []):
                    if c.get("type") == "tool_use":
                        steps.append(c["name"] + ": " + short(c.get("input")))
            if e.get("type") == "result":
                answer = e.get("result", "")
        out[case.name] = {"init": init, "steps": steps, "answer": answer[:maxa]}
print(json.dumps(out, indent=1, ensure_ascii=False))
