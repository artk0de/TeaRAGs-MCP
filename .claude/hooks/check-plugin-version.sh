#!/bin/bash
# PreToolUse hook: Warn if plugin .md files staged without version bump
#
# Triggered by: Bash|mcp__git-global__git_commit
# Checks STAGED files for .claude-plugin/<plugin>/ .md changes before commit happens.
# Each plugin carries its own manifest, so the bump is checked per plugin — see
# .claude/rules/plugin-versioning.md for the three that live here.

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

is_commit() {
  if [ "$TOOL_NAME" = "Bash" ]; then
    echo "$COMMAND" | grep -qE '(^|&&|;|\|)\s*git\s+commit'
    return $?
  fi
  [ "$TOOL_NAME" = "mcp__git-global__git_commit" ]
}

if ! is_commit; then
  exit 0
fi

STAGED=$(git diff --cached --name-only 2>/dev/null)
ADDED=$(git diff --cached --diff-filter=A --name-only 2>/dev/null)

# Plugins with a staged .md, by directory name: .claude-plugin/<plugin>/…/*.md
PLUGINS=$(printf '%s\n' "$STAGED" | grep -E '^\.claude-plugin/[^/]+/.*\.md$' | cut -d/ -f2 | sort -u)

PENDING=""
for plugin in $PLUGINS; do
  MANIFEST=".claude-plugin/$plugin/.claude-plugin/plugin.json"

  # Manifest staged alongside → the version moved with the text.
  if printf '%s\n' "$STAGED" | grep -Fqx "$MANIFEST"; then
    continue
  fi

  if printf '%s\n' "$ADDED" | grep -qE "^\.claude-plugin/$plugin/(skills/.*SKILL\.md|rules/.*\.md)$"; then
    BUMP_TYPE="MINOR (new skill or rule)"
  else
    BUMP_TYPE="PATCH (text changes)"
  fi

  PENDING="${PENDING}  - bump ${BUMP_TYPE} in ${MANIFEST}"$'\n'
done

if [ -n "$PENDING" ]; then
  jq -n --arg pending "$PENDING" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": ("Plugin .md files staged but the plugin version was not bumped:\n" + $pending + "See .claude/rules/plugin-versioning.md.")
    }
  }'
fi

exit 0
