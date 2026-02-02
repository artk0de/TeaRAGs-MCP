#!/bin/bash
# PostToolUse hook: Remind to update docs and schemas when code changes

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Early exit if not in src/
if [[ "$FILE_PATH" != *"src/"* ]]; then
  exit 0
fi

# Handler files changed - remind about schema sync
if [[ "$FILE_PATH" == *"src/tools/"*.ts ]] && [[ "$FILE_PATH" != *"schemas.ts"* ]] && [[ "$FILE_PATH" != *".test.ts"* ]]; then
  echo ""
  echo "================================================"
  echo "⚠️  Tool handler changed: $FILE_PATH"
  echo ""
  echo "If you changed API contracts, UPDATE schemas.ts:"
  echo "  - New enum values → add to .enum([...])"
  echo "  - New parameters → add field with .describe()"
  echo "  - Behavior changes → update tool description"
  echo "================================================"
  echo ""
fi

# Schema file changed - remind about README
if [[ "$FILE_PATH" == *"schemas.ts"* ]]; then
  echo ""
  echo "================================================"
  echo "📝 Schema changed!"
  echo "Consider updating README.md if user-facing."
  echo "================================================"
  echo ""
fi

exit 0
