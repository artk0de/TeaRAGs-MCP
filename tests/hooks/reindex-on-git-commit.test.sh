#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/.claude-plugin/tea-rags/scripts/reindex-on-git-commit.sh"
PASS=0; FAIL=0
note() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "ok   - $2"; else FAIL=$((FAIL+1)); echo "FAIL - $2"; fi; }

# Fake `tea-rags` on PATH: `project exist` reads $FAKE_REGISTERED, `index-codebase` records args.
FAKEBIN="$(mktemp -d)"; CALLS="$(mktemp)"
cat > "$FAKEBIN/tea-rags" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  "project exist")
    # registered if the --path value equals $FAKE_REGISTERED
    prev=""; p=""
    for a in "$@"; do [ "$prev" = "--path" ] && p="$a"; prev="$a"; done
    if [ -n "$FAKE_REGISTERED" ] && [ "$p" = "$FAKE_REGISTERED" ]; then
      echo "$FAKE_ALIAS"; exit 0
    fi
    exit 1 ;;
  "index-codebase "*|"index-codebase")
    echo "index-codebase $*" >> "$CALLS"; exit 0 ;;
esac
exit 0
EOF
chmod +x "$FAKEBIN/tea-rags"
export PATH="$FAKEBIN:$PATH" CALLS

run() { # $1=json payload, $2=registered-path, $3=alias
  : > "$CALLS"; export FAKE_REGISTERED="$2" FAKE_ALIAS="$3"
  printf '%s' "$1" | bash "$HOOK" >/dev/null 2>&1
}
called() { grep -q -- "$1" "$CALLS"; }
empty()  { [ ! -s "$CALLS" ]; }

DIR="$(mktemp -d)"  # not a git repo → hook falls back to .cwd

# 1. successful commit in a registered dir → reindex by alias
run "{\"tool_name\":\"Bash\",\"cwd\":\"$DIR\",\"tool_input\":{\"command\":\"git commit -m x\"},\"tool_output\":{\"stdout\":\"1 file changed\"}}" "$DIR" "demo"
called -- "--project demo"; note $? "commit in registered dir reindexes by alias"

# 2. unregistered dir → skip (no reindex)
run "{\"tool_name\":\"Bash\",\"cwd\":\"$DIR\",\"tool_input\":{\"command\":\"git commit -m x\"},\"tool_output\":{\"stdout\":\"1 file changed\"}}" "" ""
empty; note $? "commit in unregistered dir skips reindex"

# 3. non-git Bash command → no-op
run "{\"tool_name\":\"Bash\",\"cwd\":\"$DIR\",\"tool_input\":{\"command\":\"ls -la\"},\"tool_output\":{\"stdout\":\"\"}}" "$DIR" "demo"
empty; note $? "non-git command is a no-op"

# 4. failed commit (nothing to commit) → no-op
run "{\"tool_name\":\"Bash\",\"cwd\":\"$DIR\",\"tool_input\":{\"command\":\"git commit -m x\"},\"tool_output\":{\"stdout\":\"nothing to commit, working tree clean\"}}" "$DIR" "demo"
empty; note $? "failed commit (nothing to commit) is a no-op"

# 5. successful merge in a registered dir → reindex
run "{\"tool_name\":\"Bash\",\"cwd\":\"$DIR\",\"tool_input\":{\"command\":\"git merge worktree-x\"},\"tool_output\":{\"stdout\":\"Fast-forward\"}}" "$DIR" "demo"
called -- "--project demo"; note $? "successful merge reindexes"

# 6. merge conflict → no-op
run "{\"tool_name\":\"Bash\",\"cwd\":\"$DIR\",\"tool_input\":{\"command\":\"git merge x\"},\"tool_output\":{\"stdout\":\"CONFLICT (content): Merge conflict in a.ts\"}}" "$DIR" "demo"
empty; note $? "merge conflict is a no-op"

# 7. non-Bash tool → no-op
run "{\"tool_name\":\"Edit\",\"cwd\":\"$DIR\",\"tool_input\":{\"command\":\"git commit\"},\"tool_output\":{\"stdout\":\"\"}}" "$DIR" "demo"
empty; note $? "non-Bash tool is a no-op"

rm -rf "$FAKEBIN" "$DIR" "$CALLS"
echo "---"; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
