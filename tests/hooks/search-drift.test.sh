#!/usr/bin/env bash
# Stateful search-drift hook (plugins/tea-rags/scripts/search-drift.sh; bd
# tea-rags-mcp-nknkg.2), run as each harness ships it:
#   claude — plugins/tea-rags/scripts/search-drift.sh --harness claude
#            (PreToolUse Read|Grep|Bash counts, PostToolUse tea-rags MCP resets)
#   codex  — harness/codex/tea-rags/scripts/search-drift.sh --harness codex
#            (PreToolUse shell counts, PostToolUse tea-rags MCP resets)
#   cursor — harness/cursor/tea-rags/scripts/search-drift.sh --harness cursor
#            (preToolUse Shell|Read|Grep counts, afterMCPExecution tea-rags resets)
# Per-session counters: DENY once after 3 consecutive concept searches done by
# text search (an alternation), 3 reads of indexed source code, or 4 mixed, with
# no tea-rags call between. Literal / -F searches and reads of, or searches scoped
# to, config / DSL / migrations / specs are neutral (bd tea-rags-mcp-nxg76: core
# routes them to the standard tools). At most one deny per
# 120 s; a deny resets the counters; edits are neutral; every error fails open
# (Cursor: fail-open prints {"permission":"allow"}). A new user prompt
# (UserPromptSubmit / beforeSubmitPrompt) resets the counters and keeps the deny
# cooldown: drift is a within-turn phenomenon.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0; FAIL=0
note() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "ok   - $2"; else FAIL=$((FAIL+1)); echo "FAIL - $2"; fi; }

hook_of() {
  case "$1" in
    claude) echo "$ROOT/plugins/tea-rags/scripts/search-drift.sh" ;;
    codex) echo "$ROOT/harness/codex/tea-rags/scripts/search-drift.sh" ;;
    cursor) echo "$ROOT/harness/cursor/tea-rags/scripts/search-drift.sh" ;;
  esac
}

# Fake `tea-rags`: `project indexed …` prints $FAKE_OUT (default: indexed).
FAKEBIN="$(mktemp -d)"; NOCLI="$(mktemp -d)"
cat > "$FAKEBIN/tea-rags" <<'EOF'
#!/usr/bin/env bash
[ "$1 $2" = "project indexed" ] || exit 3
printf '%s\n' "$FAKE_OUT"
EOF
chmod +x "$FAKEBIN/tea-rags"
ln -s "$(command -v jq)" "$NOCLI/jq"
BASE_PATH="/usr/bin:/bin"
export FAKE_OUT='{"indexed":true,"relativePath":"src/a.ts"}'
# A concept search done by text search: an alternation of words.
C='retry|backoff'
STATE="$(mktemp -d)"
NOW=1000000

# run <harness> <json> [PATH] [state dir]
run() {
  OUT=$(printf '%s' "$2" | env -u TEA_RAGS_BIN TEA_RAGS_HOOK_NOW="$NOW" TEA_RAGS_HOOK_STATE_DIR="${4:-$STATE}" \
    PATH="${3:-$FAKEBIN:$NOCLI:$BASE_PATH}" bash "$(hook_of "$1")" --harness "$1" 2>"$STATE.err")
  CODE=$?
  ERR=$(cat "$STATE.err")
}
denied() { # $1=harness [$2=substring of the reason]
  local reason
  case "$1" in
    claude)
      [ "$CODE" = 0 ] || return 1
      [ "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecision // empty')" = deny ] || return 1
      reason=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecisionReason') ;;
    codex) [ "$CODE" = 2 ] || return 1; reason="$ERR" ;;
    cursor)
      [ "$CODE" = 0 ] || return 1
      [ "$(printf '%s' "$OUT" | jq -r '.permission // empty')" = deny ] || return 1
      reason=$(printf '%s' "$OUT" | jq -r '.agent_message')
      [ "$(printf '%s' "$OUT" | jq -r '.user_message')" = "$reason" ] || return 1 ;;
  esac
  [ -z "${2:-}" ] || printf '%s' "$reason" | grep -qF -- "$2"
}
allowed() { # $1=harness
  case "$1" in
    claude | codex) [ "$CODE" = 0 ] && [ -z "$OUT" ] ;;
    cursor) [ "$CODE" = 0 ] && [ "$(printf '%s' "$OUT" | jq -r '.permission // empty' 2>/dev/null)" = allow ] ;;
  esac
}

