#!/bin/bash
# PostToolUse hook: Detect unknown scopes after git commit
#
# Triggered by: Bash|mcp__git-global__git_commit (PostToolUse)
#
# Reads the last commit message, extracts scope, checks if it exists
# in .releaserc.json. If not — warns Claude to add it.

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
TOOL_OUTPUT=$(echo "$INPUT" | jq -r '.tool_output.stdout // .tool_output.content // empty')

# Only process successful git commits
case "$TOOL_NAME" in
  Bash)
    COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
    if ! echo "$COMMAND" | grep -qE '(^|&&|;|\|)\s*git\s+commit'; then
      exit 0
    fi
    # Check if commit succeeded
    if echo "$TOOL_OUTPUT" | grep -qE '(nothing to commit|no changes added)'; then
      exit 0
    fi
    ;;
  mcp__git-global__git_commit)
    ;;
  *)
    exit 0
    ;;
esac

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
RELEASERC="$PROJECT_DIR/.releaserc.json"

if [ ! -f "$RELEASERC" ]; then
  exit 0
fi

# Get scope from last commit
LAST_MSG=$(git -C "$PROJECT_DIR" log -1 --format="%s" 2>/dev/null)
SCOPE=$(echo "$LAST_MSG" | sed -n 's/^[a-z]*(\([^)]*\)).*/\1/p')

# No scope — nothing to check
if [ -z "$SCOPE" ]; then
  exit 0
fi

# Handle nested scopes like "trajectory/static" — use first part
SCOPE_ROOT=$(echo "$SCOPE" | cut -d'/' -f1)

# Known scopes from releaserc (extract all scope values)
KNOWN_SCOPES=$(jq -r '.plugins[0][1].releaseRules[]? | .scope // empty' "$RELEASERC" 2>/dev/null | sort -u)

# Check if scope is known
if echo "$KNOWN_SCOPES" | grep -qx "$SCOPE_ROOT"; then
  exit 0
fi

# Unknown scope detected — warn
jq -n --arg scope "$SCOPE_ROOT" --arg msg "$LAST_MSG" '{
  "hookSpecificOutput": {
    "message": ("Unknown release scope \"" + $scope + "\" in commit: " + $msg + "\n\nThis scope is not configured in .releaserc.json and will use DEFAULT rules (feat=minor, fix=patch).\n\nYou MUST add this scope to the correct layer in .releaserc.json:\n- Non-release: test, beads, scripts, ci, website, deps\n- Infrastructure (feat→patch): onnx, embedding, embedded, adapters, qdrant, git, config, factory, bootstrap, debug, logs\n- Public/Functional (feat→minor): api, mcp, contracts, types, drift, search, rerank, hybrid, trajectory, signals, presets, filters, ingest, pipeline, chunker\n\nAlso update CONTRIBUTING.md scope tables.")
  }
}'
exit 0
