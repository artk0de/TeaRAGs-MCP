#!/usr/bin/env bash
# PreToolUse(Read) hook (bd tea-rags-mcp-ueplg): deny a Read of a file the
# tea-rags index serves, allow everything else, fail open on every error.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/plugins/tea-rags/scripts/deny-indexed-read.sh"
PASS=0; FAIL=0
note() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "ok   - $2"; else FAIL=$((FAIL+1)); echo "FAIL - $2"; fi; }

# Fake `tea-rags` on PATH:
#   `project indexed --path <p> --json` records <p>, prints $FAKE_OUT, exits $FAKE_EXIT
FAKEBIN="$(mktemp -d)"; CALLS="$(mktemp)"
cat > "$FAKEBIN/tea-rags" <<'EOF'
#!/usr/bin/env bash
[ "$1 $2" = "project indexed" ] || exit 3
echo "$4" >> "$CALLS"
[ "$3" = "--command" ] && echo "cwd:$6" >> "$CALLS"
printf '%s\n' "$FAKE_OUT"
exit "$FAKE_EXIT"
EOF
chmod +x "$FAKEBIN/tea-rags"
# A PATH holding jq and the base system but no tea-rags (the CLI-missing case).
NOCLI="$(mktemp -d)"; ln -s "$(command -v jq)" "$NOCLI/jq"
BASE_PATH="/usr/bin:/bin"
export CALLS

run() { # $1=json payload, $2=fake stdout, $3=fake exit, [$4=PATH]
  : > "$CALLS"; export FAKE_OUT="$2" FAKE_EXIT="$3"
  OUT=$(printf '%s' "$1" | PATH="${4:-$FAKEBIN:$NOCLI:$BASE_PATH}" CLAUDE_PROJECT_DIR=/repo bash "$HOOK" 2>/dev/null)
  CODE=$?
}
read_of() { printf '{"tool_name":"Read","tool_input":{"file_path":"%s"}}' "$1"; }
decision() { printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null; }
reason() { printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty' 2>/dev/null; }
asked() { grep -qx -- "$1" "$CALLS"; }
silent_allow() { [ "$CODE" = 0 ] && [ -z "$OUT" ]; }

INDEXED='{"indexed":true,"project":"repo","collectionName":"code_repo","relativePath":"src/a.ts"}'

# 1. an indexed file → deny, reason names the find_symbol call with the relative path
run "$(read_of /repo/src/a.ts)" "$INDEXED" 0
{ [ "$CODE" = 0 ] && [ "$(decision)" = deny ]; }; note $? "indexed file is denied"
reason | grep -qF 'find_symbol(relativePath: "src/a.ts")'; note $? "deny reason names find_symbol(relativePath) with the tree-relative path"
reason | grep -qF 'find_symbol(symbols: ['; note $? "deny reason offers find_symbol(symbols) for known ids"
reason | grep -qF 'Read is for files outside the index'; note $? "deny reason says what Read is for"
asked /repo/src/a.ts; note $? "the CLI is asked about the file the Read names"

# 2. a file outside the index (CLI exit 1) → silent allow
run "$(read_of /repo/package.json)" '{"indexed":false}' 1
silent_allow; note $? "unindexed file is allowed silently"

# 3. an unregistered repo answers the same way (CLI exit 1) → silent allow
run "$(read_of /elsewhere/x.ts)" '{"indexed":false}' 1
silent_allow; note $? "file of an unregistered repo is allowed silently"

# 4. CLI missing from PATH → silent allow
run "$(read_of /repo/src/a.ts)" "$INDEXED" 0 "$NOCLI:$BASE_PATH"
silent_allow; note $? "missing tea-rags CLI fails open"

# 5. CLI error (usage exit 2) → silent allow
run "$(read_of /repo/src/a.ts)" "garbage" 2
silent_allow; note $? "CLI error exit fails open"

# 6. exit 0 but unparsable output → silent allow (never deny on a guess)
run "$(read_of /repo/src/a.ts)" "not json" 0
silent_allow; note $? "unparsable CLI output fails open"

# 7. a non-Read tool → no-op, CLI never asked
run '{"tool_name":"Edit","tool_input":{"file_path":"/repo/src/a.ts"}}' "$INDEXED" 0
{ silent_allow && [ ! -s "$CALLS" ]; }; note $? "non-Read tool is a no-op"

# 8. obvious binary/media file → allowed without asking the CLI
run "$(read_of /repo/docs/logo.png)" "$INDEXED" 0
{ silent_allow && [ ! -s "$CALLS" ]; }; note $? "media file is allowed without a CLI call"

# 9. a relative file_path resolves against CLAUDE_PROJECT_DIR
run "$(read_of src/a.ts)" "$INDEXED" 0
asked /repo/src/a.ts; note $? "relative file_path resolves against CLAUDE_PROJECT_DIR"

bash_of() { jq -cn --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c},cwd:"/repo/sub"}'; }

# 11. Bash compound with an indexed reader operand → deny, the command and cwd go to the CLI once
run "$(bash_of 'cat a.rb; sed -n 1,40p src/a.ts')" "$INDEXED" 0
{ [ "$(decision)" = deny ] && reason | grep -qF 'find_symbol(relativePath: "src/a.ts")'; }; note $? "Bash compound read of an indexed file is denied"
{ asked 'cat a.rb; sed -n 1,40p src/a.ts' && asked cwd:/repo/sub && [ "$(grep -c . "$CALLS")" = 2 ]; }; note $? "one CLI call carries the whole command and the Bash cwd"

# 12. Bash pipe over command output → the CLI answers not indexed → silent allow
run "$(bash_of 'git diff | head -50')" '{"indexed":false}' 1
silent_allow; note $? "git diff | head is allowed"

# 13. Bash reader of an unindexed file → silent allow
run "$(bash_of 'cat package.json')" '{"indexed":false}' 1
silent_allow; note $? "Bash read of an unindexed file is allowed"

# 14. Bash command with no file reader → CLI never asked
run "$(bash_of 'npm test && git status')" "$INDEXED" 0
{ silent_allow && [ ! -s "$CALLS" ]; }; note $? "Bash command without a reader skips the CLI"

# 10. malformed stdin → silent allow
run 'not json' "$INDEXED" 0
silent_allow; note $? "malformed hook input fails open"

rm -rf "$FAKEBIN" "$NOCLI" "$CALLS"
echo "---"; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