# Event builders: <harness> <session> …
pre() { # <h> <sid> <tool-kind: grep|read|bash|edit> <arg>
  local h="$1" sid="$2" kind="$3" arg="$4" tool input
  case "$h:$kind" in
    claude:grep) tool=Grep; input=$(jq -cn --arg a "$arg" '{pattern:$a}') ;;
    claude:read) tool=Read; input=$(jq -cn --arg a "$arg" '{file_path:$a}') ;;
    claude:bash) tool=Bash; input=$(jq -cn --arg a "$arg" '{command:$a}') ;;
    claude:edit) tool=Edit; input=$(jq -cn --arg a "$arg" '{file_path:$a}') ;;
    codex:grep | codex:bash) tool=Bash; input=$(jq -cn --arg a "$arg" '{command:$a}') ;;
    codex:read) tool=exec_command; input=$(jq -cn --arg a "cat $arg" '{command:["bash","-lc",$a]}') ;;
    codex:edit) tool=apply_patch; input='{"command":"*** Begin Patch"}' ;;
    cursor:grep) tool=Grep; input=$(jq -cn --arg a "$arg" '{pattern:$a}') ;;
    cursor:read) tool=Read; input=$(jq -cn --arg a "$arg" '{file_path:$a}') ;;
    cursor:bash) tool=Shell; input=$(jq -cn --arg a "$arg" '{command:$a}') ;;
    cursor:edit) tool=Write; input=$(jq -cn --arg a "$arg" '{file_path:$a}') ;;
  esac
  case "$h" in
    codex) [ "$kind" = grep ] && input=$(jq -cn --arg a "rg -n '$arg' src" '{command:$a}') ;;
    *) ;;
  esac
  case "$h" in
    cursor) jq -cn --arg s "$sid" --arg t "$tool" --argjson i "$input" \
      '{hook_event_name:"preToolUse",conversation_id:$s,tool_name:$t,tool_input:$i,cwd:"/repo",workspace_roots:["/repo"]}' ;;
    *) jq -cn --arg s "$sid" --arg t "$tool" --argjson i "$input" \
      '{hook_event_name:"PreToolUse",session_id:$s,cwd:"/repo",tool_name:$t,tool_input:$i}' ;;
  esac
}
tearags() { # <h> <sid>: a successful tea-rags MCP call
  case "$1" in
    cursor) jq -cn --arg s "$2" '{hook_event_name:"afterMCPExecution",conversation_id:$s,tool_name:"find_symbol",mcp_server_name:"tea-rags",tool_input:"{}",result_json:"{}"}' ;;
    *) jq -cn --arg s "$2" '{hook_event_name:"PostToolUse",session_id:$s,cwd:"/repo",tool_name:"mcp__tea-rags__find_symbol",tool_input:{},tool_response:{}}' ;;
  esac
}
prompt() { # <h> <sid>: a new user prompt
  case "$1" in
    cursor) jq -cn --arg s "$2" '{hook_event_name:"beforeSubmitPrompt",conversation_id:$s,prompt:"next",workspace_roots:["/repo"]}' ;;
    *) jq -cn --arg s "$2" '{hook_event_name:"UserPromptSubmit",session_id:$s,cwd:"/repo",prompt:"next"}' ;;
  esac
}
fresh() { rm -rf "$STATE"; mkdir -p "$STATE"; NOW=1000000; }

