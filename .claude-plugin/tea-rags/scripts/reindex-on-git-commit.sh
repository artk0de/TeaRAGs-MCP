#!/usr/bin/env bash
# PostToolUse hook: incremental reindex after a successful git commit / merge.
# Reads the PostToolUse payload from stdin. Resolves the commit directory to a
# registered tea-rags collection and runs an incremental `index_codebase`
# (embeddings block ~1-3s, enrichment detaches) so mid-task searches see
# freshly-committed code. Skips silently when the directory is not a registered
# project (e.g. a bare git worktree with no clone) — never creates a stray
# collection. A hook must never fail the tool: always exit 0.

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
[ "$TOOL_NAME" = "Bash" ] || exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
echo "$COMMAND" | grep -qE '(^|&&|;|\|)[[:space:]]*git[[:space:]]+(commit|merge)' || exit 0

# PostToolUse carries the tool's result under `.tool_response` (canonical:
# .tool_response.stdout for Bash); older/alternate schemas use `.tool_output`.
# Read both so the success/failure filter works regardless of payload shape.
TOOL_OUTPUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // .tool_response.content // .tool_output.stdout // .tool_output.content // empty')
if echo "$TOOL_OUTPUT" | grep -qiE 'nothing to commit|no changes added|CONFLICT|Merge conflict|Automatic merge failed|not something we can merge'; then
  exit 0
fi

CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
[ -n "$CWD" ] || CWD="$PWD"
DIR=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || echo "$CWD")

ALIAS=$(tea-rags project exist --path "$DIR" --print-name 2>/dev/null) || {
  echo "[reindex-on-git-commit] $DIR not a registered tea-rags project — skipping" >&2
  exit 0
}
[ -n "$ALIAS" ] || exit 0

# Incremental reindex: embeddings block (~1-3s), enrichment detaches (no --wait-enrichments, no --force).
tea-rags index-codebase --project "$ALIAS" --json >/dev/null 2>&1
exit 0
