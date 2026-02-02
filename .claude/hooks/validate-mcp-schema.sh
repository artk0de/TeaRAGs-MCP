#!/bin/bash
# Validate MCP schema changes with TypeScript type checking

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Early exit if not in src/
if [[ "$FILE_PATH" != *"src/"* ]]; then
  exit 0
fi

# Only check schema-related files
if [[ "$FILE_PATH" != *"schemas.ts"* ]] && [[ "$FILE_PATH" != *"src/tools/"* ]]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR"

# Type check
npx tsc --noEmit 2>&1 | head -20

if [ ${PIPESTATUS[0]} -ne 0 ]; then
  echo "================================================" >&2
  echo "TypeScript errors in schema/tools!" >&2
  echo "Run: npm run type-check" >&2
  echo "================================================" >&2
  exit 2
fi

echo "Schema validation OK"
exit 0
