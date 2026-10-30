#!/usr/bin/env python3
"""Print the tool sequence and final answer of one run dir (stream.jsonl)."""
import json, sys
from pathlib import Path

run = Path(sys.argv[1])
seen, final = set(), ""
for line in (run / "stream.jsonl").read_text().splitlines():
    try:
        ev = json.loads(line)
    except ValueError:
        continue
    if ev.get("type") == "assistant":
        for block in ev["message"].get("content", []):
            if block.get("type") == "tool_use" and block["id"] not in seen:
                seen.add(block["id"])
                args = json.dumps(block["input"], ensure_ascii=False)
                print("TOOL", block["name"], args[:300])
    if ev.get("type") == "result":
        final = ev.get("result", "")
print("FINAL:", final[:int(sys.argv[2]) if len(sys.argv) > 2 else 1500])
