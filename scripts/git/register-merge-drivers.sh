#!/bin/sh
# Register the repository's custom merge drivers in the local git config.
# Git versions the `merge=<driver>` attribute (.gitattributes) but not the
# driver definition, so package.json `prepare` runs this on every npm install.
# A no-op outside a git checkout (npm install from a tarball).
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# version-pins: keep ours (%A untouched) and report a clean merge. The real
# content is recomputed by scripts/git/repin-on-merge.sh inside the merge commit.
git config merge.version-pins.name "keep ours; version pins are recomputed by scripts/git/repin-on-merge.sh"
git config merge.version-pins.driver true
