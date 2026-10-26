#!/usr/bin/env bash
# Generated plugin packages never stop a merge and come out of it fresh:
# `.gitattributes` routes them to the `tea-rags-generated` driver (keep ours),
# and scripts/git/merge-generated.sh regenerates them inside the merge commit.
#
# Every case runs in a throwaway repository with a stub generator: a header line
# carrying a digest of the whole source (so two edits anywhere in the source
# collide on that line), then the source upper-cased.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0; FAIL=0

# Hooks of the REAL repository export GIT_DIR / GIT_INDEX_FILE; inherited, they
# would aim every command below at it.
for var in $(env | sed -n 's/^\(GIT_[A-Z_]*\)=.*/\1/p'); do unset "$var"; done
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=t@example.com

TMPD="$(mktemp -d)"; REPO="$TMPD/repo"; OUT="$TMPD/out.txt"; CALLS="$TMPD/gen-calls"
trap 'rm -rf "$TMPD"' EXIT
export MERGE_GENERATED_CMD="sh scripts/gen.sh"

note() {
  if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "ok   - $2"
  else FAIL=$((FAIL+1)); echo "FAIL - $2"; [ -s "$OUT" ] && sed 's/^/         /' "$OUT"; fi
}

# Same hook lines as .husky/{pre-merge-commit,post-merge,pre-commit}.
install_hooks() {
  mkdir -p "$REPO/hooks"
  printf '#!/bin/sh\nsh scripts/git/merge-generated.sh --mark-merge\n' > "$REPO/hooks/pre-merge-commit"
  printf '#!/bin/sh\nsh scripts/git/merge-generated.sh --post-merge || exit 1\n' > "$REPO/hooks/post-merge"
  printf '#!/bin/sh\nsh scripts/git/merge-generated.sh || exit 1\n' > "$REPO/hooks/pre-commit"
  chmod +x "$REPO/hooks/"*
  git -C "$REPO" config core.hooksPath hooks
}

fresh_repo() {
  rm -rf "$REPO"; mkdir -p "$REPO/scripts/git" "$REPO/plugins/p" "$REPO/harness"
  : > "$CALLS"
  git -C "$REPO" init -q -b main
  cp "$ROOT/scripts/git/merge-generated.sh" "$ROOT/scripts/git/register-merge-drivers.sh" "$REPO/scripts/git/"
  cp "$ROOT/.gitattributes" "$REPO/.gitattributes"
  cat > "$REPO/scripts/gen.sh" <<EOF
#!/bin/sh
echo gen >> "$CALLS"
{ echo "# digest \$(cksum < plugins/p/src.txt)"; tr a-z A-Z < plugins/p/src.txt; } > harness/out.txt
EOF
  printf 'harness/** merge=tea-rags-generated\n' >> "$REPO/.gitattributes"
  printf 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n' > "$REPO/plugins/p/src.txt"
  printf 'seed\n' > "$REPO/notes.txt"
  ( cd "$REPO" && sh scripts/git/register-merge-drivers.sh && sh scripts/gen.sh )
  git -C "$REPO" add -A && git -C "$REPO" commit -qm seed
  : > "$CALLS"
}

# Commits `sed` script $2 over the source on branch $1, regenerated as a developer would.
edit_on() {
  git -C "$REPO" checkout -q -B "$1" "${3:-main}"
  ( cd "$REPO" && sed -i.bak "$2" plugins/p/src.txt && rm plugins/p/src.txt.bak && sh scripts/gen.sh )
  git -C "$REPO" add -A && git -C "$REPO" commit -qm "edit $1"
}

fresh_render() { ( cd "$REPO" && { echo "# digest $(cksum < plugins/p/src.txt)"; tr a-z A-Z < plugins/p/src.txt; } ); }
generated_fresh() { [ "$(git -C "$REPO" show HEAD:harness/out.txt)" = "$(fresh_render)" ]; }

