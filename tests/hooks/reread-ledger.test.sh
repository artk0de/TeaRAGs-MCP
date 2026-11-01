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
# big.ts: above find_symbol's full-text threshold (150 lines), so a raw read of it still earns
# the whole-file nudge; a.ts (30 lines) is returned whole by find_symbol and is never nudged.
for i in $(seq 1 200); do echo "const big$i = $i;"; done > "$REPO/big.ts"

# Fake `tea-rags`: `project indexed …` prints $FAKE_OUT (default: not indexed) and
# exits like the real one (0 indexed, 1 not); every call is logged to calls.log.
# `call find_symbol <json> …` prints $FAKE_OUTLINE (the batched outline answer) and
# logs its JSON argument to outline.log.
cat > "$FAKEBIN/tea-rags" <<'EOF'
#!/usr/bin/env bash
if [ "$1 $2" = "call find_symbol" ]; then
  echo "$3" >> "$(dirname "$0")/outline.log"
  printf '%s\n' "${FAKE_OUTLINE:-{\"results\":[]\}}"
  exit 0
fi
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
read_out() { # <file> [startLine] [numLines] — actual content and range delivered by Read
  local total start count end; total=$(wc -l < "$1" | tr -d ' ')
  start=${2:-1}; count=${3:-$total}; end=$((start + count - 1))
  jq -cn --arg f "$1" --arg c "$(sed -n "${start},${end}p" "$1")" --argjson s "$start" --argjson n "$count" --argjson t "$total" \
    '{type: "text", file: {filePath: $f, content: $c, numLines: $n, startLine: $s, totalLines: $t}}'
}
shell_out() { jq -cn --arg o "$1" '{stdout: $o, stderr: "", exit_code: 0}'; }

# --- Read → Read
post s1 Read "$(read_in "$A")" "$(read_out "$A")"
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
post s3 Read "$(read_in "$A" 1 10)" "$(read_out "$A" 1 10)"
pre s3 Read "$(read_in "$A" 1 30)"
silent; note $? "10 of 30 lines served → no note (< 80%)"
post s3 Read "$(read_in "$A" 11 15)" "$(read_out "$A" 11 15)"
pre s3 Read "$(read_in "$A" 1 30)"
noted "of a.ts"; note $? "union of two reads covers 25 of 30 lines → note (≥ 80%)"

# --- Bash reads
post s4 Bash "$(bash_in "sed -n '5,20p' a.ts")" "$(shell_out "$(sed -n 5,20p "$A")")"
pre s4 Read "$(read_in "$A" 5 16)"
noted "lines 5–20 of a.ts" "Bash"; note $? "sed -n A,Bp recorded → Read of the same lines noted"
pre s4 Bash "$(bash_in "sed -n 6,18p $A")"
noted "lines 6–18 of a.ts"; note $? "absolute path, unquoted script → same file"
post s5 Bash "$(bash_in "cd sub && cat b.rb | grep -v '^\\s*\$'")" "$(shell_out "$(cat "$REPO/sub/b.rb")")"
pre s5 Read "$(read_in "$REPO/sub/b.rb")"
noted "lines 1–12 of sub/b.rb"; note $? "cd + cat piped through a blank-line filter is a whole-file read"
post s6 Bash "$(bash_in "cat a.ts | grep line1")" '{"stdout":"x"}'
pre s6 Read "$(read_in "$A")"
silent; note $? "cat piped into a pattern grep is a search, not a read"
post s7 Bash "$(bash_in "head -n 25 a.ts")" "$(shell_out "$(head -n 25 "$A")")"
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
post s12 Read "$(read_in "$A")" "$(read_out "$A")"
post s12 Edit "$(jq -cn --arg f "$A" '{file_path: $f, old_string: "a", new_string: "b"}')" '{}'
pre s12 Read "$(read_in "$A")"
silent; note $? "Edit drops the file's entries"
post s13 Read "$(read_in "$A")" "$(read_out "$A")"
post s13 Bash "$(bash_in "sed -i '' 's/x/y/' a.ts")" '{"stdout":""}'
pre s13 Read "$(read_in "$A")"
silent; note $? "Bash sed -i drops the file's entries"
post s14 Read "$(read_in "$A")" "$(read_out "$A")"
post s14 Bash "$(bash_in "printf x >> a.ts")" '{"stdout":""}'
pre s14 Read "$(read_in "$A")"
silent; note $? "Bash redirect into the file drops its entries"
post s15 Read "$(read_in "$REPO/sub/b.rb")" "$(read_out "$REPO/sub/b.rb")"
echo "def extra; end" >> "$REPO/sub/b.rb"
pre s15 Read "$(read_in "$REPO/sub/b.rb")"
silent; note $? "a file changed on disk (size / mtime) is never noted"

# --- turns, compaction
run '{"hook_event_name":"UserPromptSubmit","session_id":"s16","prompt":"p"}'
post s16 Read "$(read_in "$A" 1 5)" "$(read_out "$A" 1 5)"
run '{"hook_event_name":"UserPromptSubmit","session_id":"s16","prompt":"p"}'
silent; note $? "UserPromptSubmit answers nothing"
pre s16 Read "$(read_in "$A" 1 5)"
noted "turn 1, Read"; note $? "the note names the turn the lines were returned in"
run '{"hook_event_name":"SessionStart","session_id":"s16","source":"compact"}'
pre s16 Read "$(read_in "$A" 1 5)"
silent; note $? "compaction drops the session ledger (the lines left the context)"

# --- Read results, Claude Code's PostToolUse shape: tool_response.file
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

# --- delivery evidence: a requested file or range is never proof that its lines arrived
for response in null '{}' '{"isError":true}' '{"error":"Read blocked"}' '{"file":{"startLine":1,"numLines":30}}'; do
  post "delivery-read-$response" Read "$(read_in "$A")" "$response"
  pre "delivery-read-$response" Read "$(read_in "$A")"
  silent; note $? "Read without successful delivered content establishes no coverage: $response"
done
READ_PART=$(jq -cn --arg c "$(sed -n 1p "$A")" '{file:{startLine:1,numLines:30,content:$c}}')
post delivery-part Read "$(read_in "$A")" "$READ_PART"
pre delivery-part Read "$(read_in "$A" 1 1)"
noted "line 1 of a.ts"; note $? "partial Read records its delivered line"
pre delivery-part Read "$(read_in "$A" 2 29)"
silent; note $? "partial Read never claims the requested but undelivered tail"
READ_ERROR=$(read_out "$A" | jq '. + {isError:true}')
post delivery-read-error Read "$(read_in "$A")" "$READ_ERROR"
pre delivery-read-error Read "$(read_in "$A")"
silent; note $? "an error response with plausible Read metadata still establishes no coverage"
for response in null '{"stdout":""}' '{"stdout":"command blocked by policy"}' '{"stdout":"","exit_code":1}'; do
  post "delivery-shell-$response" Bash "$(bash_in 'cat a.ts')" "$response"
  pre "delivery-shell-$response" Read "$(read_in "$A")"
  silent; note $? "shell request without source output establishes no coverage: $response"
