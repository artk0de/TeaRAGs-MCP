#!/bin/bash
# PreToolUse hook: Warn if plugin .md files staged without version bump
#
# Triggered by: Bash|mcp__git-global__git_commit
# Checks STAGED files for plugin/ .md changes before commit happens

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

# Check staged .md files in plugin/ directory
PLUGIN_MD_STAGED=$(git diff --cached --name-only 2>/dev/null | grep -c '^plugin/.*\.md$')

if [ "$PLUGIN_MD_STAGED" -gt 0 ]; then
  # Check if plugin.json is also staged (version bump)
  PLUGIN_JSON_STAGED=$(git diff --cached --name-only 2>/dev/null | grep -c '^plugin/.claude-plugin/plugin.json$')

  if [ "$PLUGIN_JSON_STAGED" -eq 0 ]; then
    # Check if new skills or rules are being added
    NEW_FILES=$(git diff --cached --diff-filter=A --name-only 2>/dev/null | grep -cE '^plugin/(skills/.*SKILL\.md|rules/.*\.md)$')

    if [ "$NEW_FILES" -gt 0 ]; then
      BUMP_TYPE="MINOR (new skill or rule)"
    else
      BUMP_TYPE="PATCH (text changes)"
    fi

    jq -n --arg bump "$BUMP_TYPE" '{
      "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "ask",
        "permissionDecisionReason": ("Plugin .md files staged but version not bumped. Bump " + $bump + " in plugin/.claude-plugin/plugin.json before committing.")
      }
    }'
  fi
fi

exit 0
