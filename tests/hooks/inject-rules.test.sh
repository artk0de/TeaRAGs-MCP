#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/.claude-plugin/tea-rags/scripts/inject-rules.sh"
RULES="$ROOT/.claude-plugin/tea-rags/rules"
PASS=0; FAIL=0
note() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "ok   - $2"; else FAIL=$((FAIL+1)); echo "FAIL - $2"; fi; }

# The hook's stdout is delivered to the model as one attachment. Past ~16KB the
# harness persists it to a file and the model sees a 2KB preview instead, so the
# corpus has to arrive as several parts, each below the budget.
BUDGET=10000

TMPD="$(mktemp -d)"; OUT="$TMPD/out.txt"; ALL="$TMPD/all.txt"

run()   { bash "$HOOK" "$@" > "$OUT" 2>/dev/null; }
bytes() { wc -c < "$1" | tr -d ' '; }
corpus_bytes() { cat "$RULES"/*.md | wc -c | tr -d ' '; }
# A hook that ignores the flag answers with the whole corpus — read that as 0
# rather than letting it reach `[ -ge ]` and print itself into the test log.
num()   { case "${1:-}" in (''|*[!0-9]*) echo 0 ;; (*) echo "$1" ;; esac; }

# 1. --count reports the number of parts the corpus is split into
TOTAL="$(num "$(bash "$HOOK" --count 2>/dev/null)")"
[ "$TOTAL" -ge 2 ]
note $? "--count reports how many parts the corpus needs"

# 2. every part fits the delivery budget
# (counting up by hand — BSD `seq 1 0` counts DOWN and yields "1 0")
over=0; i=1
while [ "$i" -le "$TOTAL" ]; do
  run --part "$i"
  [ "$(bytes "$OUT")" -le "$BUDGET" ] || over=1
  i=$((i+1))
done
[ "$TOTAL" -gt 0 ] && [ "$over" = 0 ]
note $? "every part fits the hook stdout budget ($BUDGET bytes)"

# 3. the parts together carry the whole corpus — no section silently dropped
: > "$ALL"; i=1
while [ "$i" -le "$TOTAL" ]; do bash "$HOOK" --part "$i" >> "$ALL" 2>/dev/null; i=$((i+1)); done
missing=0
while IFS= read -r heading; do
  grep -Fqx "$heading" "$ALL" || missing=1
done < <(grep -h '^## ' "$RULES"/*.md)
[ "$missing" = 0 ]
note $? "concatenated parts preserve every rule section"

# 4. content volume survives the split — and nothing is emitted twice
[ "$(bytes "$ALL")" -ge "$(corpus_bytes)" ] && [ "$(bytes "$ALL")" -le $(( $(corpus_bytes) + 4000 )) ]
note $? "concatenated parts carry the corpus once, plus part markers"

# 5. a part past the last one prints nothing (spare hook slots stay silent)
run --part "$(( ${TOTAL:-0} + 1 ))"
[ ! -s "$OUT" ]
note $? "a part beyond the last one prints nothing"

# 6. a section larger than the budget is split, not emitted whole
T3="$(num "$(bash "$HOOK" --count --max-bytes 3000 2>/dev/null)")"
over=0; i=1
while [ "$i" -le "$T3" ]; do
  bash "$HOOK" --part "$i" --max-bytes 3000 > "$OUT" 2>/dev/null
  [ "$(bytes "$OUT")" -le 3000 ] || over=1
  i=$((i+1))
done
[ "$T3" -gt 0 ] && [ "$over" = 0 ]
note $? "--max-bytes splits sections larger than the budget"

# 7. each part says which part of how many it is, so the model reads them as one document
run --part 2
grep -q 'part 2/' "$OUT"
note $? "each part carries its part-of-total marker"

# 8. each file segment is labelled, so references between rule files resolve
grep -q 'rules/search-cascade.md' "$ALL" && grep -q 'rules/index-freshness.md' "$ALL"
note $? "each file segment is labelled with its source path"

# 9. more parts than the hook declares → the last one names what it could not carry
bash "$HOOK" --part 2 --parts 2 --max-bytes 3000 > "$OUT" 2>/dev/null
grep -q 'Read these files directly' "$OUT"
note $? "the last declared part points to the rules it could not carry"

# 10. no arguments still dumps the whole corpus (a plugin.json that was not updated)
run
[ "$(bytes "$OUT")" -ge "$(corpus_bytes)" ]
note $? "no arguments dumps the whole corpus (legacy callers)"

rm -rf "$TMPD"
echo "---"; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
