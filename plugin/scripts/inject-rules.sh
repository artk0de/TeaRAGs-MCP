#!/bin/bash
# Resolve plugin root relative to this script
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
cat "$PLUGIN_ROOT/rules/search-cascade.md"
