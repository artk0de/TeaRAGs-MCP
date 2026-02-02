#!/bin/bash
# PreToolUse hook: Require user confirmation before git commit
#
# Triggered by: Bash|mcp__git-global__git_commit
#
# Exit 0 without JSON = allow
# Exit 0 with JSON hookSpecificOutput.permissionDecision = "ask" = prompt user

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Function to request confirmation
ask_confirmation() {
  jq -n '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "ask",
      "permissionDecisionReason": "Git commit requires your confirmation"
    }
  }'
  exit 0
}

# Case 1: Bash git commit
if [ "$TOOL_NAME" = "Bash" ]; then
  if echo "$COMMAND" | grep -qE '(^|&&|;|\|)\s*git\s+commit'; then
    ask_confirmation
  fi
  exit 0
fi

# Case 2: MCP git commit
if [ "$TOOL_NAME" = "mcp__git-global__git_commit" ]; then
  ask_confirmation
fi

exit 0
