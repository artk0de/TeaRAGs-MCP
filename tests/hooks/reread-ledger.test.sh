#!/usr/bin/env bash
# Re-read ledger hook (plugins/tea-rags/scripts/reread-ledger.mjs), Claude Code.
# PostToolUse records the line ranges a call printed — Read (offset/limit), Bash
# cat / sed -n A,Bp / head / tail / grep -v '^\s*$' of a file, tea-rags results
# carrying content + startLine/endLine. PreToolUse of a Read / Bash read /
# find_symbol whose range is already ≥ 80% covered adds ONE additionalContext
# line naming the range and where it came from. It never blocks. Edit / Write /
# MultiEdit / NotebookEdit, a Bash write (`>`, `sed -i`) and a changed mtime or
# size drop a file's entries; a compaction or /clear (SessionStart compact|clear)
# drops the session's; UserPromptSubmit advances the turn label. Ledgers are per
# session id + subagent id. Every error fails open: exit 0, no output.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/plugins/tea-rags/scripts/reread-ledger.mjs"
PASS=0; FAIL=0
note() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "ok   - $2"; else FAIL=$((FAIL+1)); echo "FAIL - $2"; fi; }

STATE="$(mktemp -d)"; REPO="$(mktemp -d)"; FAKEBIN="$(mktemp -d)"
trap 'rm -rf "$STATE" "$REPO" "$FAKEBIN"' EXIT
mkdir -p "$REPO/sub"
for i in $(seq 1 30); do echo "const line$i = $i;"; done > "$REPO/a.ts"
for i in $(seq 1 12); do echo "def b$i; end"; done > "$REPO/sub/b.rb"

# Fake `tea-rags`: `project indexed …` prints $FAKE_OUT (default: not indexed) and
# exits like the real one (0 indexed, 1 not); every call is logged to calls.log.
cat > "$FAKEBIN/tea-rags" <<'EOF'
#!/usr/bin/env bash
[ "$1 $2" = "project indexed" ] || exit 3
echo "$*" >> "$(dirname "$0")/calls.log"
printf '%s\n' "${FAKE_OUT:-{\"indexed\":false\}}"
case "${FAKE_OUT:-}" in *'"indexed":true'*) exit 0 ;; *) exit 1 ;; esac
EOF
chmod +x "$FAKEBIN/tea-rags"
export FAKE_OUT='{"indexed":false}'

run() { # <json> → OUT, CODE
  OUT=$(printf '%s' "$1" | TEA_RAGS_BIN="$FAKEBIN/tea-rags" TEA_RAGS_HOOK_STATE_DIR="$STATE" node "$HOOK" 2>/dev/null)
  CODE=$?
}
EMPTY='{}'
event() { # <event> <sid> <tool> <tool_input json> [tool_response json] [extra fields json]
  jq -cn --arg e "$1" --arg s "$2" --arg t "$3" --argjson i "$4" --argjson r "${5:-null}" --argjson x "${6:-$EMPTY}" --arg cwd "$REPO" \
    '{hook_event_name: $e, session_id: $s, cwd: $cwd, tool_name: $t, tool_input: $i} + (if $r == null then {} else {tool_response: $r} end) + $x'
}
post() { run "$(event PostToolUse "$@")"; }
pre() { run "$(event PreToolUse "$@")"; }
context() { printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null; }
noted() { # [substring…] — the PreToolUse answer is a note, never a decision
  [ "$CODE" = 0 ] || return 1
  [ "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.hookEventName // empty')" = PreToolUse ] || return 1
  [ -z "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecision // empty')" ] || return 1
  local s; for s in "$@"; do context | grep -qF -- "$s" || return 1; done
}
silent() { [ "$CODE" = 0 ] && [ -z "$OUT" ]; }
read_in() { # <file> [offset] [limit]
  jq -cn --arg f "$1" --arg o "${2:-}" --arg l "${3:-}" \
    '{file_path: $f} + (if $o == "" then {} else {offset: ($o|tonumber)} end) + (if $l == "" then {} else {limit: ($l|tonumber)} end)'
}
bash_in() { jq -cn --arg c "$1" '{command: $c}'; }
A="$REPO/a.ts"

