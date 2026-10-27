#!/usr/bin/env bash
# Per-user-turn routing re-inject (plugins/tea-rags/scripts/turn-routing.sh; bd
# tea-rags-mcp-nknkg.2). The lines live in ONE place — the fenced block under
# "## The block to inject" in plugins/tea-rags/rules/references/turn-routing.md —
# and reach each harness as:
#   claude — UserPromptSubmit → hookSpecificOutput.additionalContext
#   codex  — UserPromptSubmit → hookSpecificOutput.additionalContext
#            (generated scripts/turn-routing.txt, Codex dialect)
#   cursor — beforeSubmitPrompt has no context channel, so it arms the turn
#            ({"continue":true}); the turn's first postToolUse delivers the lines
#            as additional_context (generated scripts/turn-routing.txt).
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0; FAIL=0
note() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "ok   - $2"; else FAIL=$((FAIL+1)); echo "FAIL - $2"; fi; }
STATE="$(mktemp -d)"
SRC="$ROOT/plugins/tea-rags/rules/references/turn-routing.md"

hook_of() {
  case "$1" in
    claude) echo "$ROOT/plugins/tea-rags/scripts/turn-routing.sh" ;;
    codex) echo "$ROOT/harness/codex/tea-rags/scripts/turn-routing.sh" ;;
    cursor) echo "$ROOT/harness/cursor/tea-rags/scripts/turn-routing.sh" ;;
  esac
}
run() { # <harness> <json> [hook path]
  OUT=$(printf '%s' "$2" | env TEA_RAGS_HOOK_STATE_DIR="$STATE" bash "${3:-$(hook_of "$1")}" --harness "$1" 2>/dev/null)
  CODE=$?
}

BLOCK=$(awk '/^## The block to inject/ { s = 1; next } s && /^```/ { if (i) exit; i = 1; next } i { print }' "$SRC" 2>/dev/null)
[ -n "$BLOCK" ]; note $? "source block exists in rules/references/turn-routing.md"
BYTES=$(printf '%s' "$BLOCK" | wc -c | tr -d ' ')
[ "$BYTES" -le 400 ]; note $? "block ≤ 400 bytes (is $BYTES)"
LINES=$(printf '%s\n' "$BLOCK" | wc -l | tr -d ' ')
[ "$LINES" -ge 3 ] && [ "$LINES" -le 6 ]; note $? "block is a heading + 3–5 lines (is $LINES lines)"
for word in find_symbol semantic_search get_callees get_callers "symbols:"; do
  printf '%s' "$BLOCK" | grep -qF -- "$word"; note $? "block names $word"
done

for H in claude codex; do
  run "$H" '{"hook_event_name":"UserPromptSubmit","session_id":"s1","prompt":"how does X work"}'
  CTX=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null)
  [ "$CODE" = 0 ] && [ "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.hookEventName')" = UserPromptSubmit ] \
    && printf '%s' "$CTX" | grep -qF find_symbol
  note $? "$H: UserPromptSubmit injects the routing lines"
  run "$H" 'garbage'; [ "$CODE" = 0 ]; note $? "$H: unparsable stdin still exits 0"
done

TXT="$ROOT/harness/codex/tea-rags/scripts/turn-routing.txt"
[ -s "$TXT" ] && ! grep -q 'default code search tool' "$TXT"; note $? "codex: turn-routing.txt is generated in the Codex dialect"
[ -s "$ROOT/harness/cursor/tea-rags/scripts/turn-routing.txt" ]; note $? "cursor: turn-routing.txt is generated"

run cursor '{"hook_event_name":"beforeSubmitPrompt","conversation_id":"c1","prompt":"q","attachments":[]}'
[ "$CODE" = 0 ] && [ "$(printf '%s' "$OUT" | jq -r '.continue')" = true ]; note $? "cursor: beforeSubmitPrompt answers continue:true"
run cursor '{"hook_event_name":"postToolUse","conversation_id":"c1","tool_name":"Shell","tool_input":{},"tool_output":"{}"}'
printf '%s' "$OUT" | jq -r '.additional_context // empty' | grep -qF find_symbol; note $? "cursor: first postToolUse of the turn injects the lines"
run cursor '{"hook_event_name":"postToolUse","conversation_id":"c1","tool_name":"Shell","tool_input":{},"tool_output":"{}"}'
[ "$CODE" = 0 ] && [ -z "$(printf '%s' "$OUT" | jq -r '.additional_context // empty')" ]; note $? "cursor: later postToolUse of the turn injects nothing"
run cursor '{"hook_event_name":"postToolUse","conversation_id":"c2","tool_name":"Shell"}'
[ -z "$(printf '%s' "$OUT" | jq -r '.additional_context // empty')" ]; note $? "cursor: another conversation's turn is not armed"
run cursor 'garbage'; [ "$CODE" = 0 ] && printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; note $? "cursor: unparsable stdin → valid JSON"
LONE="$(mktemp -d)"; cp "$(hook_of cursor)" "$LONE/turn-routing.sh"
run cursor '{"hook_event_name":"beforeSubmitPrompt","conversation_id":"c3"}' "$LONE/turn-routing.sh"
[ "$CODE" = 0 ] && [ "$(printf '%s' "$OUT" | jq -r '.continue')" = true ]; note $? "cursor: missing text file → still continue:true"
run claude '{"hook_event_name":"UserPromptSubmit","session_id":"s1"}' "$LONE/turn-routing.sh"
[ "$CODE" = 0 ] && [ -z "$OUT" ]; note $? "claude: missing text file → no output, exit 0"
rm -rf "$LONE"

PJ="$ROOT/plugins/tea-rags/.claude-plugin/plugin.json"
jq -e '.hooks.UserPromptSubmit[].hooks[] | select(.command | test("turn-routing.sh --harness claude"))' "$PJ" >/dev/null
note $? "claude: UserPromptSubmit wires turn-routing"
jq -e '.hooks.UserPromptSubmit[].hooks[] | select(.command | test("turn-routing.sh --harness codex"))' "$ROOT/harness/codex/tea-rags/hooks/hooks.json" >/dev/null
note $? "codex: UserPromptSubmit wires turn-routing"
UJ="$ROOT/harness/cursor/tea-rags/hooks/hooks.json"
jq -e '.hooks.beforeSubmitPrompt[] | select(.command | test("turn-routing.sh\"? --harness cursor"))' "$UJ" >/dev/null \
  && jq -e '.hooks.postToolUse[] | select(.command | test("turn-routing.sh\"? --harness cursor"))' "$UJ" >/dev/null
note $? "cursor: beforeSubmitPrompt + postToolUse wire turn-routing"
cmp -s "$(hook_of claude)" "$(hook_of codex)" && cmp -s "$(hook_of claude)" "$(hook_of cursor)"
note $? "one script: Codex and Cursor ship the plugin's turn-routing.sh byte-identical"

rm -rf "$STATE"
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
