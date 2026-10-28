#!/usr/bin/env bash
# tests/hooks/skill-no-ripgrep.test.sh — plugin skills and rules never prescribe
# ripgrep: users' clients may not have it. Literal text search is named as the
# default code search tool. Prohibitions (`never rg --files`) and
# ripgrep as a measured corpus name stay allowed.
#
# One narrowing (bd tea-rags-mcp-onli7): the Codex package may name `shell rg -l`
# — the Codex mapping of the default code search tool, rg being bundled inside
# Codex itself. Sources, the Claude Code package and the Cursor package stay
# rg-free; the Codex package names rg through that mapping only.
set -u
ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
PASS=0; FAIL=0
note() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "ok   - $2"; else FAIL=$((FAIL+1)); echo "FAIL - $2"; fi; }

PATTERN='(^|[^a-z-])rg -[A-Za-z]|ripgrep (MCP|tool)|mcp__ripgrep|(use|via|with|run) ripgrep|rg hit'
CODEX_MAPPING='shell rg -l'

hits() { # <dir> — ripgrep prescriptions in the Markdown and hook text under <dir>
  grep -rniE "$PATTERN" "$1" --include='*.md' --include='*.txt' 2>/dev/null | grep -v '/evals/'
}
report() { [ -n "$1" ] && printf '%s\n' "$1" | sed "s#$ROOT/##" | cut -c1-160; }

HITS="$(hits "$ROOT/plugins")"
[ -z "$HITS" ]; note $? "no ripgrep prescription in plugins/**/*.md"
report "$HITS"

for PKG in "$ROOT/.claude-plugin/tea-rags" "$ROOT/.claude-plugin/dinopowers" "$ROOT/harness/cursor"; do
  HITS="$(hits "$PKG")"
  [ -d "$PKG" ] && [ -z "$HITS" ]; note $? "no ripgrep prescription in ${PKG#"$ROOT"/}"
  report "$HITS"
done

CODEX="$ROOT/harness/codex"
# Sentence-initial substitutions keep the capital (`Shell rg -l`).
HITS="$(hits "$CODEX" | sed -E "s/[Ss]${CODEX_MAPPING#s}//g" | grep -iE "$PATTERN")"
[ -d "$CODEX" ] && [ -z "$HITS" ]; note $? "harness/codex names rg only as the mapping '$CODEX_MAPPING'"
report "$HITS"
grep -rqF "$CODEX_MAPPING" "$CODEX/tea-rags/scripts/core.txt"; note $? "harness/codex core.txt names '$CODEX_MAPPING'"

echo "skill-no-ripgrep: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