for H in claude codex cursor; do
  [ -f "$(hook_of "$H")" ] || { note 1 "$H: hook script exists at $(hook_of "$H")"; continue; }

  fresh
  run "$H" "$(pre "$H" s1 grep "$C")"; allowed "$H"; note $? "$H: search 1 allowed"
  run "$H" "$(pre "$H" s1 grep "$C")"; allowed "$H"; note $? "$H: search 2 allowed"
  run "$H" "$(pre "$H" s1 grep "$C")"; denied "$H" "semantic_search"; note $? "$H: search 3 denied, names semantic_search"
  denied "$H" "reset"; note $? "$H: deny says the counter is reset"
  run "$H" "$(pre "$H" s1 grep "$C")"; allowed "$H"; note $? "$H: deny reset the counter"

  # Cooldown: a fourth streak inside 120 s is not denied; after it, it is.
  run "$H" "$(pre "$H" s1 grep "$C")"; run "$H" "$(pre "$H" s1 grep "$C")"
  NOW=$((NOW + 60)); run "$H" "$(pre "$H" s1 grep "$C")"; allowed "$H"; note $? "$H: no second deny within 120 s"
  NOW=$((NOW + 61)); run "$H" "$(pre "$H" s1 grep "$C")"; denied "$H"; note $? "$H: deny again after 120 s"

  fresh
  run "$H" "$(pre "$H" s2 grep "$C")"; run "$H" "$(pre "$H" s2 grep "$C")"
  run "$H" "$(tearags "$H" s2)"
  case "$H" in cursor) [ "$CODE" = 0 ] && printf '%s' "$OUT" | jq -e . >/dev/null 2>&1 ;; *) [ "$CODE" = 0 ] && [ -z "$OUT" ] ;; esac
  note $? "$H: tea-rags call passes through"
  run "$H" "$(pre "$H" s2 grep "$C")"; run "$H" "$(pre "$H" s2 grep "$C")"; allowed "$H"; note $? "$H: tea-rags call resets the counter"

  if [ "$H" = codex ]; then
    # Codex code mode names a nested MCP tool as a normalized JS identifier: `tea-rags` → `tea_rags`.
    fresh
    run "$H" "$(pre "$H" s2n grep "$C")"; run "$H" "$(pre "$H" s2n grep "$C")"
    run "$H" "$(jq -cn '{hook_event_name:"PostToolUse",session_id:"s2n",cwd:"/repo",tool_name:"mcp__tea_rags__find_symbol",tool_input:{},tool_response:{}}')"
    run "$H" "$(pre "$H" s2n grep "$C")"; allowed "$H"
    note $? "codex: a code-mode tea-rags call (mcp__tea_rags__*) resets the counter"
  fi

  fresh
  export FAKE_OUT='{"indexed":true,"relativePath":"src/a.ts"}'
  run "$H" "$(pre "$H" s3 read /repo/src/a.ts)"; run "$H" "$(pre "$H" s3 read /repo/src/a.ts)"; allowed "$H"; note $? "$H: indexed read 2 allowed"
  run "$H" "$(pre "$H" s3 read /repo/src/a.ts)"; denied "$H" "find_symbol"; note $? "$H: indexed read 3 denied, names find_symbol"

  fresh
  export FAKE_OUT='{"indexed":false}'
  for _ in 1 2 3 4 5; do run "$H" "$(pre "$H" s4 read /repo/package.json)"; done
  allowed "$H"; note $? "$H: reads outside the index are neutral"
  export FAKE_OUT='{"indexed":true,"relativePath":"src/a.ts"}'

  fresh
  run "$H" "$(pre "$H" s5 grep "$C")"; run "$H" "$(pre "$H" s5 read /repo/src/a.ts)"
  run "$H" "$(pre "$H" s5 grep "$C")"; allowed "$H"; note $? "$H: mixed 3 allowed"
  run "$H" "$(pre "$H" s5 read /repo/src/a.ts)"; denied "$H"; note $? "$H: mixed 4 denied"

  fresh
  run "$H" "$(pre "$H" s6 grep "$C")"; run "$H" "$(pre "$H" s6 edit /repo/src/a.ts)"; allowed "$H"; note $? "$H: edit allowed"
  run "$H" "$(pre "$H" s6 grep "$C")"; denied "$H"; run "$H" "$(pre "$H" s6 grep "$C")"
  fresh
  run "$H" "$(pre "$H" s6 grep "$C")"; run "$H" "$(pre "$H" s6 edit /repo/src/a.ts)"
  run "$H" "$(pre "$H" s6 grep "$C")"; run "$H" "$(pre "$H" s6 grep "$C")"; denied "$H"; note $? "$H: edits neither count nor reset"

  fresh
  for _ in 1 2 3 4; do run "$H" "$(pre "$H" s7 bash 'npm test 2>&1 | grep FAIL')"; done
  allowed "$H"; note $? "$H: grep over command output is neutral"
  fresh
  run "$H" "$(pre "$H" s8 bash 'git status')"; run "$H" "$(pre "$H" s8 bash 'rg -l "foo|qux" src')"
  run "$H" "$(pre "$H" s8 bash 'cd src && grep -rn "bar\|baz" .')"; allowed "$H"; note $? "$H: shell concept search 2 allowed"
  run "$H" "$(pre "$H" s8 bash 'git grep -e baz -e qux')"; denied "$H"; note $? "$H: shell concept search 3 (a|b, a\\|b, -e -e) denied"

  # bd tea-rags-mcp-nxg76: literal searches are the routed occurrence search, never drift.
  fresh
  for _ in 1 2 3 4 5; do run "$H" "$(pre "$H" l1 grep RETRY_AFTER_SECONDS)"; done
  allowed "$H"; note $? "$H: literal searches (one identifier) are neutral"
  run "$H" "$(pre "$H" l1 bash 'rg -l RETRY_AFTER_SECONDS src')"; run "$H" "$(pre "$H" l1 bash 'grep -rn "retry after" src')"
  run "$H" "$(pre "$H" l1 bash 'grep -rnF "a|b" src')"; run "$H" "$(pre "$H" l1 bash 'rg -l --fixed-strings "x|y" src')"
  allowed "$H"; note $? "$H: shell literal / phrase / -F searches are neutral"
  run "$H" "$(pre "$H" l1 grep "$C")"; run "$H" "$(pre "$H" l1 grep "$C")"; allowed "$H"; note $? "$H: neutral searches left the counter at 0"

  # Searches scoped to config / spec / migration paths and reads of them are neutral.
  fresh
  for _ in 1 2 3 4; do run "$H" "$(pre "$H" z1 bash 'rg -n "create_table|add_column" db/migrate')"; done
  allowed "$H"; note $? "$H: concept search scoped to db/migrate is neutral"
  for _ in 1 2 3 4; do run "$H" "$(pre "$H" z1 bash 'grep -rln "FLAG_A\|FLAG_B" spec/constants config/routes.rb')"; done
  allowed "$H"; note $? "$H: concept search scoped to spec/ and config/ is neutral"
  # bd tea-rags-mcp-d9w4o (eval Z5): a column-existence check is three literal
  # searches over db/ (both table forms, then the column) — core routes it there.
  fresh
  run "$H" "$(pre "$H" z5 bash 'grep -rn -F ":invoices" db/migrate')"
  run "$H" "$(pre "$H" z5 bash "grep -rn -F '\"invoices\"' db/migrate")"
  run "$H" "$(pre "$H" z5 bash 'grep -rn -F "paid_at" db/migrate')"
  allowed "$H"; note $? "$H: three literal searches scoped to db/migrate are not denied"
  case "$H" in
    claude | cursor)
      for _ in 1 2 3 4; do
        run "$H" "$(jq -cn --arg s z1 '{hook_event_name:"PreToolUse",session_id:$s,conversation_id:$s,cwd:"/repo",workspace_roots:["/repo"],tool_name:"Grep",tool_input:{pattern:"create_table|add_column",path:"/repo/db/migrate"}}' | if [ "$H" = cursor ]; then jq -c '.hook_event_name="preToolUse"'; else cat; fi)"
      done
      allowed "$H"; note $? "$H: Grep tool alternation with path db/migrate is neutral" ;;
  esac
  export FAKE_OUT='{"indexed":true,"relativePath":"db/migrate/001_create_orders.rb"}'
  for f in db/migrate/001_create_orders.rb config/initializers/money.rb spec/models/order_spec.rb config/routes.rb; do
    run "$H" "$(pre "$H" z2 read "/repo/$f")"
  done
  allowed "$H"; note $? "$H: reads of migrations / initializers / specs / routes are neutral"
  export FAKE_OUT='{"indexed":true,"relativePath":"src/a.ts"}'
  run "$H" "$(pre "$H" z2 read /repo/src/a.ts)"; run "$H" "$(pre "$H" z2 read /repo/src/a.ts)"; allowed "$H"
  note $? "$H: zone reads left the read counter at 0"
  # A zone word in the checkout path itself never neutralises a source read.
  fresh
  for _ in 1 2 3; do
    run "$H" "$(pre "$H" z3 read /repo/src/a.ts | jq -c '.cwd="/work/test/repo" | .workspace_roots=["/work/test/repo"] | if .tool_input.file_path then .tool_input.file_path="/work/test/repo/src/a.ts" else .tool_input.command=(.tool_input.command | if type=="array" then (.[2]="cat src/a.ts") else . end) end')"
  done
  denied "$H" "find_symbol"; note $? "$H: a zone word in the cwd does not exempt a source read"

  fresh
  run "$H" "$(pre "$H" a grep "$C")"; run "$H" "$(pre "$H" a grep "$C")"
  run "$H" "$(pre "$H" b grep "$C")"; allowed "$H"; note $? "$H: sessions are counted apart"

  # Fail-open paths.
  fresh
  run "$H" "$(pre "$H" s9 grep "$C")" "$BASE_PATH"
  if command -v jq >/dev/null 2>&1 && [ "$(command -v jq)" != /usr/bin/jq ]; then allowed "$H"; note $? "$H: no jq → allow"; fi
  run "$H" 'not json'; allowed "$H"; note $? "$H: unparsable stdin → allow"
  BLOCKED="$(mktemp)"
  for _ in 1 2 3 4; do run "$H" "$(pre "$H" s10 grep "$C")" "" "$BLOCKED/state"; done
  allowed "$H"; note $? "$H: unwritable state dir → allow"
  rm -f "$BLOCKED"
