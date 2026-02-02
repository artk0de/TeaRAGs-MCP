#!/bin/bash
# PostToolUse hook: Remind to update docs when tools change

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Early exit if not in src/
if [[ "$FILE_PATH" != *"src/"* ]]; then
  exit 0
fi

# Check if tool-related files were modified
if [[ "$FILE_PATH" == *"src/tools/"* ]] || [[ "$FILE_PATH" == *"schemas.ts"* ]]; then
  echo ""
  echo "================================================"
  echo "REMINDER: Tool files changed!"
  echo "Consider updating:"
  echo "  - README.md (Environment Variables, API sections)"
  echo "  - Tool description in schemas.ts (.describe())"
  echo "================================================"
  echo ""
fi

exit 0
