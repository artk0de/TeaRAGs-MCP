#!/bin/bash
# SubagentStart hook: hand every subagent the tea-rags search instructions as
# additionalContext, so it uses mcp__tea-rags__* tools instead of built-in
# Grep/Glob. Injected unconditionally — the block is small and harmless for
# non-search tasks.
#
# SubagentStart, not PreToolUse(Agent) + updatedInput: two plugins rewriting the
# Agent prompt through updatedInput collide (the hooks run in parallel and only
# one rewrite lands — the dinopowers routing table was silently lost, 2026-10-05).
# additionalContext from several SubagentStart hooks composes.

# No path is injected: the subagent addresses tea-rags with its OWN working
# directory (a linked worktree reads its own tree; the index resolves from the
# same repository). CLAUDE_PROJECT_DIR is the parent session's checkout — wrong
# tree for a worktree subagent.
#
# Single source: the block is the first fenced block under "## The block to
# inject" in rules/references/subagent-injection.md — edit it there.

cat > /dev/null

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BLOCK_FILE="${SCRIPT_DIR}/../rules/references/subagent-injection.md"
BLOCK=$(awk '
  /^## The block to inject/ { section = 1; next }
  section && /^```/ { if (inside) exit; inside = 1; next }
  inside { print }
' "$BLOCK_FILE" 2>/dev/null)

if [ -z "$BLOCK" ]; then
  exit 0
fi

jq -n --arg context "$BLOCK" '{
  hookSpecificOutput: {
    hookEventName: "SubagentStart",
    additionalContext: $context
  }
}'