# 1. Control: without the driver the two regenerated headers collide.
fresh_repo
git -C "$REPO" config --remove-section merge.tea-rags-generated
edit_on left 's/^l1$/L1-left/'
edit_on right 's/^l8$/l8-right/' main
git -C "$REPO" checkout -q left
git -C "$REPO" merge -q --no-edit right > "$OUT" 2>&1
[ $? -ne 0 ] && grep -q "harness/out.txt" "$OUT"
note $? "control: without the driver the generated file conflicts"

# 2. Two branches edit one source: clean merge, generated output == fresh render,
#    folded into the merge commit itself (two parents, clean tree).
fresh_repo; install_hooks
edit_on left 's/^l1$/L1-left/'
edit_on right 's/^l8$/l8-right/' main
git -C "$REPO" checkout -q left
git -C "$REPO" merge -q --no-edit right > "$OUT" 2>&1
STATUS=$?
[ $STATUS = 0 ] && ! grep -q '^<<<<<<<' "$REPO/harness/out.txt" && generated_fresh \
  && [ -n "$(git -C "$REPO" rev-parse -q --verify 'HEAD^2')" ] && [ -z "$(git -C "$REPO" status --porcelain)" ]
note $? "clean merge: no conflict, merge commit carries a fresh render, tree clean"

# 3. A merge bringing no source or generated change does not regenerate.
fresh_repo; install_hooks
edit_on left 's/^l1$/L1-left/'
git -C "$REPO" checkout -q -B other main
printf 'other\n' >> "$REPO/notes.txt"; git -C "$REPO" commit -qam other
git -C "$REPO" checkout -q left; : > "$CALLS"
git -C "$REPO" merge -q --no-edit other > "$OUT" 2>&1
[ $? = 0 ] && [ ! -s "$CALLS" ]
note $? "merge without source or generated changes skips regeneration"

# 4. Conflict elsewhere, concluded by `git commit`: pre-commit regenerates and stages.
fresh_repo; install_hooks
edit_on left 's/^l1$/L1-left/'
printf 'left\n' > "$REPO/notes.txt"; git -C "$REPO" commit -qam "notes left"
edit_on right 's/^l8$/l8-right/' main
printf 'right\n' > "$REPO/notes.txt"; git -C "$REPO" commit -qam "notes right"
git -C "$REPO" checkout -q left
git -C "$REPO" merge -q --no-edit right > /dev/null 2>&1
printf 'both\n' > "$REPO/notes.txt"; git -C "$REPO" add notes.txt
git -C "$REPO" commit -q --no-edit > "$OUT" 2>&1
[ $? = 0 ] && generated_fresh && [ -z "$(git -C "$REPO" status --porcelain)" ]
note $? "conflicted merge concluded by commit: fresh render committed"

# 5. A fast-forward is never rewritten.
fresh_repo; install_hooks
edit_on left 's/^l1$/L1-left/'
git -C "$REPO" checkout -q main; : > "$CALLS"
BEFORE=$(git -C "$REPO" rev-parse left)
git -C "$REPO" merge -q left > "$OUT" 2>&1
[ $? = 0 ] && [ "$(git -C "$REPO" rev-parse HEAD)" = "$BEFORE" ] && [ ! -s "$CALLS" ]
note $? "fast-forward: HEAD untouched, no regeneration"

# 6. The real repository wires the same hook lines and attributes.
grep -q 'merge-generated.sh --mark-merge' "$ROOT/.husky/pre-merge-commit" \
  && grep -q 'merge-generated.sh --post-merge' "$ROOT/.husky/post-merge" \
  && grep -q 'sh scripts/git/merge-generated.sh || exit 1' "$ROOT/.husky/pre-commit" \
  && grep -q '^harness/\*\* merge=tea-rags-generated' "$ROOT/.gitattributes" \
  && grep -q '^src/mcp/resources/generated/\*\* merge=tea-rags-generated' "$ROOT/.gitattributes"
note $? "husky hooks and .gitattributes wire the driver and the regeneration"

echo "merge-generated: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
