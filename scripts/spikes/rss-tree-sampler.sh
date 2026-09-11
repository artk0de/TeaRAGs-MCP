#!/bin/sh
# Peak resident set of a process TREE, sampled at 250 ms (E6.0a, bd E6).
#
#   scripts/spikes/rss-tree-sampler.sh <label> <command ...>
#
# Why a sampler and not `/usr/bin/time -l`: `time` reports the PARENT's maximum
# resident set. Worker THREADS share that address space so they are already
# counted, but the DuckDB daemon is a separate PROCESS and is not — and the
# daemon is the codegraph write path, so its resident set is part of what a live
# build costs. Offline runs are single-process and `time -l` is exact there;
# this exists for the live leg.
#
# It keeps the max of the per-tick SUMS, never the sum of per-process maxima:
# the question is how much the machine holds AT ONCE, and the per-process peaks
# need not co-occur.
#
# Known blind spot: a spike shorter than the 250 ms interval is invisible. The
# tick count is printed alongside the peak so the resolution is on the record
# rather than assumed.
#
# Self-check — must report ~650 MB, within 5 % of `/usr/bin/time -l` on the same
# fixture. A sampler that says 40 MB there is wired wrong and every number taken
# with it is void:
#
#   scripts/spikes/rss-tree-sampler.sh smoke node scripts/spikes/rss-tree-sampler-selfcheck.js
#   /usr/bin/time -l node scripts/spikes/rss-tree-sampler-selfcheck.js
#
# And the tree half, which is what `time -l` CANNOT do — ~1.3 GB across a parent
# and one child, where `time -l` on the parent still reports ~650 MB:
#
#   RSS_SELFCHECK_CHILD=1 scripts/spikes/rss-tree-sampler.sh tree \
#     node scripts/spikes/rss-tree-sampler-selfcheck.js
#
# The fixture holds a PLATEAU rather than a spike on purpose; its docblock says
# why a one-shot 600 MB allocation is not a valid target for a 250 ms sampler.
set -u

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <label> <command ...>" >&2
  exit 64
fi

label="$1"
shift

"$@" &
pid=$!

peak=0
ticks=0
while kill -0 "$pid" 2>/dev/null; do
  # ONE `ps` per tick over every process, and awk walks the ppid chain to decide
  # membership. The alternative — `pgrep -P` per generation — sees only direct
  # children, and a daemon re-parented one level down would silently drop out of
  # the sum. `ps` rss is KILOBYTES on macOS and on Linux.
  sum=$(ps -eo pid=,ppid=,rss= | awk -v root="$pid" '
    { ppid[$1] = $2; rss[$1] = $3; pids[n++] = $1 }
    END {
      total = 0
      for (i = 0; i < n; i++) {
        p = pids[i]
        cur = p
        # 64 hops is far past any real tree and ends a cycle if ps raced us.
        for (hop = 0; hop < 64 && cur != "" && cur != 0; hop++) {
          if (cur == root) { total += rss[p]; break }
          cur = ppid[cur]
        }
      }
      print total + 0
    }')
  if [ "${sum:-0}" -gt "$peak" ]; then
    peak=$sum
  fi
  ticks=$((ticks + 1))
  sleep 0.25
done

status=0
wait "$pid" || status=$?

printf '%s peak-tree-rss-mb %s (%s ticks at 250ms)\n' "$label" "$((peak / 1024))" "$ticks" >&2
exit "$status"