done
SHELL_ERROR=$(shell_out "$(cat "$A")" | jq '. + {exit_code:1}')
post delivery-shell-error Bash "$(bash_in 'cat a.ts')" "$SHELL_ERROR"
pre delivery-shell-error Read "$(read_in "$A")"
silent; note $? "a failed shell command cannot establish coverage even with plausible stdout"
post delivery-shell-part Bash "$(bash_in 'cat a.ts')" "$(shell_out "$(sed -n 1p "$A")")"
pre delivery-shell-part Read "$(read_in "$A" 1 1)"
noted "line 1 of a.ts"; note $? "partial shell output records its delivered source line"
pre delivery-shell-part Read "$(read_in "$A" 2 29)"
silent; note $? "partial shell output never claims the unprinted tail"
MCP_ERROR=$(jq -cn --argjson c "$FS_OBJ" '{isError:true,content:$c}')
post delivery-mcp-error mcp__tea-rags__find_symbol '{"symbol":"line3"}' "$MCP_ERROR"
pre delivery-mcp-error Read "$(read_in "$A" 3 10)"
silent; note $? "an outer MCP error envelope establishes no coverage"
SHORT_OUTLINE=$(jq -cn --arg c "$(sed -n 1,3p "$A")" '[{type:"text",text:({results:[{payload:{relativePath:"a.ts",kind:"outline",startLine:1,endLine:3,content:$c}}]}|tojson)}]')
post delivery-outline mcp__tea-rags__find_symbol '{"relativePath":"a.ts"}' "$SHORT_OUTLINE"
pre delivery-outline Read "$(read_in "$A" 1 3)"
silent; note $? "an explicit outline is not a body even when its line count fits the span"
HEADER=$(jq -cn --arg c "$(sed -n 1,3p "$A")" '[{type:"text",text:({results:[{payload:{relativePath:"a.ts",symbolId:"Class",kind:"containerHeader",startLine:1,endLine:30,content:("Class\n  Class#method\n── header 1–3 ──\n"+$c)}}]}|tojson)}]')
post delivery-header mcp__tea-rags__find_symbol '{"symbol":"Class"}' "$HEADER"
pre delivery-header Read "$(read_in "$A" 1 3)"
noted "lines 1–3 of a.ts"; note $? "containerHeader records only the actual delivered header source"
pre delivery-header Read "$(read_in "$A" 4 1)"
silent; note $? "containerHeader outline never establishes coverage for a method body"
pre delivery-header mcp__tea-rags__find_symbol '{"symbol":"Class"}'
silent; note $? "containerHeader never marks the complete class symbol as already served"
BAD_GREP='{"stdout":"1:not the source line"}'
post delivery-grep Bash "$(bash_in 'grep -n line1 a.ts')" "$BAD_GREP"
pre delivery-grep Read "$(read_in "$A" 1 1)"
silent; note $? "numbered grep coordinates without matching source text establish no coverage"
STRUCTURED=$(jq -cn --arg c "$(sed -n 3,12p "$A")" '{content:[{type:"text",text:"Body shown in full"}],structuredContent:{results:{columns:["payload.relativePath","payload.startLine","payload.endLine","payload.content"],rows:[["a.ts",3,12,$c]]}}}')
post delivery-structured mcp__tea-rags__find_symbol '{"symbol":"line3"}' "$STRUCTURED"
pre delivery-structured Read "$(read_in "$A" 3 10)"
noted "lines 3–12 of a.ts"; note $? "structuredContent proves delivered source beside a non-JSON banner"
SHORT_HEADER=$(jq -cn --arg c "$(sed -n 1,2p "$A")" '{structuredContent:{results:[{payload:{relativePath:"a.ts",kind:"containerHeader",symbolId:"Short",startLine:1,endLine:3,content:("Short\n  Short#method\n── header 1–2 ──\n"+$c)}}]}}')
post delivery-short-header mcp__tea-rags__find_symbol '{"symbol":"Short"}' "$SHORT_HEADER"
pre delivery-short-header Read "$(read_in "$A" 1 2)"
noted "lines 1–2 of a.ts"; note $? "short containerHeader preserves its actual header data"
pre delivery-short-header Read "$(read_in "$A" 3 1)"
silent; note $? "a short containerHeader outline is not a method body even when line counts fit"
pre delivery-short-header mcp__tea-rags__find_symbol '{"symbol":"Short"}'
silent; note $? "a short header never establishes complete class coverage"
printf 'class Service\n  HEAD = 1\n  def call\n    :body\n  end\nend\n' > "$REPO/class.rb"
REPEATED_END='{"structuredContent":{"results":[{"payload":{"relativePath":"class.rb","kind":"containerHeader","startLine":1,"endLine":6,"content":"Service\n  Service#call\n── header 6–6 ──\nend"}}]}}'
post delivery-header-end mcp__tea-rags__find_symbol '{"symbol":"Service"}' "$REPEATED_END"
pre delivery-header-end Read "$(read_in "$REPO/class.rb" 6 1)"
noted "line 6 of class.rb"; note $? "header span disambiguates a repeated end line"
pre delivery-header-end Read "$(read_in "$REPO/class.rb" 5 1)"
silent; note $? "a header end cannot be attributed to a method end with the same source text"
REFERENCED='{"structuredContent":{"results":[{"payload":{"relativePath":"class.rb","symbolId":"Service#call","startLine":3,"endLine":5,"content":"  def call\n    :body\n  end","referencedDefinitions":[{"symbolId":"Service::HEAD","startLine":2,"endLine":2,"text":"  HEAD = 1"},{"symbolId":"Service::MISSING","startLine":1,"endLine":1}]}}]}}'
post delivery-referenced mcp__tea-rags__find_symbol '{"symbol":"Service#call"}' "$REFERENCED"
pre delivery-referenced Read "$(read_in "$REPO/class.rb" 2 1)"
noted "line 2 of class.rb"; note $? "a method row's referencedDefinitions text records its definition lines as served"
pre delivery-referenced Read "$(read_in "$REPO/class.rb" 1 1)"
silent; note $? "a referenced definition named without text records nothing"

