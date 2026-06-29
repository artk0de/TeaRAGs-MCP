#!/usr/bin/env bash
# PostToolUse(Bash) cleanup-only hook: when a worktree-removing git op succeeds,
# tear down any tea-rags worktree clone whose worktree path no longer exists on
# disk. This is FOOTPRINT cleanup only — it never reindexes and never touches
# search behavior, so it does not reintroduce implicit freshness. It guarantees
# the throwaway clone is dropped even when the skill path is bypassed with a raw
# `git worktree remove` / `git branch -D`. Idempotent (a clone already removed by
# the skill is simply absent from the sweep). A hook must never fail the tool:
# always exit 0.

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
[ "$TOOL_NAME" = "Bash" ] || exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
# Detect a worktree-teardown git op. Match `git` AND a teardown subcommand
# anywhere in the command — robust to flag prefixes like `git -C <path> worktree
# remove` (the freshness hook's `git[[:space:]]+commit` regex missed those).
echo "$COMMAND" | grep -qE '(^|[^[:alnum:]_])git([[:space:]]|$)' || exit 0
echo "$COMMAND" | grep -qE '(worktree[[:space:]]+remove|branch[[:space:]]+-[dD])' || exit 0

# Success filter: skip on a failed teardown (canonical .tool_response, legacy
# .tool_output fallback).
TOOL_OUTPUT=$(echo "$INPUT" | jq -r '.tool_response.stdout // .tool_response.content // .tool_output.stdout // .tool_output.content // empty')
if echo "$TOOL_OUTPUT" | grep -qiE 'fatal:|error:|is not a working tree|cannot[[:space:]]'; then
  exit 0
fi

# Sweep the registry: remove every worktree clone whose worktree path is gone.
# Reconciling registry vs filesystem is path-based, so it needs no parsing of
# the command's path argument and catches both `worktree remove` and the
# `branch -D` after a worktree was already removed.
tea-rags worktree list --json 2>/dev/null | jq -c '.[]?' 2>/dev/null | while IFS= read -r entry; do
  p=$(printf '%s' "$entry" | jq -r '.path // empty')
  n=$(printf '%s' "$entry" | jq -r '.worktreeName // empty')
  [ -n "$p" ] && [ -n "$n" ] || continue
  [ -d "$p" ] && continue
  tea-rags worktree remove "$n" >/dev/null 2>&1
done

exit 0
