#!/bin/bash
# Escape MDX-meaningful characters in CHANGELOG.md for Docusaurus MDX compatibility.
# Preserves <small> tags used for version headers.
# Called by semantic-release @semantic-release/exec prepareCmd.
#
# Why curly braces are escaped:
#   MDX 3 parses `{ identifier }` in free text as a JSX expression and tries to
#   resolve `identifier` as a JS variable. semantic-release copies commit
#   bodies verbatim into the changelog, so any TypeScript destructuring or
#   record literal in a commit message (e.g. `{ collectionName, ... }`) breaks
#   the docs build with `ReferenceError`. HTML entities render as plain text
#   and bypass MDX's expression parser entirely.

set -euo pipefail

FRONTMATTER='---
title: Changelog
sidebar_position: 99
---'

{
  echo "$FRONTMATTER"
  echo
  # Escape <, >, {, } but preserve <small> and </small> tags
  sed -E \
    -e 's/<small>/__SMALL_OPEN__/g' \
    -e 's/<\/small>/__SMALL_CLOSE__/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/\{/\&#123;/g' \
    -e 's/\}/\&#125;/g' \
    -e 's/__SMALL_OPEN__/<small>/g' \
    -e 's/__SMALL_CLOSE__/<\/small>/g' \
    CHANGELOG.md
} > website/docs/changelog.md