# --- indexed-source nudge: a raw read of an indexed source file → find_symbol(relativePath:)
mkdir -p "$REPO/config" "$REPO/db/migrate" "$REPO/spec"
echo "x: 1" > "$REPO/config/app.yml"; echo "Rails.application.configure do; end" > "$REPO/config/app.rb"
echo "class CreateOrders; end" > "$REPO/db/migrate/001_create_orders.rb"; echo "describe A do; end" > "$REPO/spec/a_spec.rb"
BIG="$REPO/big.ts"
export FAKE_OUT='{"indexed":true,"project":"p","collectionName":"c","relativePath":"big.ts"}'
NUDGE='big.ts is indexed source — find_symbol(relativePath: "big.ts") returns it'
run '{"hook_event_name":"UserPromptSubmit","session_id":"s40","prompt":"p"}'
pre s40 Read "$(read_in "$BIG")"
noted "$NUDGE" "full text ≤150 lines or ≤9000 chars, else an outline to drill" "several files → ONE find_symbol(symbols:[…])"; note $? "Read of an indexed source file → one nudge line, never a decision"
pre s40 Read "$(read_in "$BIG" 3 4)"
silent; note $? "the nudge fires once per file per turn"
run '{"hook_event_name":"UserPromptSubmit","session_id":"s40","prompt":"p"}'
pre s40 Bash "$(bash_in "sed -n 3,9p big.ts")"
noted "$NUDGE"; note $? "next turn, a Bash sed of the same file → nudged again"
pre s41 Bash "$(bash_in "cat big.ts | head -20")"
noted "$NUDGE"; note $? "Bash cat of an indexed source file → nudge"
pre s42 Bash "$(bash_in "grep -n big3 big.ts")"
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
pre s44 Read "$(read_in "$BIG")"
silent; note $? "a file outside the index → no nudge"
export FAKE_OUT='{"indexed":true,"project":"p","collectionName":"c","relativePath":"big.ts"}'
OUT=$(printf '%s' "$(event PreToolUse s45 Read "$(read_in "$BIG")")" | TEA_RAGS_BIN="$FAKEBIN/none" TEA_RAGS_HOOK_STATE_DIR="$STATE" node "$HOOK" 2>/dev/null); CODE=$?
[ "$CODE" = 0 ] && ! printf '%s' "$OUT" | grep -qF 'indexed source'; note $? "TEA_RAGS_BIN names no binary → no nudge, fail open"
post s46 Read "$(read_in "$BIG")" "$(read_out "$BIG")"
pre s46 Read "$(read_in "$BIG")"
noted "already returned"; note $? "lines already held → the re-read note"
! context | grep -qF "indexed source"; note $? "… and no nudge beside it"
rm -f "$FAKEBIN/calls.log"
pre s47 Read "$(read_in "$BIG")"; pre s47 Read "$(read_in "$BIG")"
[ "$(wc -l < "$FAKEBIN/calls.log" | tr -d ' ')" = 1 ]; note $? "the index lookup runs once per file per turn (cached)"
# A file find_symbol returns whole (≤150 lines) gains nothing from the whole-file nudge, and a
# whole read of it needs no index lookup at all.
export FAKE_OUT='{"indexed":true,"project":"p","collectionName":"c","relativePath":"a.ts"}'
rm -f "$FAKEBIN/calls.log"
pre s48 Read "$(read_in "$A")"
silent; note $? "whole Read of a 30-line indexed file → no nudge"
[ ! -s "$FAKEBIN/calls.log" ]; note $? "… and no \`tea-rags project indexed\` spawn"
pre s48 Bash "$(bash_in "cat a.ts")"
silent && [ ! -s "$FAKEBIN/calls.log" ]; note $? "whole cat of a 30-line indexed file → no nudge, no spawn"
export FAKE_OUT='{"indexed":true,"project":"p","collectionName":"c","relativePath":"big.ts"}'
# Reads are never denied (owner decision, bd tea-rags-mcp-nxg76): search-drift stays silent on a
# read streak, and the ledger's nudge fires on read 3 and every later turn.
DRIFT="$ROOT/plugins/tea-rags/scripts/search-drift.sh"
both_hooks() { # <sid> <order: drift-first|ledger-first> [json] → DENY (0/1), NUDGED (0/1), DRIFT_OUT
  local json; json=${3:-$(event PreToolUse "$1" Read "$(read_in "$BIG")")}
  local d l
  if [ "$2" = drift-first ]; then
    d=$(printf '%s' "$json" | TEA_RAGS_BIN="$FAKEBIN/tea-rags" TEA_RAGS_HOOK_NOW=5000 TEA_RAGS_HOOK_STATE_DIR="$STATE" bash "$DRIFT" --harness claude 2>/dev/null)
    l=$(printf '%s' "$json" | TEA_RAGS_BIN="$FAKEBIN/tea-rags" TEA_RAGS_HOOK_NOW=5000 TEA_RAGS_HOOK_STATE_DIR="$STATE" node "$HOOK" 2>/dev/null)
  else
    l=$(printf '%s' "$json" | TEA_RAGS_BIN="$FAKEBIN/tea-rags" TEA_RAGS_HOOK_NOW=5000 TEA_RAGS_HOOK_STATE_DIR="$STATE" node "$HOOK" 2>/dev/null)
    d=$(printf '%s' "$json" | TEA_RAGS_BIN="$FAKEBIN/tea-rags" TEA_RAGS_HOOK_NOW=5000 TEA_RAGS_HOOK_STATE_DIR="$STATE" bash "$DRIFT" --harness claude 2>/dev/null)
  fi
  DENY=0; NUDGED=0; DRIFT_OUT="$d"
  printf '%s' "$d" | grep -qF '"permissionDecision": "deny"' && DENY=1
  printf '%s' "$l" | grep -qF 'indexed source' && NUDGED=1
  return 0
}
for order in drift-first ledger-first; do
  denies=0 nudges=0 drift_said=0 third=0
  for i in 1 2 3 4 5 6; do
    run "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"rd-$order\",\"prompt\":\"p\"}"
    both_hooks "rd-$order" "$order"
    denies=$((denies + DENY)); nudges=$((nudges + NUDGED))
    [ -n "$DRIFT_OUT" ] && drift_said=$((drift_said + 1))
    [ "$i" = 3 ] && third=$NUDGED
  done
  [ "$denies" = 0 ] && [ "$drift_said" = 0 ] && [ "$third" = 1 ] && [ "$nudges" = 6 ]
  note $? "$order: a read streak is never denied, search-drift says nothing, the ledger nudges read 3 and every turn (denies=$denies drift=$drift_said nudges=$nudges)"
