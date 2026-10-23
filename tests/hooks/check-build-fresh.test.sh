#!/usr/bin/env bash
# tests/hooks/check-build-fresh.test.sh
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/.claude-plugin/tea-rags/scripts/check-build-fresh.sh"
PLUGIN="$ROOT/.claude-plugin/tea-rags/.claude-plugin/plugin.json"
PASS=0; FAIL=0
note() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "ok   - $2"; else FAIL=$((FAIL+1)); echo "FAIL - $2"; fi; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/pkg/src" "$TMP/pkg/build"
git -C "$TMP/pkg" init -q
echo a > "$TMP/pkg/src/a.ts"; git -C "$TMP/pkg" add . ; GIT_COMMITTER_DATE="2026-10-22T10:00:00" git -C "$TMP/pkg" -c user.email=t@t -c user.name=t commit -qm a
touch -t 202610180000 "$TMP/pkg/build/index.js"

OUT="$(TEA_RAGS_PACKAGE_ROOT="$TMP/pkg" bash "$HOOK" </dev/null)"; RC=$?
[ $RC = 0 ]; note $? "exits 0"
echo "$OUT" | grep -Fq "build is older than its source"; note $? "warns when build predates last src commit"

touch -t 202610230000 "$TMP/pkg/build/index.js"
[ -z "$(TEA_RAGS_PACKAGE_ROOT="$TMP/pkg" bash "$HOOK" </dev/null)" ]; note $? "silent when build is fresh"

rm -rf "$TMP/pkg/.git"
[ -z "$(TEA_RAGS_PACKAGE_ROOT="$TMP/pkg" bash "$HOOK" </dev/null)" ]; note $? "silent for a published install (no .git)"

[ "$(jq '.hooks.PreCompact // empty | length' "$PLUGIN")" = "" ]; note $? "plugin.json has no PreCompact group"
jq -r '.hooks.SessionStart[].hooks[].command' "$PLUGIN" | grep -Fq "check-build-fresh.sh"; note $? "SessionStart runs check-build-fresh.sh"

echo "# pass=$PASS fail=$FAIL"; [ $FAIL = 0 ]
