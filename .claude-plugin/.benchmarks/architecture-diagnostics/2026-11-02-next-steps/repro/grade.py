#!/usr/bin/env python3
"""Deterministic grading of one run dir against the suite's `grading` checks.

answer_criterion / require_source_body checks are emitted as MANUAL with the
evidence the human/LLM grader needs; every other kind is decided here.
usage: grade.py <run-dir> <case-id>  -> prints JSON {checks:[...], answer, trace}
"""
import json, re, sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
suite = json.loads((BASE.parents[1] / "evals/2026-11-02-next-steps.json").read_text())
run, cid = Path(sys.argv[1]), sys.argv[2]
case = next(c for c in suite["evals"] if c["id"] == cid)

uses, answer = [], ""
for line in (run / "stream.jsonl").read_text().splitlines():
    try:
        ev = json.loads(line)
    except ValueError:
        continue
    if ev.get("type") == "assistant":
        for block in ev["message"].get("content", []):
            if block.get("type") == "tool_use":
                uses.append({"name": block["name"], "input": block.get("input", {})})
    if ev.get("type") == "result":
        answer = ev.get("result") or ""


def base(name):
    return name.rsplit("__", 1)[-1]


def reads():
    out = []
    for u in uses:
        if u["name"] == "Read":
            out.append(u["input"].get("file_path", ""))
        elif u["name"] == "Bash":
            out.append(u["input"].get("command", ""))
        elif base(u["name"]) in ("ReadMcpResourceTool",) or u["name"] == "ReadMcpResourceTool":
            out.append(u["input"].get("uri", ""))
    return out


def invokes():
    return [u["input"].get("skill", "") for u in uses if u["name"] == "Skill"]


def tool_calls(tool):
    return [u for u in uses if u["name"].startswith("mcp__") and base(u["name"]) == tool]


def bash():
    return [u["input"].get("command", "") for u in uses if u["name"] == "Bash"]


results = []
for chk in case["grading"]["checks"]:
    kind, ok, note = chk["kind"], None, ""
    pats = chk.get("patterns", [])
    if kind == "require_tool":
        calls = tool_calls(chk["tool"])
        want = chk.get("arguments", {})
        ok = any(all(c["input"].get(k) == v for k, v in want.items()) for c in calls)
        note = f"{len(calls)} call(s)"
    elif kind == "forbid_tool":
        calls = tool_calls(chk["tool"]); ok = not calls; note = f"{len(calls)} call(s)"
    elif kind in ("require_read", "forbid_read_or_invoke", "require_read_or_invoke"):
        hay = reads() + (invokes() if "invoke" in kind else [])
        hits = [h for h in hay if any(p in h for p in pats)]
        ok = bool(hits) != kind.startswith("forbid"); note = "; ".join(hits)[:300]
    elif kind in ("require_invoke", "forbid_invoke"):
        hits = [s for s in invokes() if any(p in s for p in pats)]
        ok = bool(hits) == (kind == "require_invoke"); note = ", ".join(hits)
    elif kind == "forbid_bash":
        hits = [c for c in bash() if any(p in c for p in pats)]; ok = not hits; note = "; ".join(hits)[:300]
    elif kind == "forbid_bash_regex":
        hits = [c for c in bash() if re.search(chk["pattern"], c)]; ok = not hits; note = "; ".join(hits)[:300]
    elif kind == "shim_log_forbid":
        log = run / chk["log"]
        lines = log.read_text().splitlines() if log.exists() else []
        hits = [l for l in lines if re.search(chk["pattern"], l)]
        ok = not hits; note = f"log lines {len(lines)}, matching {len(hits)}"
    elif kind == "answer_regex":
        m = re.search(chk["pattern"], answer); ok = bool(m); note = m.group(0) if m else ""
    elif kind == "answer_forbid_regex":
        m = re.search(chk["pattern"], answer); ok = not m; note = m.group(0) if m else ""
    else:
        ok, note = "MANUAL", chk.get("criterion", "")
    results.append({"id": chk["id"], "kind": kind, "pass": ok, "note": note})

trace = [(base(u["name"]) if u["name"].startswith("mcp__") else u["name"]) + " " + json.dumps(u["input"])[:160] for u in uses]
print(json.dumps({"case": cid, "checks": results, "trace": trace, "answer": answer}, indent=1, ensure_ascii=False))
