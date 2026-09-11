#!/bin/bash
# PreToolUse hook: Warn if plugin .md files staged without version bump
#
# Triggered by: Bash|mcp__git-global__git_commit
# Checks STAGED files for .claude-plugin/<plugin>/ .md changes before commit happens.
# Each plugin carries its own manifest, so the bump is checked per plugin — see
# .claude/rules/plugin-versioning.md. The git-side twin of this check lives in
# .husky/pre-commit; keep the two carve-outs (manifest-bearing dirs, merge
# commits) in step.

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

GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)

# Merge commit → the bump belongs to the merged branch, not to the merge.
# Same carve-out as .husky/pre-commit.
if [ -n "$GIT_DIR" ] && [ -f "$GIT_DIR/MERGE_HEAD" ]; then
  exit 0
fi

STAGED=$(git diff --cached --name-only 2>/dev/null)
ADDED=$(git diff --cached --diff-filter=A --name-only 2>/dev/null)

# Directory names under .claude-plugin/ with a staged .md, candidates only:
# .benchmarks/ lives there too and owns no version, and marketplace.json is not
# in a directory at all.
CANDIDATES=$(printf '%s\n' "$STAGED" | grep -E '^\.claude-plugin/[^/]+/.*\.md$' | cut -d/ -f2 | sort -u)

staged_is() { printf '%s\n' "$STAGED" | grep -Fqx "$1"; }

# A directory is a plugin iff it carries a manifest — on disk, or staged by the
# commit that introduces it.
is_plugin() {
  [ -f "$REPO_ROOT/.claude-plugin/$1/.claude-plugin/plugin.json" ] && return 0
  staged_is ".claude-plugin/$1/.claude-plugin/plugin.json"
}

# A skill or rule file this commit ADDS asks for a minor rather than a patch.
# Literal prefixes, never a regex: a plugin directory name is not a pattern.
adds_skill_or_rule() {
  while IFS= read -r file; do
    case "$file" in
      ".claude-plugin/$1/skills/"*SKILL.md) return 0 ;;
      ".claude-plugin/$1/rules/"*.md) return 0 ;;
    esac
  done <<EOF
$ADDED
EOF
  return 1
}

PENDING=""
while IFS= read -r plugin; do
  [ -n "$plugin" ] || continue
  is_plugin "$plugin" || continue

  MANIFEST=".claude-plugin/$plugin/.claude-plugin/plugin.json"

  # Manifest staged alongside → the version moved with the text.
  staged_is "$MANIFEST" && continue

  if adds_skill_or_rule "$plugin"; then
    BUMP_TYPE="MINOR (new skill or rule)"
  else
    BUMP_TYPE="PATCH (text changes)"
  fi

  PENDING="${PENDING}  - bump ${BUMP_TYPE} in ${MANIFEST}"$'\n'
done <<EOF
$CANDIDATES
EOF

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
