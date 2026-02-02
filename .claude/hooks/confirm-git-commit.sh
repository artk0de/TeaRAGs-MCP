#!/bin/bash
# PreToolUse hook: Block git commit without user confirmation

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Check if this is a git commit command
if echo "$COMMAND" | grep -qE "^git\s+commit"; then
  echo "🛑 Git commit requires user confirmation" >&2
  echo "Ask user to confirm before committing" >&2
  exit 2
fi

exit 0
