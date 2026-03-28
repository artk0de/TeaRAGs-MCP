#!/usr/bin/env bash
set -euo pipefail

ENV_JSON="${1:-{}}"

# ---------------------------------------------------------------------------
# Parse JSON and build -e KEY=VALUE args
# jq is required for JSON parsing
# ---------------------------------------------------------------------------
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required but not installed" >&2
  printf '{"status":"error","command":null}\n'
  exit 1
fi

# Build array of -e KEY=VALUE strings for non-null, non-"false" values
ENV_ARGS=$(echo "$ENV_JSON" | jq -r '
  to_entries[]
  | select(.value != null and .value != "false")
  | "-e \(.key)=\(.value)"
' 2>/dev/null || true)

if [ $? -ne 0 ] || [ -z "$ENV_ARGS" ] && echo "$ENV_JSON" | jq -e 'keys | length == 0' >/dev/null 2>&1; then
  # Empty object is valid — no env args
  ENV_ARGS=""
fi

# ---------------------------------------------------------------------------
# Build the full command string
# ---------------------------------------------------------------------------
CMD="claude mcp add tea-rags -s user -- npx tea-rags server"
while IFS= read -r arg; do
  [ -n "$arg" ] && CMD="$CMD $arg"
done <<< "$ENV_ARGS"

# ---------------------------------------------------------------------------
# Remove existing tea-rags config
# ---------------------------------------------------------------------------
claude mcp remove tea-rags 2>/dev/null || true

# ---------------------------------------------------------------------------
# Execute the add command
# ---------------------------------------------------------------------------
if eval "$CMD" 2>/dev/null; then
  CMD_ESCAPED=$(echo "$CMD" | sed 's/"/\\"/g')
  printf '{"status":"configured","command":"%s"}\n' "$CMD_ESCAPED"
  exit 0
else
  CMD_ESCAPED=$(echo "$CMD" | sed 's/"/\\"/g')
  echo "Failed to execute: $CMD" >&2
  printf '{"status":"error","command":"%s"}\n' "$CMD_ESCAPED"
  exit 1
fi