# --- Read → Read
post s1 Read "$(read_in "$A")" '{"type":"text"}'
silent; note $? "PostToolUse records silently"
pre s1 Read "$(read_in "$A")"
noted "lines 1–30 of a.ts" "already returned" "Read" "answer from them"; note $? "whole-file Read again → note naming range, file and source"
pre s1 Read "$(read_in "$A" 10 5)"
noted "lines 10–14 of a.ts"; note $? "a sub-range of a served range → note with the requested lines"
pre s2 Read "$(read_in "$A")"
silent; note $? "another session has its own ledger"
pre s1 Read "$(read_in "$A")" null '{"agent_id":"sub-1"}'
silent; note $? "a subagent has its own ledger (it never saw the parent's reads)"

# --- partial coverage
post s3 Read "$(read_in "$A" 1 10)"
pre s3 Read "$(read_in "$A" 1 30)"
silent; note $? "10 of 30 lines served → no note (< 80%)"
post s3 Read "$(read_in "$A" 11 15)"
pre s3 Read "$(read_in "$A" 1 30)"
noted "of a.ts"; note $? "union of two reads covers 25 of 30 lines → note (≥ 80%)"

# --- Bash reads
post s4 Bash "$(bash_in "sed -n '5,20p' a.ts")" '{"stdout":"x","stderr":""}'
pre s4 Read "$(read_in "$A" 5 16)"
noted "lines 5–20 of a.ts" "Bash"; note $? "sed -n A,Bp recorded → Read of the same lines noted"
pre s4 Bash "$(bash_in "sed -n 6,18p $A")"
noted "lines 6–18 of a.ts"; note $? "absolute path, unquoted script → same file"
post s5 Bash "$(bash_in "cd sub && cat b.rb | grep -v '^\\s*\$'")" '{"stdout":"x"}'
pre s5 Read "$(read_in "$REPO/sub/b.rb")"
noted "lines 1–12 of sub/b.rb"; note $? "cd + cat piped through a blank-line filter is a whole-file read"
post s6 Bash "$(bash_in "cat a.ts | grep line1")" '{"stdout":"x"}'
pre s6 Read "$(read_in "$A")"
silent; note $? "cat piped into a pattern grep is a search, not a read"
post s7 Bash "$(bash_in "head -n 25 a.ts")" '{"stdout":"x"}'
pre s7 Bash "$(bash_in "cat a.ts")"
noted "lines 1–25 of a.ts"; note $? "head -n 25 then cat → 25 of 30 covered → note"

# --- numbered grep output: the printed lines are recorded from stdout
post s19 Bash "$(bash_in "grep -n -A3 line5 a.ts")" "$(jq -cn --arg o "$(grep -n -A3 'line5 ' "$A")" '{stdout: $o}')"
pre s19 Bash "$(bash_in "sed -n 5,8p a.ts")"
noted "lines 5–8 of a.ts" "Bash"; note $? "single-file grep -n context lines are recorded from its output"
post s20 Bash "$(bash_in "grep -rn 'line2 ' .")" "$(jq -cn --arg o "$(cd "$REPO" && grep -rn 'line2 ' .)" '{stdout: $o}')"
pre s20 Read "$(read_in "$A" 2 1)"
noted "line 2 of a.ts"; note $? "path:N: hits of a recursive grep are recorded per file"
post s21 Bash "$(bash_in "grep -n line3 a.ts sub/b.rb; grep -n b4 sub/b.rb")" '{"stdout":"3:const line3 = 3;\n4:def b4; end"}'
pre s21 Read "$(read_in "$A" 3 1)"
silent; note $? "bare N: lines with two numbered greps in one command are never attributed"

