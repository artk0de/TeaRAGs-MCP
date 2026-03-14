#!/bin/bash
# Escape angle brackets in CHANGELOG.md for Docusaurus MDX compatibility.
# Preserves <small> tags used for version headers.
# Called by semantic-release @semantic-release/exec prepareCmd.

set -euo pipefail

FRONTMATTER='---
title: Changelog
sidebar_position: 99
---'

{
  echo "$FRONTMATTER"
  echo
  # Escape < and > but preserve <small> and </small> tags
  sed -E \
    -e 's/<small>/__SMALL_OPEN__/g' \
    -e 's/<\/small>/__SMALL_CLOSE__/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/__SMALL_OPEN__/<small>/g' \
    -e 's/__SMALL_CLOSE__/<\/small>/g' \
    CHANGELOG.md
} > website/docs/changelog.md
