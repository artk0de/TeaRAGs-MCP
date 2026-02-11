#!/usr/bin/env bash
# Outputs project rules into context before compaction
# so the compactor preserves them in the summary.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
CLAUDE_DIR="$PROJECT_DIR/.claude"

echo "# Project Rules (reloaded on compact)"
echo ""

for f in "$CLAUDE_DIR/CLAUDE.local.md" "$CLAUDE_DIR/AGENTS.local.md"; do
  if [ -f "$f" ]; then
    echo "## $(basename "$f")"
    echo ""
    cat "$f"
    echo ""
  fi
done
