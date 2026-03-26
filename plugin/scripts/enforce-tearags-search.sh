#!/bin/bash
# PreToolUse hook for Agent tool: inject tea-rags search instructions into subagent prompts.
# Ensures subagents use mcp__tea-rags__* tools instead of built-in Search/Grep.

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty')

if [ -z "$PROMPT" ]; then
  exit 0
fi

SUFFIX='

--- TeaRAGs Search Rules (injected by plugin) ---
MANDATORY: Use mcp__tea-rags__semantic_search, mcp__tea-rags__hybrid_search, or mcp__tea-rags__search_code for ALL code discovery and exploration. Do NOT use built-in Search or Grep for code discovery. Use built-in Grep ONLY as a last resort if tea-rags tools are unavailable or return errors.
For exhaustive usage queries ("where is X used", "all callers"), use mcp__tea-rags__hybrid_search first, then mcp__ripgrep__search for completeness.
For exact string matching (TODO, FIXME, imports), use mcp__ripgrep__search.'

UPDATED_PROMPT="${PROMPT}${SUFFIX}"

jq -n --arg prompt "$UPDATED_PROMPT" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: {
      prompt: $prompt
    }
  }
}'
