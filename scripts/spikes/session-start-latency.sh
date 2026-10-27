#!/usr/bin/env bash
# Spike (bd tea-rags-mcp-o4p5l): wall time of the tea-rags SessionStart hooks.
# Runs each command N times and prints p50/p95 in ms.
# Usage: scripts/spikes/session-start-latency.sh <runs> <label> -- <command...>
RUNS="$1"; LABEL="$2"; shift 3
times=()
for _ in $(seq "$RUNS"); do
  t0=$(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000')
  "$@" >/dev/null 2>&1
  t1=$(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000')
  times+=($((t1 - t0)))
done
sorted=$(printf '%s\n' "${times[@]}" | sort -n | tr '\n' ' ')
read -r -a s <<<"$sorted"
n=${#s[@]}
p50=${s[$(((n + 1) / 2 - 1))]}
p95=${s[$((n - 1))]}
echo "$LABEL: runs=[${times[*]}] p50=${p50}ms p95=${p95}ms"