done
# A search deny still wins: a Bash call that is a ledger read (nl) AND a concept search is never
# nudged on the call search-drift denies, whichever hook runs first.
for order in drift-first ledger-first; do
  overlap=0 denies=0 nudges=0
  for i in 1 2 3 4 5 6; do
    run "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"dn-$order\",\"prompt\":\"p\"}"
    both_hooks "dn-$order" "$order" "$(event PreToolUse "dn-$order" Bash "$(bash_in "nl big.ts && rg -n 'retry|backoff' src")")"
    [ "$DENY" = 1 ] && [ "$NUDGED" = 1 ] && overlap=$((overlap + 1))
    denies=$((denies + DENY)); nudges=$((nudges + NUDGED))
  done
  [ "$overlap" = 0 ] && [ "$denies" -ge 1 ] && [ "$nudges" -ge 1 ]
  note $? "$order: search-drift search deny and the nudge never on the same call (denies=$denies nudges=$nudges overlap=$overlap)"
done
# A zone word in the checkout path never exempts a source read from the nudge.
ZREPO="$(mktemp -d)/test/repo"; mkdir -p "$ZREPO/src"; cp "$BIG" "$ZREPO/src/a.ts"
export FAKE_OUT='{"indexed":true,"project":"p","collectionName":"c","relativePath":"src/a.ts"}'
run "$(jq -cn --arg f "$ZREPO/src/a.ts" --arg c "$ZREPO" '{hook_event_name:"PreToolUse",session_id:"zw",cwd:$c,tool_name:"Read",tool_input:{file_path:$f}}')"
noted 'src/a.ts is indexed source'; note $? "a zone word in the cwd (…/test/repo) does not exempt a source read from the nudge"
export FAKE_OUT='{"indexed":true,"project":"p","collectionName":"c","relativePath":"a.ts"}'
export FAKE_OUT='{"indexed":false}'