# --- tea-rags results
FS_OBJ=$(jq -cn --arg c "$(sed -n 3,12p "$A")" '[{type: "text", text: ({results: [{payload: {relativePath: "a.ts", symbolId: "line3", startLine: 3, endLine: 12, content: $c}}]} | tojson)}]')
post s8 mcp__tea-rags__find_symbol '{"symbol":"line3"}' "$FS_OBJ"
pre s8 Read "$(read_in "$A" 3 10)"
noted "lines 3–12 of a.ts" "find_symbol"; note $? "find_symbol body recorded → raw Read of its lines noted"
pre s8 mcp__tea-rags__find_symbol '{"symbol":"line3"}'
noted "line3" "lines 3–12 of a.ts"; note $? "find_symbol of a symbol already served → note"
FS_COL=$(jq -cn --arg c "$(sed -n 20,29p "$A")" '[{type: "text", text: ({results: {columns: ["payload.relativePath", "payload.startLine", "payload.endLine", "payload.content"], rows: [["a.ts", 20, 29, $c]]}} | tojson)}]')
post s9 mcp__tea-rags__semantic_search '{"query":"q"}' "$FS_COL"
pre s9 Bash "$(bash_in "sed -n 20,29p a.ts")"
noted "lines 20–29 of a.ts" "semantic_search"; note $? "columnar search rows with content are recorded"
META=$(jq -cn '[{type: "text", text: ({results: {columns: ["payload.relativePath", "payload.startLine", "payload.endLine", "payload.signature"], rows: [["a.ts", 1, 30, "const line1"]]}} | tojson)}]')
post s10 mcp__tea-rags__semantic_search '{"query":"q","metaOnly":true}' "$META"
pre s10 Read "$(read_in "$A")"
silent; note $? "metaOnly rows (no content) print no lines → nothing recorded"
OUTLINE=$(jq -cn '[{type: "text", text: ({results: [{payload: {relativePath: "a.ts", startLine: 1, endLine: 30, content: "line1\nline2"}}]} | tojson)}]')
post s11 mcp__tea-rags__find_symbol '{"relativePath":"a.ts"}' "$OUTLINE"
pre s11 Read "$(read_in "$A")"
silent; note $? "an outline (content far shorter than its range) prints no lines → nothing recorded"

# --- invalidation
post s12 Read "$(read_in "$A")"
post s12 Edit "$(jq -cn --arg f "$A" '{file_path: $f, old_string: "a", new_string: "b"}')" '{}'
pre s12 Read "$(read_in "$A")"
silent; note $? "Edit drops the file's entries"
post s13 Read "$(read_in "$A")"
post s13 Bash "$(bash_in "sed -i '' 's/x/y/' a.ts")" '{"stdout":""}'
pre s13 Read "$(read_in "$A")"
silent; note $? "Bash sed -i drops the file's entries"
post s14 Read "$(read_in "$A")"
post s14 Bash "$(bash_in "printf x >> a.ts")" '{"stdout":""}'
pre s14 Read "$(read_in "$A")"
silent; note $? "Bash redirect into the file drops its entries"
post s15 Read "$(read_in "$REPO/sub/b.rb")"
echo "def extra; end" >> "$REPO/sub/b.rb"
pre s15 Read "$(read_in "$REPO/sub/b.rb")"
silent; note $? "a file changed on disk (size / mtime) is never noted"

# --- turns, compaction
run '{"hook_event_name":"UserPromptSubmit","session_id":"s16","prompt":"p"}'
post s16 Read "$(read_in "$A" 1 5)"
run '{"hook_event_name":"UserPromptSubmit","session_id":"s16","prompt":"p"}'
silent; note $? "UserPromptSubmit answers nothing"
pre s16 Read "$(read_in "$A" 1 5)"
noted "turn 1, Read"; note $? "the note names the turn the lines were returned in"
run '{"hook_event_name":"SessionStart","session_id":"s16","source":"compact"}'
pre s16 Read "$(read_in "$A" 1 5)"
silent; note $? "compaction drops the session ledger (the lines left the context)"

