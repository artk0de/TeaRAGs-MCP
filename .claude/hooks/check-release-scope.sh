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

# Public/Functional scopes take the DEFAULT release rules (feat → minor), so
# they deliberately carry no row in .releaserc.json and cannot be extracted from
# it. Adding inert rows there would encode "special-cased to minor", which is
# false. The list lives here instead — one variable, used for both the check and
# the warning below — and mirrors the CONTRIBUTING.md scope tables.
PUBLIC_SCOPES="api mcp contracts types drift explore search rerank hybrid trajectory signals presets filters ingest pipeline chunker migration"

# Known scopes: the explicit rows in .releaserc.json (non-release and
# infrastructure layers, which need an explicit release value) plus the
# public/functional layer above.
KNOWN_SCOPES=$(
  {
    jq -r '.plugins[0][1].releaseRules[]? | .scope // empty' "$RELEASERC" 2>/dev/null
    echo "$PUBLIC_SCOPES" | tr ' ' '\n'
  } | sort -u
)

# Check if scope is known
if echo "$KNOWN_SCOPES" | grep -qx "$SCOPE_ROOT"; then
  exit 0
fi

# Unknown scope detected — warn. The public/functional layer is recited from
# PUBLIC_SCOPES so the list the reader is told to pick from is the same one the
# check above accepts.
PUBLIC_SCOPES_CSV=$(echo "$PUBLIC_SCOPES" | tr ' ' '\n' | paste -sd, - | sed 's/,/, /g')

jq -n --arg scope "$SCOPE_ROOT" --arg msg "$LAST_MSG" --arg public "$PUBLIC_SCOPES_CSV" '{
  "hookSpecificOutput": {
    "message": ("Unknown release scope \"" + $scope + "\" in commit: " + $msg + "\n\nThis scope is not configured in .releaserc.json and will use DEFAULT rules (feat=minor, fix=patch).\n\nYou MUST add this scope to the correct layer:\n- Non-release (.releaserc.json row): test, beads, scripts, ci, website, deps\n- Infrastructure, feat→patch (.releaserc.json row): onnx, embedding, embedded, adapters, qdrant, git, config, factory, bootstrap, debug, logs\n- Public/Functional, feat→minor (PUBLIC_SCOPES in this hook — the default rules already cover it, so it needs no .releaserc.json row): " + $public + "\n\nAlso update CONTRIBUTING.md scope tables.")
  }
}'
exit 0
