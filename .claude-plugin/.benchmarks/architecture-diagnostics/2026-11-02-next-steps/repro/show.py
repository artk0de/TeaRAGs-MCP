#!/usr/bin/env python3
"""Bounded console view of grade.py output. usage: show.py <grade.json> [answer_chars]"""
import json, sys

d = json.load(open(sys.argv[1]))
n = int(sys.argv[2]) if len(sys.argv) > 2 else 2500
for c in d["checks"]:
    print(c["id"], c["pass"], str(c["note"])[:150])
print("\n".join(d["trace"][:40]))
print("ANSWER:", d["answer"][:n])
