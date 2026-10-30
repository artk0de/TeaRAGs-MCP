#!/bin/sh
# Discriminator batch: each variant x2, three variants in parallel.
cd "$(dirname "$0")" || exit 1
for c in E14b E15nl E16b; do
  ( python3 run.py "$c" r1 && python3 run.py "$c" r2 ) > "/tmp/lag-$c.log" 2>&1 &
done
wait
echo BATCH DONE