# --- Read results, Claude Code's PostToolUse shape: tool_response.file
read_out() { # <file> [startLine] [numLines] — the tool_response Claude Code sends for a Read
  local total; total=$(wc -l < "$1" | tr -d ' ')
  jq -cn --arg f "$1" --arg c "$(cat "$1")" --argjson s "${2:-1}" --argjson n "${3:-$total}" --argjson t "$total" \
    '{type: "text", file: {filePath: $f, content: $c, numLines: $n, startLine: $s, totalLines: $t}}'
}
post s30 Read "$(read_in "$A")" "$(read_out "$A")"
post s30 Bash "$(bash_in "grep -n line10 a.ts")" '{"stdout":"10:const line10 = 10;"}'
pre s30 Read "$(read_in "$A")"
noted "lines 1–30 of a.ts already returned (turn 1, Read)"; note $? "a later grep inside a Read range keeps the range labelled Read"
post s31 Read "$(read_in "$A")" "$(read_out "$A")"
FS_BODY=$(jq -cn --arg c "$(sed -n 20,29p "$A")" '[{type: "text", text: ({results: [{payload: {relativePath: "a.ts", symbolId: "line20", startLine: 20, endLine: 29, content: $c}}]} | tojson)}]')
post s31 mcp__tea-rags__find_symbol '{"symbol":"line20"}' "$FS_BODY"
pre s31 Bash "$(bash_in "sed -n 1,12p a.ts")"
noted "lines 1–12 of a.ts already returned (turn 1, Read)"; note $? "whole-file Read, then find_symbol bodies → sed of the head is noted as Read"
post s32 Read "$(read_in "$A" 5 10)" "$(read_out "$A" 5 10)"
pre s32 Read "$(read_in "$A" 5 10)"
noted "lines 5–14 of a.ts" "Read"; note $? "tool_response.file startLine/numLines give the printed range"
pre s32 Read "$(read_in "$A" 15 10)"
silent; note $? "lines past the printed range are not noted"
post s33 Bash "$(bash_in "grep -n line10 a.ts")" '{"stdout":"10:const line10 = 10;"}'
post s33 Read "$(read_in "$A")" "$(read_out "$A")"
pre s33 Read "$(read_in "$A")"
noted "lines 1–30 of a.ts already returned (turn 1, Read)"; note $? "a Read covering an earlier grep line relabels it Read"

