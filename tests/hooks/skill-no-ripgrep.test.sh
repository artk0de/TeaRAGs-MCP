#!/usr/bin/env bash
# tests/hooks/skill-no-ripgrep.test.sh — plugin skills and rules never prescribe
# ripgrep: users' clients may not have it. Literal text search is named as the
# default code search tool. Prohibitions (`never rg --files`) and
# ripgrep as a measured corpus name stay allowed.
set -u
ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
PASS=0; FAIL=0
note() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "ok   - $2"; else FAIL=$((FAIL+1)); echo "FAIL - $2"; fi; }

HITS="$(grep -rniE '(^|[^a-z-])rg -[A-Za-z]|ripgrep (MCP|tool)|mcp__ripgrep|(use|via|with|run) ripgrep|rg hit' "$ROOT/plugins" --include='*.md' | grep -v '/evals/')"
[ -z "$HITS" ]; note $? "no ripgrep prescription in plugins/**/*.md"
[ -n "$HITS" ] && printf '%s\n' "$HITS" | sed "s#$ROOT/##" | cut -c1-160

echo "skill-no-ripgrep: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
