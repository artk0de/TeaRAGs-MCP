#!/bin/bash
# PreToolUse hook: Block git push unless user explicitly requested it
#
# Triggered by: Bash
# Denies any git push command — agent must never push without user's request

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

# Check if command contains git push
if echo "$COMMAND" | grep -qE '(^|&&|;|\|)\s*git\s+push'; then
  jq -n '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "git push blocked. Push only when user explicitly asks. Commit ≠ push."
    }
  }'
fi

exit 0