done

# A new user prompt is a fresh routing decision: it resets the counters, keeps the deny cooldown.
for H in claude codex cursor; do
  [ -f "$(hook_of "$H")" ] || continue
  fresh
  run "$H" "$(pre "$H" t1 grep "$C")"; run "$H" "$(pre "$H" t1 grep "$C")"
  run "$H" "$(prompt "$H" t1)"
  case "$H" in cursor) [ "$CODE" = 0 ] && [ "$(printf '%s' "$OUT" | jq -r '.continue // empty' 2>/dev/null)" = true ] ;; *) [ "$CODE" = 0 ] && [ -z "$OUT" ] ;; esac
  note $? "$H: prompt event passes through ($H shape)"
  run "$H" "$(pre "$H" t1 grep "$C")"; run "$H" "$(pre "$H" t1 grep "$C")"; allowed "$H"; note $? "$H: 2 searches, new prompt, 2 searches -> no deny"
  run "$H" "$(pre "$H" t1 grep "$C")"; denied "$H"; note $? "$H: 3 searches within one turn still denied"

  fresh
  for _ in 1 2 3; do run "$H" "$(pre "$H" t2 grep "$C")"; done
  denied "$H"; note $? "$H: setup deny"
  run "$H" "$(prompt "$H" t2)"
  NOW=$((NOW + 30))
  for _ in 1 2 3; do run "$H" "$(pre "$H" t2 grep "$C")"; done
  allowed "$H"; note $? "$H: deny, new prompt, 3 searches within 120 s -> no second deny (cooldown kept)"

  fresh
  run "$H" "$(prompt "$H" t3)"
  [ ! -e "$STATE/drift-$H-t3" ]; note $? "$H: prompt without prior state creates no state"
  run "$H" '{"hook_event_name":"UserPromptSubmit"}'
  [ "$CODE" = 0 ]; note $? "$H: prompt without session id fails open"
