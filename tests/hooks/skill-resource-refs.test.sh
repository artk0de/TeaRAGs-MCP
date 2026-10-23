#!/usr/bin/env bash
# tests/hooks/skill-resource-refs.test.sh — every tea-rags:// URI a tea-rags skill
# names must be one the server registers; an unknown URI is a silent dead read.
# Needs a build: compares against `node build/cli/index.js resource --list`.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0; FAIL=0
note() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "ok   - $2"; else FAIL=$((FAIL+1)); echo "FAIL - $2"; fi; }

CLI="$ROOT/build/cli/index.js"
[ -f "$CLI" ] || { echo "FAIL - build missing: run npm run build"; exit 1; }
LIST="$(node "$CLI" resource --list 2>/dev/null | grep '^tea-rags://')"
[ -n "$LIST" ]; note $? "resource --list returns tea-rags URIs"

# Registered shapes: static URIs exactly; templates by path prefix before `{?`
# with `{name}` / `{alias}` matching one path segment.
PATTERNS="$(printf '%s\n' "$LIST" | sed -E 's/\{\?[^}]*\}$//' | sort -u | while read -r u; do
  printf '%s\n' "$u" | sed -E 's/[.]/\\./g; s/\{[a-z]+\}/[^\/?]+/g; s/^/^/; s/$/([?].*)?$/'
done)"

SKILLS="$ROOT/.claude-plugin/tea-rags/skills"
URIS="$(grep -rhoE 'tea-rags://[A-Za-z0-9_./{}<>?=,&-]+' "$SKILLS" | sed -E 's/[.,)`]+$//' | sort -u)"
[ -n "$URIS" ]; note $? "skills reference tea-rags:// URIs"
for u in $URIS; do
  # Placeholders the model fills in (<alias>, <lang>, <name>, {alias}) → one segment.
  probe="$(printf '%s' "$u" | sed -E 's/<[a-z]+>/x/g; s/\{alias\}/x/g; s/\{name\}/x/g')"
  ok=1
  while read -r p; do
    [ -n "$p" ] && printf '%s\n' "$probe" | grep -Eq "$p" && { ok=0; break; }
  done <<< "$PATTERNS"
  note $ok "registered: $u"
done

echo "skill-resource-refs: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
