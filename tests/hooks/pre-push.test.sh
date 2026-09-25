#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/.husky/pre-push"
PASS=0; FAIL=0

# bd tea-rags-mcp-j1hfd: CI lints the whole project with full type information
# (`eslint src/ tests/`), lint-staged lints staged files only — so type-aware
# rules such as no-unnecessary-type-assertion are invisible to the commit gate.
# The pre-push hook closes that gap by running the same `npm run lint` CI runs.
# npm is a stub that logs its argv; STUB_LINT_EXIT makes the lint fail.
TMPD="$(mktemp -d)"; REPO="$TMPD/repo"; STUBS="$TMPD/stubs"
CALLS="$TMPD/calls.log"; OUT="$TMPD/out.txt"
STATUS=0

mkdir -p "$STUBS" "$REPO/.husky"
cat > "$STUBS/npm" <<'EOF'
#!/bin/bash
echo "npm $*" >> "$CALLS"
if [ "$1 $2" = "run lint" ]; then
  [ "${STUB_LINT_EXIT:-0}" = 0 ] || { echo "stub eslint error"; exit "$STUB_LINT_EXIT"; }
fi
exit 0
EOF
chmod +x "$STUBS/npm"

note() {
  if [ "$1" = 0 ]; then
    PASS=$((PASS+1)); echo "ok   - $2"
  else
    FAIL=$((FAIL+1)); echo "FAIL - $2"
    echo "       exit=$STATUS"
    [ -s "$CALLS" ] && { echo "       calls:"; sed 's/^/         /' "$CALLS"; }
    [ -s "$OUT" ] && { echo "       output:"; sed 's/^/         /' "$OUT"; }
  fi
}

run_hook() {
  : > "$CALLS"
  cp "$HOOK" "$REPO/.husky/pre-push" 2>/dev/null || { STATUS=127; return; }
  # husky runs hooks under `sh -e`; a pre-push hook reads the ref list on stdin.
  ( cd "$REPO" && printf 'refs/heads/x 0 refs/heads/x 0\n' \
      | env PATH="$STUBS:/usr/bin:/bin" CALLS="$CALLS" "$@" sh -e .husky/pre-push origin url ) > "$OUT" 2>&1
  STATUS=$?
}
called() { grep -q -- "$1" "$CALLS"; }

# 1. the hook runs the project-wide lint script CI runs
run_hook
[ "$STATUS" = 0 ] && called "npm run lint"
note $? "pre-push runs npm run lint"

# 2. a lint failure blocks the push and says what to do
run_hook STUB_LINT_EXIT=1
[ "$STATUS" != 0 ] && grep -q "stub eslint error" "$OUT" && grep -q "npm run lint" "$OUT"
note $? "a lint failure blocks the push with the eslint output and a hint"

rm -rf "$TMPD"
echo "---"; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
