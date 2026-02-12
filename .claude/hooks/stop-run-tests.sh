#!/bin/bash
# Stop hook: run tests when code files are staged
# Receives JSON on stdin with stop_hook_active field

set -euo pipefail

cd "$CLAUDE_PROJECT_DIR"

# Read hook input from stdin
INPUT=$(cat)

# Guard: prevent infinite loop when tests keep failing
# stop_hook_active=true means Claude is already continuing after a previous Stop block
STOP_ACTIVE=$(echo "$INPUT" | grep -o '"stop_hook_active":\s*true' || true)
if [ -n "$STOP_ACTIVE" ]; then
  exit 0
fi

# Check staged changes only (not the entire working tree)
CODE_CHANGES=$(git diff --name-only --cached 2>/dev/null || true)

# No staged changes — skip
if [ -z "$CODE_CHANGES" ]; then
  exit 0
fi

# Only docs/config/beads staged — skip
if ! echo "$CODE_CHANGES" | grep -qvE '\.(md|json)$|^\.claude/|^\.beads/'; then
  exit 0
fi

# Code files staged — run tests
npm test -- --run 2>/dev/null || {
  echo "Tests failing — run npm test to see details. NOTE: If test failures are pre-existing (not caused by changes in this session), do NOT attempt to fix them." >&2
  exit 2
}