done

# Wiring: each harness registers the counting and the resetting event.
PJ="$ROOT/plugins/tea-rags/.claude-plugin/plugin.json"
jq -e '.hooks.PreToolUse[] | select(.matcher | test("Grep")) | .hooks[] | select(.command | test("search-drift.sh --harness claude"))' "$PJ" >/dev/null
note $? "claude: PreToolUse wires search-drift"
# bd tea-rags-mcp-nxg76: the indexed-read deny is gone from all three harnesses.
! grep -qF 'deny-indexed-read' "$PJ" "$ROOT/harness/codex/tea-rags/hooks/hooks.json" "$ROOT/harness/cursor/tea-rags/hooks/hooks.json"
note $? "no harness wires deny-indexed-read"
[ ! -e "$ROOT/plugins/tea-rags/scripts/deny-indexed-read.sh" ] && [ ! -e "$ROOT/harness/codex/tea-rags/scripts/deny-indexed-read.sh" ] \
  && [ ! -e "$ROOT/harness/cursor/tea-rags/scripts/deny-indexed-read.sh" ] && [ ! -e "$ROOT/.claude-plugin/tea-rags/scripts/deny-indexed-read.sh" ]
note $? "no harness ships deny-indexed-read.sh"
jq -e '.hooks.PostToolUse[] | select(.matcher | test("tea-rags")) | .hooks[] | select(.command | test("search-drift.sh --harness claude"))' "$PJ" >/dev/null
note $? "claude: PostToolUse(tea-rags MCP) wires search-drift"
CJ="$ROOT/harness/codex/tea-rags/hooks/hooks.json"
jq -e '.hooks.PreToolUse[].hooks[] | select(.command | test("search-drift.sh --harness codex"))' "$CJ" >/dev/null
note $? "codex: PreToolUse wires search-drift"
jq -e '.hooks.PostToolUse[] | select(.matcher as $m | ("mcp__tea-rags__find_symbol" | test($m)) and ("mcp__tea_rags__find_symbol" | test($m))) | .hooks[] | select(.command | test("search-drift.sh --harness codex"))' "$CJ" >/dev/null
note $? "codex: PostToolUse(tea-rags MCP, direct or code-mode name) wires search-drift"
UJ="$ROOT/harness/cursor/tea-rags/hooks/hooks.json"
jq -e '.hooks.preToolUse[] | select(.matcher | test("Grep")) | select(.command | test("search-drift.sh\"? --harness cursor"))' "$UJ" >/dev/null
note $? "cursor: preToolUse wires search-drift"
jq -e '.hooks.afterMCPExecution[] | select(.command | test("search-drift.sh\"? --harness cursor"))' "$UJ" >/dev/null
note $? "cursor: afterMCPExecution wires search-drift"
jq -e '.hooks.UserPromptSubmit[].hooks[] | select(.command | test("search-drift.sh --harness claude"))' "$PJ" >/dev/null
note $? "claude: UserPromptSubmit wires search-drift (turn reset)"
jq -e '.hooks.UserPromptSubmit[].hooks[] | select(.command | test("search-drift.sh --harness codex"))' "$CJ" >/dev/null
note $? "codex: UserPromptSubmit wires search-drift (turn reset)"
jq -e '.hooks.beforeSubmitPrompt[] | select(.command | test("search-drift.sh\"? --harness cursor"))' "$UJ" >/dev/null
note $? "cursor: beforeSubmitPrompt wires search-drift (turn reset)"
cmp -s "$ROOT/plugins/tea-rags/scripts/search-drift.sh" "$(hook_of codex)" && cmp -s "$ROOT/plugins/tea-rags/scripts/search-drift.sh" "$(hook_of cursor)"
note $? "one script: Codex and Cursor ship the plugin's search-drift.sh byte-identical"

rm -rf "$FAKEBIN" "$NOCLI" "$STATE" "$STATE.err"
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
