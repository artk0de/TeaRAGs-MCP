#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/.claude/hooks/check-plugin-version.sh"
PASS=0; FAIL=0

# The hook reads the STAGED set of whatever repository it is invoked in, so every
# case runs against a throwaway repository — staging a plugin file in the real
# worktree to test the hook would leave someone else's index dirty.
TMPD="$(mktemp -d)"; REPO="$TMPD/repo"; OUT="$TMPD/out.json"; ERR="$TMPD/err.txt"
STATUS=0

note() {
  if [ "$1" = 0 ]; then
    PASS=$((PASS+1)); echo "ok   - $2"
  else
    FAIL=$((FAIL+1)); echo "FAIL - $2"
    echo "       exit=$STATUS"
    [ -s "$OUT" ] && { echo "       stdout:"; sed 's/^/         /' "$OUT"; }
    [ -s "$ERR" ] && { echo "       stderr:"; sed 's/^/         /' "$ERR"; }
  fi
}

COMMIT_CALL='{"tool_name":"Bash","tool_input":{"command":"git commit -m wip"}}'

fresh_repo() {
  rm -rf "$REPO"; mkdir -p "$REPO"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email hook@example.com
  git -C "$REPO" config user.name "hook test"
  write README.md "seed"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm seed
}

write() { mkdir -p "$REPO/$(dirname "$1")"; printf '%s\n' "$2" > "$REPO/$1"; }
stage() { write "$1" "${2:-x}"; git -C "$REPO" add -- "$1"; }
# A plugin is a directory that carries a manifest; give it one without bumping it.
plant_manifest() {
  write ".claude-plugin/$1/.claude-plugin/plugin.json" '{"version":"0.1.0"}'
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm "plant $1"
}

# The hook resolves the staged set from the CWD, so it has to run inside the repo.
run_hook() {
  ( cd "$REPO" && printf '%s' "$1" | bash "$HOOK" ) > "$OUT" 2> "$ERR"
  STATUS=$?
}
decision() { jq -r '.hookSpecificOutput.permissionDecision // empty' < "$OUT"; }
reason()   { jq -r '.hookSpecificOutput.permissionDecisionReason // empty' < "$OUT"; }
# An allowed commit is silent on both streams and still exits cleanly — a hook
# that crashed would otherwise read as an allow.
allowed()  { [ "$STATUS" = 0 ] && [ ! -s "$OUT" ] && [ ! -s "$ERR" ]; }
denied()   { [ "$STATUS" = 0 ] && [ ! -s "$ERR" ] && [ "$(decision)" = "deny" ]; }

# 1. a plugin .md staged with no version bump is refused, and the message names
#    the manifest of the plugin that actually moved
fresh_repo
plant_manifest tea-rags
stage ".claude-plugin/tea-rags/rules/search-cascade.md" "changed"
run_hook "$COMMIT_CALL"
denied && reason | grep -Fq ".claude-plugin/tea-rags/.claude-plugin/plugin.json"
note $? "plugin .md without the manifest is denied, naming that plugin's manifest"

# 2. the same edit with the manifest staged passes
fresh_repo
plant_manifest tea-rags
stage ".claude-plugin/tea-rags/rules/search-cascade.md" "changed"
stage ".claude-plugin/tea-rags/.claude-plugin/plugin.json" '{"version":"0.2.0"}'
run_hook "$COMMIT_CALL"
allowed
note $? "plugin .md staged together with the manifest is allowed"

# 3. a brand-new rule file asks for a MINOR bump
fresh_repo
plant_manifest tea-rags
stage ".claude-plugin/tea-rags/rules/brand-new.md" "new rule"
run_hook "$COMMIT_CALL"
denied && reason | grep -q "MINOR"
note $? "a new rule file asks for a MINOR bump"

# 4. editing a file that already exists asks for a PATCH bump
fresh_repo
plant_manifest tea-rags
write ".claude-plugin/tea-rags/rules/search-cascade.md" "original"
git -C "$REPO" add -A && git -C "$REPO" commit -qm base
stage ".claude-plugin/tea-rags/rules/search-cascade.md" "edited"
run_hook "$COMMIT_CALL"
denied && reason | grep -q "PATCH"
note $? "editing an existing rule asks for a PATCH bump"

# 5. the repository ships three plugins — a sibling is held to the same bar,
#    against ITS own manifest rather than tea-rags'
fresh_repo
plant_manifest tea-rags
plant_manifest dinopowers
stage ".claude-plugin/dinopowers/skills/brainstorming/SKILL.md" "changed"
stage ".claude-plugin/tea-rags/.claude-plugin/plugin.json" '{"version":"0.2.0"}'
run_hook "$COMMIT_CALL"
denied && reason | grep -Fq ".claude-plugin/dinopowers/.claude-plugin/plugin.json"
note $? "a sibling plugin is checked against its own manifest"

# 6. one commit touching two plugins owes two bumps, and the refusal says both
fresh_repo
plant_manifest tea-rags
plant_manifest dinopowers
stage ".claude-plugin/tea-rags/rules/search-cascade.md" "changed"
stage ".claude-plugin/dinopowers/rules/wrapper.md" "changed"
run_hook "$COMMIT_CALL"
denied \
  && reason | grep -Fq ".claude-plugin/tea-rags/.claude-plugin/plugin.json" \
  && reason | grep -Fq ".claude-plugin/dinopowers/.claude-plugin/plugin.json"
note $? "two plugins pending in one commit are both named"

# 7. a manifest-less directory under .claude-plugin/ is not a plugin — the
#    43 tracked .md files under .claude-plugin/.benchmarks/ have no version to bump
fresh_repo
plant_manifest tea-rags
stage ".claude-plugin/.benchmarks/coverage-expander/benchmark.md" "measured"
run_hook "$COMMIT_CALL"
allowed
note $? "a directory with no manifest is not treated as a plugin"

# 8. a merge commit carries the bump in the branch it merges, not in the merge
fresh_repo
plant_manifest tea-rags
stage ".claude-plugin/tea-rags/rules/search-cascade.md" "changed"
git -C "$REPO" rev-parse HEAD > "$REPO/.git/MERGE_HEAD"
run_hook "$COMMIT_CALL"
allowed
note $? "a merge commit is exempt (MERGE_HEAD present)"
rm -f "$REPO/.git/MERGE_HEAD"

# 9. deleting a rule is a plugin change like any other
fresh_repo
plant_manifest tea-rags
write ".claude-plugin/tea-rags/rules/doomed.md" "original"
git -C "$REPO" add -A && git -C "$REPO" commit -qm base
git -C "$REPO" rm -q -- ".claude-plugin/tea-rags/rules/doomed.md"
run_hook "$COMMIT_CALL"
denied && reason | grep -Fq ".claude-plugin/tea-rags/.claude-plugin/plugin.json"
note $? "a staged deletion still asks for a bump"

# 10. markdown outside the plugins is none of the hook's business
fresh_repo
plant_manifest tea-rags
stage "docs/whatever.md" "changed"
run_hook "$COMMIT_CALL"
allowed
note $? "markdown outside .claude-plugin/ is ignored"

# 11. the hook only speaks for commits
fresh_repo
plant_manifest tea-rags
stage ".claude-plugin/tea-rags/rules/search-cascade.md" "changed"
run_hook '{"tool_name":"Bash","tool_input":{"command":"git status"}}'
allowed
note $? "a non-commit tool call is ignored"

rm -rf "$TMPD"
echo "---"; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
