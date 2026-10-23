#!/bin/sh
# Regenerate the generated plugin packages inside a merge / cherry-pick commit.
#
# Everything under a `merge=tea-rags-generated` path in .gitattributes is
# rendered from plugins/** by `npm run gen:plugins`, so neither side's copy is
# right after a merge that brought a source or package change. The
# `tea-rags-generated` merge driver (scripts/git/register-merge-drivers.sh) keeps
# ours so those paths never stop a merge; this script then regenerates against
# the merged sources. .gitattributes is the one list of generated paths.
# Entry points mirror scripts/git/repin-on-merge.sh:
#
#   (no arg)        .husky/pre-commit — a merge / cherry-pick concluded by
#                   `git commit`. Regenerates and stages the changed packages.
#   --mark-merge    .husky/pre-merge-commit — a clean `git merge`; records the
#                   pre-merge HEAD for --post-merge (the tree is already written).
#   --post-merge    .husky/post-merge — if --mark-merge recorded this merge,
#                   regenerates and rewrites the merge commit just created with
#                   the regenerated files replaced (parents, message, author kept).
#
# Skipped when the merged-in side changed neither plugins/** nor a generated
# path: the result is then ours, already as fresh as it was. A rebase replays
# picks without hooks and keeps whatever each pick carried; release regenerates.
#
# MERGE_GENERATED_CMD overrides the generator (tests stub it).
set -eu

git_dir=$(git rev-parse --git-dir)
mark="$git_dir/GENERATED_MERGE"

# Exit status 0 iff the diff $1..$2 touches a source or a generated path.
touches_generation() {
  git diff --name-only "$1" "$2" | git check-attr --stdin merge \
    | grep -Eq '^plugins/|: merge: tea-rags-generated$'
}

# Generated paths that differ from the index (modified, deleted or new).
changed_generated() {
  git ls-files -m -d -o --exclude-standard | sort -u | git check-attr --stdin merge \
    | sed -n 's/: merge: tea-rags-generated$//p'
}

regenerate() {
  cd "$(git rev-parse --show-toplevel)"
  echo "🔁 Merge in progress — regenerating plugin packages (npm run gen:plugins)..."
  if ! sh -c "${MERGE_GENERATED_CMD:-npm run -s gen:plugins}"; then
    echo "❌ Regenerating plugin packages failed — the merge commit would carry stale packages." >&2
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
    touches_generation "$(git merge-base 'HEAD^1' 'HEAD^2')" 'HEAD^2' || exit 0
    regenerate
    files=$(changed_generated)
    [ -n "$files" ] || exit 0
    printf '%s\n' "$files" | git update-index --add --remove --stdin
    # The tree is HEAD's with only the regenerated paths replaced.
    old=$(git rev-parse HEAD)
    tmp_index="$git_dir/GENERATED_MERGE_INDEX"
    GIT_INDEX_FILE="$tmp_index" git read-tree HEAD
    printf '%s\n' "$files" | GIT_INDEX_FILE="$tmp_index" git update-index --add --remove --stdin
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
    git update-ref -m "merge: regenerate plugin packages" HEAD "$new" "$old"
    echo "✓ Regenerated plugin packages folded into merge commit $(git rev-parse --short HEAD)."
    ;;
  "")
    if [ -f "$git_dir/MERGE_HEAD" ]; then
      theirs=$(head -n 1 "$git_dir/MERGE_HEAD")
      base=$(git merge-base HEAD "$theirs")
    elif [ -f "$git_dir/CHERRY_PICK_HEAD" ]; then
      theirs=$(cat "$git_dir/CHERRY_PICK_HEAD")
      base="$theirs^"
    else
      exit 0
    fi
    touches_generation "$base" "$theirs" || exit 0
    regenerate
    changed_generated | git update-index --add --remove --stdin
    ;;
  *)
    echo "merge-generated.sh: unknown argument '$1'" >&2
    exit 2
    ;;
esac
