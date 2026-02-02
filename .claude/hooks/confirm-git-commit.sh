#!/bin/bash
# PreToolUse hook: Require user confirmation before git commit
#
# Returns JSON with permissionDecision to trigger confirmation dialog:
# - "allow" = bypass permission dialog
# - "deny"  = block with reason shown to Claude
# - "ask"   = show confirmation dialog to user
#
# Exit 0 with JSON = processed, Exit 0 without JSON = allow

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Function to request confirmation
ask_confirmation() {
  local reason="$1"
  jq -n \
    --arg reason "$reason" \
    '{
      "decision": "ask",
      "reason": $reason
    }'
  exit 0
}

# Check Bash git commit
if [ "$TOOL_NAME" = "Bash" ] && echo "$COMMAND" | grep -qE "^git\s+commit\s"; then
  ask_confirmation "Git commit requires your confirmation"
fi

# Check MCP git commit
if [ "$TOOL_NAME" = "mcp__git-global__git_commit" ]; then
  ask_confirmation "Git commit requires your confirmation"
fi

# Allow all other operations
exit 0
