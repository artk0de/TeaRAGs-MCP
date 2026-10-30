#!/bin/bash
set -o pipefail
cd /Users/artk0re/Dev/Tools/tea-rags-mcp/.claude/worktrees/swe-rebench/evals/swe-bench-lite
T=smoke-1
run() { echo "=== $(date +%T) $*"; uv run swe-lite-ab "$@" || { echo "STAGE FAILED: $* rc=$?"; exit 1; }; }
run prepare --tasks $T
run index --tasks $T
run run-paired --tasks $T --parallel 1 --seed 20261003
run collect --tasks $T --arm arm0
run collect --tasks $T --arm arm1
run evaluate --tasks $T --arm arm0
run evaluate --tasks $T --arm arm1
run report --tasks $T
echo "=== $(date +%T) ALL DONE"