# --- bounded state, fail-open
for i in $(seq 1 20); do post s17 Read "$(read_in "$A" "$i" 1)" "$(read_out "$A" "$i" 1)"; done
[ "$(du -sk "$STATE/reread-claude-s17" | cut -f1)" -lt 200 ]; note $? "a session's state stays small"
LEDGER_RANGES=$(cat "$STATE"/reread-claude-s17/* 2>/dev/null | jq -s '[.[] | select(.ranges) | .ranges | length] | max // 0')
[ "$LEDGER_RANGES" -le 16 ]; note $? "a file keeps at most 16 ranges (adjacent ones merge)"
run 'not json'
silent; note $? "unparsable input fails open"
run '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/nope"}}'
silent; note $? "no session id fails open"
pre s18 Read "$(read_in "$REPO/missing.ts")"
silent; note $? "a missing file is never noted"

# --- Codex and Cursor: the same script, shipped verbatim, `--harness codex|cursor`.
# Payload shapes and channels (docs/superpowers/specs/2026-10-23-harness-facts.md §A.4 / §B.3):
#   codex-cli 0.162.1 — PreToolUse / PostToolUse stdin {hook_event_name, session_id, cwd, tool_name,
#     tool_input (+tool_response)}; a shell call is tool_name exec_command|shell|Bash with
#     tool_input.command a string or an argv array ([bash, -lc, <code>]) and an optional workdir;
#     PreToolUseHookSpecificOutputWire carries additionalContext (schema embedded in the binary).
#   cursor-agent 2026.10.22 — preToolUse stdin {hook_event_name, conversation_id, workspace_roots,
#     tool_name, tool_input, tool_use_id}; Shell tool_input {command, cwd}, Read tool_input {file_path};
#     postToolUse adds tool_output (a JSON string); preToolUse / postToolUse answers may carry
#     additional_context (HOOK_STEPS_SUPPORTING_ADDITIONAL_CONTEXT in the bundle); beforeSubmitPrompt
#     answers {"continue":true}.
harness_hook() { echo "$ROOT/harness/$1/tea-rags/scripts/reread-ledger.mjs"; }
hrun() { # <harness> <json> → OUT, CODE
  OUT=$(printf '%s' "$2" | TEA_RAGS_BIN="$FAKEBIN/tea-rags" TEA_RAGS_HOOK_STATE_DIR="$STATE" node "$(harness_hook "$1")" --harness "$1" 2>/dev/null)
  CODE=$?
}
hcontext() { # <harness> → the non-blocking note of the answer
  case "$1" in
    cursor) printf '%s' "$OUT" | jq -r '.additional_context // empty' 2>/dev/null ;;
    *) printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null ;;
  esac
}
hnoted() { # <harness> <substring…> — a note, never a decision
  local h="$1"; shift
  [ "$CODE" = 0 ] || return 1
  case "$h" in
    cursor) [ "$(printf '%s' "$OUT" | jq -r '.permission // empty')" = allow ] || return 1 ;;
    *) [ "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.hookEventName // empty')" = PreToolUse ] || return 1
       [ -z "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecision // empty')" ] || return 1 ;;
  esac
  local s; for s in "$@"; do hcontext "$h" | grep -qF -- "$s" || return 1; done
}
hquiet() { # <harness> — nothing to say: Codex prints nothing, Cursor a pass-through JSON
  [ "$CODE" = 0 ] && [ -z "$(hcontext "$1")" ] || return 1
  case "$1" in cursor) printf '%s' "$OUT" | jq -e . >/dev/null 2>&1 ;; *) [ -z "$OUT" ] ;; esac
}
shell_ev() { # <harness> <event: pre|post> <sid> <command>
  case "$1:$2" in
    codex:pre) jq -cn --arg s "$3" --arg c "$4" --arg cwd "$REPO" '{hook_event_name:"PreToolUse",session_id:$s,cwd:$cwd,tool_name:"exec_command",tool_input:{command:["bash","-lc",$c]}}' ;;
    codex:post) jq -cn --arg s "$3" --arg c "$4" --argjson r "${5:-$EMPTY}" --arg cwd "$REPO" '{hook_event_name:"PostToolUse",session_id:$s,cwd:$cwd,tool_name:"exec_command",tool_input:{command:["bash","-lc",$c]},tool_response:$r}' ;;
    cursor:pre) jq -cn --arg s "$3" --arg c "$4" --arg cwd "$REPO" '{hook_event_name:"preToolUse",conversation_id:$s,workspace_roots:[$cwd],tool_name:"Shell",tool_input:{command:$c,cwd:$cwd},tool_use_id:"t"}' ;;
    cursor:post) jq -cn --arg s "$3" --arg c "$4" --arg r "${5:-$EMPTY}" --arg cwd "$REPO" '{hook_event_name:"postToolUse",conversation_id:$s,workspace_roots:[$cwd],tool_name:"Shell",tool_input:{command:$c,cwd:$cwd},tool_output:$r,tool_use_id:"t"}' ;;
  esac
}
prompt_ev() { # <harness> <sid>
  case "$1" in
    cursor) jq -cn --arg s "$2" '{hook_event_name:"beforeSubmitPrompt",conversation_id:$s,prompt:"p"}' ;;
    *) jq -cn --arg s "$2" '{hook_event_name:"UserPromptSubmit",session_id:$s,prompt:"p"}' ;;
  esac
}
for H in codex cursor; do
  [ -f "$(harness_hook "$H")" ] || { note 1 "$H: ledger ships at $(harness_hook "$H")"; continue; }
  cmp -s "$HOOK" "$(harness_hook "$H")"; note $? "$H: ships the plugin's reread-ledger.mjs byte-identical"
  export FAKE_OUT='{"indexed":true,"project":"p","collectionName":"c","relativePath":"big.ts"}'
  hrun "$H" "$(prompt_ev "$H" h1)"
  case "$H" in cursor) [ "$(printf '%s' "$OUT" | jq -r '.continue // empty')" = true ] ;; *) [ -z "$OUT" ] ;; esac
  note $? "$H: the prompt event advances the turn, answers in the $H shape"
  hrun "$H" "$(shell_ev "$H" pre h1 "sed -n 1,30p big.ts")"
  hnoted "$H" "$NUDGE" "several files → ONE find_symbol(symbols:[…])"; note $? "$H: shell read of indexed source → find_symbol(relativePath:) nudge, non-blocking"
  hrun "$H" "$(shell_ev "$H" post h1 "sed -n 1,30p a.ts" "$(shell_out "$(cat "$A")")")"; hquiet "$H"; note $? "$H: the result is recorded silently"
  hrun "$H" "$(prompt_ev "$H" h1)"
  hrun "$H" "$(shell_ev "$H" pre h1 "cat a.ts")"
  hnoted "$H" "lines 1–30 of a.ts already returned (turn 1" "answer from them"; note $? "$H: a re-read a turn later → the re-read note"
  ! hcontext "$H" | grep -qF "indexed source"; note $? "$H: … and no nudge beside it"
  hrun "$H" "$(shell_ev "$H" post h-no-output 'cat a.ts')"
  hrun "$H" "$(shell_ev "$H" pre h-no-output 'cat a.ts')"
  ! hcontext "$H" | grep -qF "already returned"; note $? "$H: missing shell output never establishes coverage"
  [ -d "$STATE/reread-$H-h1" ]; note $? "$H: the ledger is keyed reread-$H-<session id>"
  # Reads are never denied: a streak gets one nudge per turn, never a decision.
  denies=0; nudges=0
  for i in 1 2 3 4; do
    hrun "$H" "$(prompt_ev "$H" h2)"
    hrun "$H" "$(shell_ev "$H" pre h2 "head -n 5 sub/b.rb && sed -n 2,4p big.ts")"
    printf '%s' "$OUT" | grep -qE '"(permissionDecision|permission)": *"deny"' && denies=$((denies + 1))
    hcontext "$H" | grep -qF "$NUDGE" && nudges=$((nudges + 1))
  done
  [ "$denies" = 0 ] && [ "$nudges" = 4 ]; note $? "$H: a read streak never yields a deny, the nudge fires every turn (nudges=$nudges)"
  hrun "$H" "$(shell_ev "$H" pre h3 "npm test 2>&1 | tail -5")"; hquiet "$H"; note $? "$H: a non-read shell command → no note"
  hrun "$H" 'not json'
  case "$H" in cursor) [ "$CODE" = 0 ] && printf '%s' "$OUT" | jq -e . >/dev/null 2>&1 ;; *) [ "$CODE" = 0 ] && [ -z "$OUT" ] ;; esac
  note $? "$H: unparsable input fails open"
done
# Codex: tool_input.workdir resolves the command's relative paths.
hrun codex "$(jq -cn --arg cwd "$(dirname "$REPO")" --arg w "$(basename "$REPO")" '{hook_event_name:"PreToolUse",session_id:"h4",cwd:$cwd,tool_name:"shell",tool_input:{command:"cat big.ts",workdir:$w}}')"
hnoted codex "$NUDGE"; note $? "codex: workdir relative to cwd locates the read file"
# Cursor: a Read is noted at preToolUse (Read {file_path}); its result is not recorded — the hook
# input carries no line range, so a partial read would be recorded as the whole file.
hrun cursor "$(jq -cn --arg f "$BIG" --arg cwd "$REPO" '{hook_event_name:"preToolUse",conversation_id:"h5",workspace_roots:[$cwd],tool_name:"Read",tool_input:{file_path:$f},tool_use_id:"t"}')"
hnoted cursor "$NUDGE"; note $? "cursor: Read of indexed source → nudge as additional_context"
hrun cursor "$(jq -cn --arg f "$BIG" --arg cwd "$REPO" '{hook_event_name:"postToolUse",conversation_id:"h5",workspace_roots:[$cwd],tool_name:"Read",tool_input:{file_path:$f},tool_output:"{}",tool_use_id:"t"}')"
hrun cursor "$(prompt_ev cursor h5)"
hrun cursor "$(jq -cn --arg f "$BIG" --arg cwd "$REPO" '{hook_event_name:"preToolUse",conversation_id:"h5",workspace_roots:[$cwd],tool_name:"Read",tool_input:{file_path:$f},tool_use_id:"t"}')"
! hcontext cursor | grep -qF "already returned"; note $? "cursor: a Read result is never recorded (no range in the hook input)"
# Cursor: afterMCPExecution {tool_name, mcp_server_name, tool_input: <JSON string>, result_json: <JSON
# string of the MCP CallToolResult {content: [{type, text}]}>} — the bundle stringifies the call result.
CTR=$(jq -cn --arg c "$(sed -n 3,12p "$A")" '{content: [{type: "text", text: ({results: [{payload: {relativePath: "a.ts", symbolId: "line3", startLine: 3, endLine: 12, content: $c}}]} | tojson)}]}')
hrun cursor "$(jq -cn --arg cwd "$REPO" --arg r "$CTR" '{hook_event_name:"afterMCPExecution",conversation_id:"h6",workspace_roots:[$cwd],tool_name:"find_symbol",mcp_server_name:"tea-rags",tool_input:"{\"symbol\":\"line3\"}",result_json:$r}')"
hquiet cursor; note $? "cursor: afterMCPExecution records silently"
hrun cursor "$(shell_ev cursor pre h6 "sed -n 3,12p a.ts")"
hnoted cursor "lines 3–12 of a.ts" "find_symbol"; note $? "cursor: a tea-rags body recorded at afterMCPExecution → raw sed of its lines noted"
# Codex: PostToolUse(mcp__tea_rags__find_symbol) — code mode's identifier spelling; tool_response read
# as the MCP result (content blocks), the same parse as Claude's.
hrun codex "$(jq -cn --arg cwd "$REPO" --argjson r "$FS_OBJ" '{hook_event_name:"PostToolUse",session_id:"h7",cwd:$cwd,tool_name:"mcp__tea_rags__find_symbol",tool_input:{symbol:"line3"},tool_response:$r}')"
hrun codex "$(shell_ev codex pre h7 "sed -n 3,12p a.ts")"
hnoted codex "lines 3–12 of a.ts" "find_symbol"; note $? "codex: a code-mode tea-rags body is recorded → raw sed of its lines noted"
export FAKE_OUT='{"indexed":false}'

# --- Outline ids (bd tea-rags-mcp-9f0yn.4/.5): a partial read of indexed source names the outline
# ids whose ` L<start>-<end>` covers it; a grep hit names its enclosing ids. Outline contract:
# a member line ends in ` L<a>-<b>` after an optional ` (visibility)`; declaration-only ids carry
# no range; a container's header prints `header A–B`. ONE `tea-rags call find_symbol` per event
# (≤ 3 paths), cached per session; no ranges in the outline → today's generic nudge (fail open).
for i in $(seq 1 200); do echo "svc_line_$i = $i"; done > "$REPO/svc.rb"
for i in $(seq 1 60); do echo "two_line_$i = $i"; done > "$REPO/two.rb"
for i in $(seq 1 60); do echo "spec_line_$i = $i"; done > "$REPO/spec/svc_spec.rb"
SVC_OUTLINE=$'svc.rb\n  Svc L1-100\n  header 1–9\n  Svc::LIMIT\n  Svc#alpha L10-30\n  Svc#beta (private) L32-60\n  Svc#gamma L62-98'
TWO_OUTLINE=$'two.rb\n  Two L1-60\n  Two#run L5-40'
outline_answer() { # <svc content> [two content] → the batched find_symbol JSON
  jq -cn --arg s "$1" --arg t "${2:-}" '{results: ([{payload: {request: "svc.rb", relativePath: "svc.rb", content: $s}}]
    + (if $t == "" then [] else [{payload: {request: "two.rb", relativePath: "two.rb", content: $t}}] end))}'
}
export FAKE_OUTLINE; FAKE_OUTLINE=$(outline_answer "$SVC_OUTLINE" "$TWO_OUTLINE")
export FAKE_OUT='{"indexed":true,"project":"p","collectionName":"c","relativePath":"svc.rb"}'
SVC_NUDGE='svc.rb is indexed source — find_symbol(relativePath: "svc.rb") returns it'
rm -f "$FAKEBIN/outline.log"
run '{"hook_event_name":"UserPromptSubmit","session_id":"o1","prompt":"p"}'
pre o1 Read "$(read_in "$REPO/svc.rb" 35 10)"
noted 'svc.rb lines 35–44 → find_symbol(symbols:["Svc#beta"]) returns them whole; no Read slice'; note $? "Read offset/limit inside one method → its id as a literal find_symbol(symbols:[…]), never a decision"
[ "$(context | grep -oF 'Svc#beta' | wc -l | tr -d ' ')" = 1 ]; note $? "… the id is named once, inside the call"
! context | grep -qF 'never Read offset/limit'; note $? "… no 'never Read offset/limit' phrasing"
! context | grep -qF "$SVC_NUDGE"; note $? "… instead of the generic nudge"
! context | grep -qF '(private)'; note $? "… the visibility suffix is not part of the id"
run '{"hook_event_name":"UserPromptSubmit","session_id":"o1","prompt":"p"}'
pre o1 Bash "$(bash_in "sed -n 20,40p svc.rb")"
noted 'find_symbol(symbols:["Svc#alpha","Svc#beta"])'; note $? "sed -n spanning two methods → both covering leaf ids, never the container"
[ "$(wc -l < "$FAKEBIN/outline.log" | tr -d ' ')" = 1 ]; note $? "the outline is fetched once per session (cached)"
pre o2 Bash "$(bash_in "head -n 5 svc.rb")"
noted 'svc.rb lines 1–5 = class header → find_symbol(symbol:"Svc") returns it + member ids; no Read slice'; note $? "a header-only range → find_symbol(symbol:\"<Class>\")"
pre o3 Bash "$(bash_in "tail -n 5 svc.rb")"
noted "$SVC_NUDGE"; note $? "lines no outline entry covers → the generic nudge, no ids"
! context | grep -qF 'find_symbol(symbols:["'; note $? "… and never an id for them"
rm -f "$FAKEBIN/outline.log"
pre o4 Read "$(read_in "$REPO/svc.rb")"
noted "$SVC_NUDGE"; note $? "a read of ≥ 80% of the file → the generic nudge"
[ ! -s "$FAKEBIN/outline.log" ]; note $? "… without an outline call"
FAKE_OUTLINE=$(outline_answer $'svc.rb\n  Svc\n  Svc#alpha\n  Svc#beta (private)\n  Svc#gamma')
pre o5 Read "$(read_in "$REPO/svc.rb" 35 10)"
noted "$SVC_NUDGE"; note $? "an outline without line ranges → the generic nudge (fail open)"
FAKE_OUTLINE='not json'
pre o6 Read "$(read_in "$REPO/svc.rb" 35 10)"
noted "$SVC_NUDGE"; note $? "an unparsable outline answer → the generic nudge (fail open)"
# d0z7b.2: find_symbol drops payload.request when it equals relativePath — the row is keyed by its path.
FAKE_OUTLINE=$(jq -cn --arg s "$SVC_OUTLINE" '{results: [{id: "p1", payload: {relativePath: "svc.rb", content: $s}}]}')
pre onoreq Read "$(read_in "$REPO/svc.rb" 35 10)"
noted 'find_symbol(symbols:["Svc#beta"])'; note $? "an outline row without payload.request (request = path, dropped) still records the outline"
export FAKE_OUTLINE=$(outline_answer "$SVC_OUTLINE" "$TWO_OUTLINE")
export FAKE_OUT='{"indexed":true,"project":"p","collectionName":"c","relativePath":"two.rb"}'
pre o9 Bash "$(bash_in "sed -n 10,20p two.rb")"
noted 'two.rb lines 10–20 → find_symbol(symbols:["Two#run"])'; note $? "a range read of a ≤150-line file still names its covering id"
export FAKE_OUT='{"indexed":true,"project":"p","collectionName":"c","relativePath":"svc.rb"}'
FAKE_OUTLINE=$(outline_answer "$SVC_OUTLINE" "$TWO_OUTLINE")
grep_out() { jq -cn --arg c "$1" '{mode: "content", numFiles: 1, filenames: [], content: $c, numLines: 2}'; }
post_context() { [ "$CODE" = 0 ] && [ "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.hookEventName // empty')" = PostToolUse ] || return 1
  local s; for s in "$@"; do context | grep -qF -- "$s" || return 1; done; }
rm -f "$FAKEBIN/outline.log"
# A multi-file sweep is not a drill: hits in two indexed files → no note, and no outline spawn.
post p1 Grep '{"pattern":"line_4","path":".","output_mode":"content","-n":true}' \
  "$(grep_out "$(printf 'svc.rb:40:svc_line_40 = 40\nsvc.rb:70:svc_line_70 = 70\ntwo.rb:12:two_line_12 = 12')")"
silent; note $? "PostToolUse Grep hits in two indexed files → no note (a sweep, not a drill)"
[ ! -s "$FAKEBIN/outline.log" ]; note $? "… and no outline call"
post p1g Grep '{"pattern":"svc_line_4","path":".","output_mode":"content","-n":true}' \
  "$(grep_out "$(printf 'svc.rb:40:svc_line_40 = 40\nsvc.rb:70:svc_line_70 = 70')")"
post_context 'tea-rags: hits in svc.rb → find_symbol(symbols:["Svc#beta","Svc#gamma"]) returns those bodies whole; no Read slice'
note $? "PostToolUse Grep content hits in one file → the enclosing ids as one literal find_symbol(symbols:[…]), hookEventName PostToolUse"
post p2 Bash "$(bash_in "grep -n svc_line_15 svc.rb")" "$(shell_out '15:svc_line_15 = 15')"
post_context 'find_symbol(symbols:["Svc#alpha"])' 'no Read slice'; note $? "PostToolUse Bash grep -n on one file → the enclosing id"
[ "$(context | grep -oF 'Svc#alpha' | wc -l | tr -d ' ')" = 1 ]; note $? "… the id is named once, inside the call"
post p2 Bash "$(bash_in "grep -n svc_line_15 svc.rb")" "$(shell_out '15:svc_line_15 = 15')"
silent; note $? "the same file's hits again in the session → no second note"
post p2b Bash "$(bash_in "grep -n svc_line_15 svc.rb")" "$(shell_out '15:svc_line_15 = 15')"
post_context 'find_symbol(symbols:["Svc#alpha"])'; note $? "a new session → noted again"
run '{"hook_event_name":"SessionStart","session_id":"p2","source":"compact"}'
post p2 Bash "$(bash_in "grep -n svc_line_15 svc.rb")" "$(shell_out '15:svc_line_15 = 15')"
post_context 'find_symbol(symbols:["Svc#alpha"])'; note $? "after a compact SessionStart → noted again"
post p2c Bash "$(bash_in "grep -rn _line_15 svc.rb spec")" "$(shell_out "$(printf 'svc.rb:15:svc_line_15 = 15\nspec/svc_spec.rb:15:spec_line_15 = 15')")"
post_context 'find_symbol(symbols:["Svc#alpha"])'; note $? "a recursive grep hitting one source + one test file → noted (the test file is not counted)"
post p3 Bash "$(bash_in "grep -rn spec_line_7 spec")" "$(shell_out 'spec/svc_spec.rb:7:spec_line_7 = 7')"
silent; note $? "hits in a test / zone file → no note"
post p4 Grep '{"pattern":"svc_line_4","path":".","output_mode":"files_with_matches"}' '{"mode":"files_with_matches","filenames":["svc.rb"],"numFiles":1}'
silent; note $? "Grep files_with_matches → no note"
post p5 Bash "$(bash_in "grep -n svc_line_105 svc.rb")" "$(shell_out '105:svc_line_105 = 105')"
silent; note $? "a hit on a line no outline entry covers → no note"
post p6 Bash "$(bash_in "grep -n svc_line_15 svc.rb")" "$(shell_out '15:svc_line_99999 = 1')"
silent; note $? "a hit line that is not the file's content → no note"
post p7 Bash "$(bash_in "grep svc_line_15 svc.rb")" "$(shell_out 'svc_line_15 = 15')"
silent; note $? "grep without -n (no line numbers) → no note"
# Codex: PostToolUse context is not proven for that harness (README / harness facts name the
# PreToolUse wire only) → gated off; the PreToolUse range nudge ships there. Cursor: postToolUse
# additional_context is documented (harness facts §B, turn-routing.sh) → the hit note ships.
hrun codex "$(shell_ev codex pre o7 "sed -n 35,44p svc.rb")"
hnoted codex 'find_symbol(symbols:["Svc#beta"])'; note $? "codex: shell range read → covering ids as a PreToolUse note"
hrun codex "$(shell_ev codex post o7 "grep -n svc_line_15 svc.rb" "$(shell_out '15:svc_line_15 = 15')")"
hquiet codex; note $? "codex: grep hits → no PostToolUse note (channel unproven)"
hrun cursor "$(shell_ev cursor pre o8 "sed -n 35,44p svc.rb")"
hnoted cursor 'find_symbol(symbols:["Svc#beta"])'; note $? "cursor: shell range read → covering ids as additional_context"
hrun cursor "$(shell_ev cursor post o8 "grep -n svc_line_15 svc.rb" "$(shell_out '15:svc_line_15 = 15')")"
[ "$CODE" = 0 ] && hcontext cursor | grep -qF 'find_symbol(symbols:["Svc#alpha"])' && [ -z "$(printf '%s' "$OUT" | jq -r '.permission // empty')" ]
note $? "cursor: postToolUse grep hits → the enclosing ids as additional_context"
export FAKE_OUT='{"indexed":false}'
unset FAKE_OUTLINE

# Actual code-mode exec_command arguments use cmd, not command. Exercise the source
# hook directly; harness mirrors are regenerated by the integration owner.
codex_source() {
  OUT=$(printf '%s' "$1" | TEA_RAGS_BIN="$FAKEBIN/tea-rags" TEA_RAGS_HOOK_STATE_DIR="$STATE" node "$HOOK" --harness codex 2>/dev/null)
  CODE=$?
}
CODEX_CMD=$(jq -cn --arg cwd "$REPO" --argjson r "$(shell_out "$(sed -n 5,20p "$A")")" '{hook_event_name:"PostToolUse",session_id:"codex-cmd-delivery",cwd:$cwd,tool_name:"exec_command",tool_input:{cmd:"sed -n 5,20p a.ts"},tool_response:$r}')
codex_source "$CODEX_CMD"
codex_source "$(jq -cn --arg cwd "$REPO" '{hook_event_name:"PreToolUse",session_id:"codex-cmd-delivery",cwd:$cwd,tool_name:"exec_command",tool_input:{cmd:"sed -n 5,20p a.ts"}}')"
hnoted codex "lines 5–20 of a.ts" "Bash"; note $? "codex: cmd spelling records delivered shell ranges and notes the same range"
codex_source "$(jq -cn --arg cwd "$REPO" '{hook_event_name:"PreToolUse",session_id:"codex-cmd-delivery",cwd:$cwd,tool_name:"exec_command",tool_input:{cmd:"sed -n 21,30p a.ts"}}')"
hquiet codex; note $? "codex: cmd spelling leaves the undelivered shell tail unread"

# Native Codex 0.166.0 capture: Bash PostToolUse.tool_response is raw stdout.
# Fixture shape: .tmp/readfix-v4-evals/hook-stdin-capture/stdin.jsonl.
codex_post() { codex_source "$(event PostToolUse "$@")"; }
NATIVE_STDOUT=$(jq -cn --arg o "$(sed -n 5,20p "$A")" '$o')
codex_post native-string Bash "$(bash_in 'sed -n 5,20p a.ts')" "$NATIVE_STDOUT"
hquiet codex; note $? "codex: native raw stdout records silently at PostToolUse"
codex_source "$(event PreToolUse native-string Bash "$(bash_in 'sed -n 5,20p a.ts')")"
hnoted codex "lines 5–20 of a.ts"; note $? "codex: native raw stdout records the delivered shell range"
codex_source "$(event PreToolUse native-string Bash "$(bash_in 'sed -n 21,30p a.ts')")"
hquiet codex; note $? "codex: raw stdout never records the undelivered tail"
for response in null '{"isError":true}' '{"error":"blocked"}'; do
  codex_post "native-blocked-$response" Bash "$(bash_in 'cat a.ts')" "$response"
  hquiet codex; note $? "codex: blocked or missing shell response stays silent: $response"
  codex_source "$(event PreToolUse "native-blocked-$response" Bash "$(bash_in 'cat a.ts')")"
  hquiet codex; note $? "codex: blocked or missing shell response creates no coverage: $response"
done
codex_post native-stale Bash "$(bash_in 'cat a.ts')" '"not the current source"'
codex_source "$(event PreToolUse native-stale Bash "$(bash_in 'cat a.ts')")"
hquiet codex; note $? "codex: raw stdout without matching source creates no coverage"
codex_source '{"hook_event_name":"SessionStart","session_id":"native-string","source":"compact"}'
codex_source "$(event PreToolUse native-string Bash "$(bash_in 'sed -n 5,20p a.ts')")"
hquiet codex; note $? "codex: compaction invalidates native string delivery coverage"
post native-claude Bash "$(bash_in 'sed -n 5,20p a.ts')" "$NATIVE_STDOUT"
silent; note $? "claude: raw stdout PostToolUse contract stays quiet"
pre native-claude Bash "$(bash_in 'sed -n 5,20p a.ts')"
silent; note $? "claude: Codex raw stdout normalization does not change coverage"
cp "$A" "$REPO/changed.ts"
codex_post changed-native Bash "$(bash_in 'cat changed.ts')" "$(jq -cn --arg c "$(cat "$REPO/changed.ts")" '$c')"
echo 'changed source' >> "$REPO/changed.ts"
codex_source "$(event PreToolUse changed-native Bash "$(bash_in 'cat changed.ts')")"
hquiet codex; note $? "codex: changed files invalidate native string delivery coverage"

# Wiring: Codex and Cursor run the ledger on the events above.
CJ="$ROOT/harness/codex/tea-rags/hooks/hooks.json"
UJ="$ROOT/harness/cursor/tea-rags/hooks/hooks.json"
jq -e '.hooks.PreToolUse[] | select(.matcher as $m | "exec_command" | test($m)) | .hooks[] | select(.command | test("reread-ledger.mjs\"? --harness codex"))' "$CJ" >/dev/null
note $? "codex: PreToolUse(shell) wires the ledger"
jq -e '.hooks.PostToolUse[] | select(.matcher as $m | "exec_command" | test($m)) | .hooks[] | select(.command | test("reread-ledger.mjs\"? --harness codex"))' "$CJ" >/dev/null \
  && jq -e '.hooks.PostToolUse[] | select(.matcher as $m | ("mcp__tea-rags__find_symbol" | test($m)) and ("mcp__tea_rags__find_symbol" | test($m))) | .hooks[] | select(.command | test("reread-ledger.mjs\"? --harness codex"))' "$CJ" >/dev/null
note $? "codex: PostToolUse(shell, tea-rags MCP) wires the ledger"
jq -e '.hooks.UserPromptSubmit[].hooks[] | select(.command | test("reread-ledger.mjs\"? --harness codex"))' "$CJ" >/dev/null \
  && jq -e '.hooks.SessionStart[].hooks[] | select(.command | test("reread-ledger.mjs\"? --harness codex"))' "$CJ" >/dev/null
note $? "codex: UserPromptSubmit + SessionStart wire the ledger"
jq -e '.hooks.preToolUse[] | select(.matcher as $m | ("Shell" | test($m)) and ("Read" | test($m))) | select(.command | test("reread-ledger.mjs\"? --harness cursor"))' "$UJ" >/dev/null
note $? "cursor: preToolUse(Shell|Read) wires the ledger"
jq -e '.hooks.postToolUse[] | select(.command | test("reread-ledger.mjs\"? --harness cursor"))' "$UJ" >/dev/null \
  && jq -e '.hooks.afterMCPExecution[] | select(.command | test("reread-ledger.mjs\"? --harness cursor"))' "$UJ" >/dev/null \
  && jq -e '.hooks.beforeSubmitPrompt[] | select(.command | test("reread-ledger.mjs\"? --harness cursor"))' "$UJ" >/dev/null
note $? "cursor: postToolUse + afterMCPExecution + beforeSubmitPrompt wire the ledger"
# Claude Code: PostToolUse(Grep) reaches the ledger (the grep-hit note); the outline call needs
# the 8 s budget on both tool events.
PJ="$ROOT/plugins/tea-rags/.claude-plugin/plugin.json"
jq -e '.hooks.PostToolUse[] | select(.matcher as $m | ("Grep" | test($m)) and ("Bash" | test($m))) | .hooks[] | select(.command | test("reread-ledger.mjs"))' "$PJ" >/dev/null
note $? "claude: PostToolUse(Grep|Bash) wires the ledger"
[ "$(jq '[.hooks.PreToolUse[], .hooks.PostToolUse[] | .hooks[] | select(.command | test("reread-ledger.mjs")) | .timeout] | unique' -c "$PJ")" = '[8]' ]
note $? "claude: the ledger's Pre/PostToolUse timeout is 8 s"

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
