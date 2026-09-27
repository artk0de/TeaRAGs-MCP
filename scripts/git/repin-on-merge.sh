#!/bin/sh
# Recompute the language version pins inside a merge / cherry-pick commit.
#
# tests/core/domains/language/capability/version-pins.json is DERIVED from the
# merged sources, so neither side's copy is right after a merge. The
# `version-pins` merge driver (scripts/git/register-merge-drivers.sh) keeps ours
# so the file never stops a merge; this script then re-pins against the merged
# tree. Three entry points:
#
#   (no arg)        .husky/pre-commit — a merge / cherry-pick concluded by
#                   `git commit`. Re-pins and stages; `git commit` re-reads the
#                   index after pre-commit, so the pins land in that commit.
#   --mark-merge    .husky/pre-merge-commit — a clean `git merge`. Git has
#                   ALREADY written the merge tree when this hook runs (and has
#                   not written MERGE_HEAD yet), so staging here cannot reach the
#                   commit. Records the pre-merge HEAD for --post-merge instead.
#   --post-merge    .husky/post-merge — if --mark-merge recorded this merge,
#                   re-pins and rewrites the merge commit just created with ONLY
#                   the pins blob replaced (parents, message, author kept;
#                   plumbing, since `commit --amend` refuses while MERGE_HEAD
#                   exists, and it still does in post-merge). A fast-forward runs no
#                   pre-merge-commit, leaves no mark, and is never rewritten.
#
# Known gap: `git rebase` replays picks without running pre-commit, so a rebase
# keeps the driver's "ours" copy — the version-pins test stays the backstop.
#
# REPIN_CMD overrides the pin command (tests stub it).
set -eu

PINS="tests/core/domains/language/capability/version-pins.json"
git_dir=$(git rev-parse --git-dir)
mark="$git_dir/VERSION_PINS_MERGE"

repin() {
  cd "$(git rev-parse --show-toplevel)"
  echo "🔁 Merge in progress — re-pinning language versions ($PINS)..."
  if ! sh -c "${REPIN_CMD:-npm run pin:lang-versions}"; then
    echo "❌ Re-pinning language versions failed — the merge commit would carry stale pins." >&2
    exit 1
  fi
}

case "${1:-}" in
  --mark-merge)
    git rev-parse HEAD >"$mark"
    ;;
  --post-merge)
    [ -f "$mark" ] || exit 0
    pre_merge_head=$(cat "$mark")
    rm -f "$mark"
    # Only the merge commit this mark was written for: two parents, the first
    # being the HEAD recorded before the merge.
    [ "$(git rev-parse -q --verify 'HEAD^2' || true)" != "" ] || exit 0
    [ "$(git rev-parse 'HEAD^1')" = "$pre_merge_head" ] || exit 0
    repin
    git add -- "$PINS"
    if git diff --cached --quiet HEAD -- "$PINS"; then
      exit 0
    fi
    # The tree is HEAD's with only the pins blob replaced.
    old=$(git rev-parse HEAD)
    blob=$(git hash-object -w -- "$PINS")
    tmp_index="$git_dir/VERSION_PINS_INDEX"
    GIT_INDEX_FILE="$tmp_index" git read-tree HEAD
    GIT_INDEX_FILE="$tmp_index" git update-index --cacheinfo "100644,$blob,$PINS"
    tree=$(GIT_INDEX_FILE="$tmp_index" git write-tree)
    rm -f "$tmp_index"
    parent_args=""
    for parent in $(git rev-list --parents -n 1 HEAD | cut -d' ' -f2-); do
      parent_args="$parent_args -p $parent"
    done
    # shellcheck disable=SC2086 # word splitting IS the -p argument list
    new=$(git log -1 --format=%B HEAD | \
      GIT_AUTHOR_NAME=$(git log -1 --format=%an HEAD) \
      GIT_AUTHOR_EMAIL=$(git log -1 --format=%ae HEAD) \
      GIT_AUTHOR_DATE=$(git log -1 --format=%ad --date=raw HEAD) \
      git commit-tree "$tree" $parent_args)
    git update-ref -m "merge: re-pin language version pins" HEAD "$new" "$old"
    echo "✓ Re-pinned language versions folded into merge commit $(git rev-parse --short HEAD)."
    ;;
  "")
    if [ ! -f "$git_dir/MERGE_HEAD" ] && [ ! -f "$git_dir/CHERRY_PICK_HEAD" ]; then
      exit 0
    fi
    repin
    git add -- "$PINS"
    ;;
  *)
    echo "repin-on-merge.sh: unknown argument '$1'" >&2
    exit 2
    ;;
esac
