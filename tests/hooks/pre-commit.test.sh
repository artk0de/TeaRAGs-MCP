#!/usr/bin/env bash
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HOOK="$ROOT/.husky/pre-commit"
PASS=0; FAIL=0

# The hook reads the STAGED set of whatever repository it runs in, so every case
# runs a copy of it inside a throwaway repository. npm and npx are stubs that log
# their argv: what is under test is the hook's decisions (build or not, which
# vitest flags), not lint-staged, tsc or vitest themselves.
TMPD="$(mktemp -d)"; REPO="$TMPD/repo"; STUBS="$TMPD/stubs"
CALLS="$TMPD/calls.log"; OUT="$TMPD/out.txt"
STATUS=0

mkdir -p "$STUBS"
ln -s "$(command -v git)" "$STUBS/git"
cat > "$STUBS/npx" <<'EOF'
#!/bin/bash
echo "npx $*" >> "$CALLS"
EOF
# `npm run build` materializes build/ the way tsc would; STUB_BUILD_EXIT makes it fail.
cat > "$STUBS/npm" <<'EOF'
#!/bin/bash
echo "npm $*" >> "$CALLS"
if [ "$1 $2" = "run build" ]; then
  [ "${STUB_BUILD_EXIT:-0}" = 0 ] || { echo "stub tsc error"; exit "$STUB_BUILD_EXIT"; }
  mkdir -p build
fi
exit 0
EOF
chmod +x "$STUBS/npx" "$STUBS/npm"

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

fresh_repo() {
  rm -rf "$REPO"; mkdir -p "$REPO/.husky"
  : > "$CALLS"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email hook@example.com
  git -C "$REPO" config user.name "hook test"
  printf 'seed\n' > "$REPO/README.md"
  git -C "$REPO" add -A
  git -C "$REPO" commit -qm seed
  cp "$HOOK" "$REPO/.husky/pre-commit"
  # The hook runs this repo-relative script first; outside a merge it is a no-op.
  mkdir -p "$REPO/scripts/git"
  cp "$ROOT/scripts/git/repin-on-merge.sh" "$REPO/scripts/git/repin-on-merge.sh"
}

stage() { mkdir -p "$REPO/$(dirname "$1")"; printf '%s\n' "${2:-x}" > "$REPO/$1"; git -C "$REPO" add -- "$1"; }

# /usr/bin:/bin keeps the coreutils the hook shells out to and leaves out every
# real npm, npx and bd — none of them may run against the throwaway repository.
run_hook() {
  ( cd "$REPO" && env PATH="$STUBS:/usr/bin:/bin" CALLS="$CALLS" "$@" bash .husky/pre-commit ) > "$OUT" 2>&1
  STATUS=$?
}
called()   { grep -q -- "$1" "$CALLS"; }
line_of()  { grep -n -- "$1" "$CALLS" | head -1 | cut -d: -f1; }

# 1. bd hyj9d: a fresh worktree has no build/, and every worker-forking test
#    dies on MODULE_NOT_FOUND without it — the hook builds once, BEFORE the tests
fresh_repo
stage "src/core/foo.ts" "export const foo = 1;"
run_hook
[ "$STATUS" = 0 ] && called "npm run build" && called "npm test" \
  && [ "$(line_of "npm run build")" -lt "$(line_of "npm test")" ]
note $? "missing build/ with src/ staged builds once before the tests"

# 2. an existing build/ is left alone — the hook does not rebuild on every commit
fresh_repo
mkdir -p "$REPO/build"
stage "src/core/foo.ts" "export const foo = 1;"
run_hook
[ "$STATUS" = 0 ] && ! called "npm run build" && called "npm test"
note $? "an existing build/ is not rebuilt"

# 3. a failed build stops the commit with its own message; tests never run
#    against a half-written build/
fresh_repo
stage "src/core/foo.ts" "export const foo = 1;"
run_hook STUB_BUILD_EXIT=2
[ "$STATUS" = 1 ] && ! called "npm test" && grep -q "build failed" "$OUT" && grep -q "stub tsc error" "$OUT"
note $? "a failed build fails the hook before any test runs, showing the build output"

# 4. no src/ staged means no tests, so nothing needs build/ — no build either
fresh_repo
stage "docs/notes.md" "changed"
run_hook
[ "$STATUS" = 0 ] && ! called "npm run build" && ! called "npm test"
note $? "a commit with no src/ changes does not build"

# 5. bd 3xtg7 / 0qaht.27 / bbo1h.5: the related-tests run carries an explicit
#    --maxWorkers cap (re-measured at 6 once the per-file process fleets shrank)
fresh_repo
mkdir -p "$REPO/build"
stage "src/core/foo.ts" "export const foo = 1;"
run_hook
[ "$STATUS" = 0 ] && grep -E "^npm test -- related .*--maxWorkers=6( |$)" "$CALLS" >/dev/null
note $? "the related-tests run is capped at --maxWorkers=6"

rm -rf "$TMPD"
echo "---"; echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