# --- indexed-source nudge: a raw read of an indexed source file → find_symbol(relativePath:)
mkdir -p "$REPO/config" "$REPO/db/migrate" "$REPO/spec"
echo "x: 1" > "$REPO/config/app.yml"; echo "Rails.application.configure do; end" > "$REPO/config/app.rb"
echo "class CreateOrders; end" > "$REPO/db/migrate/001_create_orders.rb"; echo "describe A do; end" > "$REPO/spec/a_spec.rb"
export FAKE_OUT='{"indexed":true,"project":"p","collectionName":"c","relativePath":"a.ts"}'
NUDGE='a.ts is indexed source — find_symbol(relativePath: "a.ts") returns it'
run '{"hook_event_name":"UserPromptSubmit","session_id":"s40","prompt":"p"}'
pre s40 Read "$(read_in "$A")"
noted "$NUDGE" "full text ≤150 lines, else an outline to drill" "several files → ONE find_symbol(symbols:[…])"; note $? "Read of an indexed source file → one nudge line, never a decision"
pre s40 Read "$(read_in "$A" 3 4)"
silent; note $? "the nudge fires once per file per turn"
run '{"hook_event_name":"UserPromptSubmit","session_id":"s40","prompt":"p"}'
pre s40 Bash "$(bash_in "sed -n 3,9p a.ts")"
noted "$NUDGE"; note $? "next turn, a Bash sed of the same file → nudged again"
pre s41 Bash "$(bash_in "cat a.ts | head -20")"
noted "$NUDGE"; note $? "Bash cat of an indexed source file → nudge"
pre s42 Bash "$(bash_in "grep -n line3 a.ts")"
silent; note $? "a grep is a search, not a read → no nudge"
pre s43 Read "$(read_in "$REPO/config/app.rb")"
silent; note $? "config/ (zone the core routes to the read tool) → no nudge"
pre s43 Bash "$(bash_in "cat db/migrate/001_create_orders.rb")"
silent; note $? "a migration → no nudge"
pre s43 Read "$(read_in "$REPO/spec/a_spec.rb")"
silent; note $? "a spec → no nudge"
pre s43 Read "$(read_in "$REPO/config/app.yml")"
silent; note $? "a data file → no nudge"
export FAKE_OUT='{"indexed":false}'
pre s44 Read "$(read_in "$A")"
silent; note $? "a file outside the index → no nudge"
export FAKE_OUT='{"indexed":true,"project":"p","collectionName":"c","relativePath":"a.ts"}'
OUT=$(printf '%s' "$(event PreToolUse s45 Read "$(read_in "$A")")" | TEA_RAGS_BIN="$FAKEBIN/none" TEA_RAGS_HOOK_STATE_DIR="$STATE" node "$HOOK" 2>/dev/null); CODE=$?
[ "$CODE" = 0 ] && ! printf '%s' "$OUT" | grep -qF 'indexed source'; note $? "TEA_RAGS_BIN names no binary → no nudge, fail open"
post s46 Read "$(read_in "$A")" "$(read_out "$A")"
pre s46 Read "$(read_in "$A")"
noted "already returned"; note $? "lines already held → the re-read note"
! context | grep -qF "indexed source"; note $? "… and no nudge beside it"
rm -f "$FAKEBIN/calls.log"
pre s47 Read "$(read_in "$A")"; pre s47 Read "$(read_in "$A")"
[ "$(wc -l < "$FAKEBIN/calls.log" | tr -d ' ')" = 1 ]; note $? "the index lookup runs once per file per turn (cached)"
# The nudge and search-drift's streak deny never fire on the same call, whichever hook runs first.
DRIFT="$ROOT/plugins/tea-rags/scripts/search-drift.sh"
both_hooks() { # <sid> <order: drift-first|ledger-first> → DENY (0/1), NUDGED (0/1)
  local json; json=$(event PreToolUse "$1" Read "$(read_in "$A")")
  local d l
  if [ "$2" = drift-first ]; then
    d=$(printf '%s' "$json" | TEA_RAGS_BIN="$FAKEBIN/tea-rags" TEA_RAGS_HOOK_NOW=5000 TEA_RAGS_HOOK_STATE_DIR="$STATE" bash "$DRIFT" --harness claude 2>/dev/null)
    l=$(printf '%s' "$json" | TEA_RAGS_BIN="$FAKEBIN/tea-rags" TEA_RAGS_HOOK_NOW=5000 TEA_RAGS_HOOK_STATE_DIR="$STATE" node "$HOOK" 2>/dev/null)
  else
    l=$(printf '%s' "$json" | TEA_RAGS_BIN="$FAKEBIN/tea-rags" TEA_RAGS_HOOK_NOW=5000 TEA_RAGS_HOOK_STATE_DIR="$STATE" node "$HOOK" 2>/dev/null)
    d=$(printf '%s' "$json" | TEA_RAGS_BIN="$FAKEBIN/tea-rags" TEA_RAGS_HOOK_NOW=5000 TEA_RAGS_HOOK_STATE_DIR="$STATE" bash "$DRIFT" --harness claude 2>/dev/null)
  fi
  DENY=0; NUDGED=0
  printf '%s' "$d" | grep -qF '"permissionDecision": "deny"' && DENY=1
  printf '%s' "$l" | grep -qF 'indexed source' && NUDGED=1
  return 0
}
for order in drift-first ledger-first; do
  overlap=0 denies=0 nudges=0
  for i in 1 2 3 4 5 6; do
    run "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"dn-$order\",\"prompt\":\"p\"}"
    both_hooks "dn-$order" "$order"
    [ "$DENY" = 1 ] && [ "$NUDGED" = 1 ] && overlap=$((overlap + 1))
    denies=$((denies + DENY)); nudges=$((nudges + NUDGED))
  done
  [ "$overlap" = 0 ] && [ "$denies" -ge 1 ] && [ "$nudges" -ge 1 ]
  note $? "$order: search-drift deny and the nudge never on the same call (denies=$denies nudges=$nudges overlap=$overlap)"
done
export FAKE_OUT='{"indexed":false}'

# --- bounded state, fail-open
for i in $(seq 1 20); do post s17 Read "$(read_in "$A" "$i" 1)"; done
[ "$(du -sk "$STATE" | cut -f1)" -lt 200 ]; note $? "state stays small"
LEDGER_RANGES=$(cat "$STATE"/reread-claude-s17/* 2>/dev/null | jq -s '[.[] | select(.ranges) | .ranges | length] | max // 0')
[ "$LEDGER_RANGES" -le 16 ]; note $? "a file keeps at most 16 ranges (adjacent ones merge)"
run 'not json'
silent; note $? "unparsable input fails open"
run '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/nope"}}'
silent; note $? "no session id fails open"
pre s18 Read "$(read_in "$REPO/missing.ts")"
silent; note $? "a missing file is never noted"

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
