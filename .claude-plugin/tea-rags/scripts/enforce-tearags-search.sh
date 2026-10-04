#!/bin/bash
# PreToolUse hook for Agent tool: inject tea-rags search instructions into subagent prompts.
# Ensures ALL subagents use mcp__tea-rags__* tools instead of built-in Grep/Glob.
# Injected unconditionally — the block is small and harmless for non-search tasks.

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty')

if [ -z "$PROMPT" ]; then
  exit 0
fi

# No path is injected: the subagent addresses tea-rags with its OWN working
# directory (a linked worktree reads its own tree; the index resolves from the
# same repository). CLAUDE_PROJECT_DIR is the parent session's checkout — wrong
# tree for a worktree subagent.
#
# Single source: the block is the first fenced block under "## The block to
# inject" in rules/references/subagent-injection.md — edit it there.

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

SUFFIX="

${BLOCK}"

UPDATED_PROMPT="${PROMPT}${SUFFIX}"

jq -n --argjson input "$INPUT" --arg prompt "$UPDATED_PROMPT" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: ($input.tool_input + { prompt: $prompt })
  }
}'
