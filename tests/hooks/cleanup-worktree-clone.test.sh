#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/.claude-plugin/tea-rags/scripts/cleanup-worktree-clone.sh"
PASS=0; FAIL=0
note() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "ok   - $2"; else FAIL=$((FAIL+1)); echo "FAIL - $2"; fi; }

# Fake `tea-rags` on PATH:
#   `worktree list --json` echoes $FAKE_CLONES (registry fixture)
#   `worktree remove <name>` records the name it was asked to remove
FAKEBIN="$(mktemp -d)"; CALLS="$(mktemp)"
cat > "$FAKEBIN/tea-rags" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  "worktree list") printf '%s' "$FAKE_CLONES" ;;
  "worktree remove") echo "remove $3" >> "$CALLS" ;;
esac
exit 0
EOF
chmod +x "$FAKEBIN/tea-rags"
export PATH="$FAKEBIN:$PATH" CALLS

run() { # $1=json payload, $2=clones-json fixture
  : > "$CALLS"; export FAKE_CLONES="$2"
  printf '%s' "$1" | bash "$HOOK" >/dev/null 2>&1
}
removed() { grep -q -- "remove $1" "$CALLS"; }
empty()   { [ ! -s "$CALLS" ]; }

# A path that exists (active clone) and one that is gone (orphan).
LIVE_DIR="$(mktemp -d)"
GONE_DIR="$(mktemp -d)"; rmdir "$GONE_DIR"   # now absent on disk

clones() { # build a worktree-list fixture from name/path pairs: clones n1 p1 n2 p2 ...
  local out="["; local first=1
  while [ "$#" -ge 2 ]; do
    [ "$first" = 1 ] || out="$out,"; first=0
    out="$out{\"worktreeName\":\"$1\",\"path\":\"$2\"}"
    shift 2
  done
  printf '%s]' "$out"
}

# 1. `git worktree remove` success + an orphan clone (path gone) → clone torn down
run "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git worktree remove $GONE_DIR\"},\"tool_response\":{\"stdout\":\"\"}}" "$(clones gone "$GONE_DIR")"
removed gone; note $? "worktree remove sweeps the orphan clone (path gone)"

# 2. a clone whose path STILL exists (active dev) → NOT removed
run "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git worktree remove $GONE_DIR\"},\"tool_response\":{\"stdout\":\"\"}}" "$(clones live "$LIVE_DIR")"
empty; note $? "active clone (path present) is preserved"

# 3. mixed: orphan removed, live preserved, in one sweep
run "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git worktree remove $GONE_DIR\"},\"tool_response\":{\"stdout\":\"\"}}" "$(clones gone "$GONE_DIR" live "$LIVE_DIR")"
{ removed gone && ! removed live; }; note $? "mixed sweep removes only the orphan"

# 4. `git branch -D` success + orphan clone → torn down (branch-delete path)
run "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git branch -D feature-x\"},\"tool_response\":{\"stdout\":\"Deleted branch feature-x\"}}" "$(clones gone "$GONE_DIR")"
removed gone; note $? "branch -D sweeps the orphan clone"

# 5. flag-prefixed `git -C <path> worktree remove` → still detected (regex robustness)
run "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git -C /repo worktree remove $GONE_DIR\"},\"tool_response\":{\"stdout\":\"\"}}" "$(clones gone "$GONE_DIR")"
removed gone; note $? "flag-prefixed git -C ... worktree remove is detected"

# 6. non-teardown git command (commit) → no-op (cleanup hook never reindexes/removes)
run "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git commit -m x\"},\"tool_response\":{\"stdout\":\"1 file changed\"}}" "$(clones gone "$GONE_DIR")"
empty; note $? "git commit is a no-op for the cleanup hook"

# 7. failed worktree remove (fatal) → no sweep
run "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git worktree remove $GONE_DIR\"},\"tool_response\":{\"stdout\":\"fatal: '$GONE_DIR' is not a working tree\"}}" "$(clones gone "$GONE_DIR")"
empty; note $? "failed worktree remove is a no-op"

# 8. non-Bash tool → no-op
run "{\"tool_name\":\"Edit\",\"tool_input\":{\"command\":\"git worktree remove $GONE_DIR\"},\"tool_response\":{\"stdout\":\"\"}}" "$(clones gone "$GONE_DIR")"
empty; note $? "non-Bash tool is a no-op"

# 9. no registered clones → no-op (empty registry)
run "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git worktree remove $GONE_DIR\"},\"tool_response\":{\"stdout\":\"\"}}" "[]"
empty; note $? "empty registry is a no-op"

rm -rf "$FAKEBIN" "$LIVE_DIR" "$CALLS"
echo "---"; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
