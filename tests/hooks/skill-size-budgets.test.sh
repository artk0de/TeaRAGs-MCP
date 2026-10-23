#!/usr/bin/env bash
# tests/hooks/skill-size-budgets.test.sh — a tea-rags SKILL.md body loads whole on
# every trigger; reference blocks belong in references/ and load on demand.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0; FAIL=0
note() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "ok   - $2"; else FAIL=$((FAIL+1)); echo "FAIL - $2"; fi; }

SKILL_CAP=20000
ARCH_CAP=15000
for f in "$ROOT"/.claude-plugin/tea-rags/skills/*/SKILL.md; do
  name="$(basename "$(dirname "$f")")"
  cap=$SKILL_CAP; [ "$name" = architecture-diagnostics ] && cap=$ARCH_CAP
  size="$(wc -c < "$f" | tr -d ' ')"
  [ "$size" -le "$cap" ]; note $? "$name SKILL.md ≤ $cap bytes ($size)"
done

echo "skill-size-budgets: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
