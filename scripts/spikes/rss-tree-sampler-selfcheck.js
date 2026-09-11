/**
 * Self-check fixture for `rss-tree-sampler.sh` (E6.0a).
 *
 * Allocates ~600 MB and KEEPS TOUCHING it, which is the whole point: a
 * `Buffer.alloc(600MB, 1)` that is written once and then left alone peaks for
 * well under one 250 ms tick — macOS reclaims and compresses the untouched
 * pages within a second, so `process.memoryUsage().rss` reads ~40 MB three
 * seconds later while `/usr/bin/time -l` still reports the 640 MB high-water
 * mark. Sampling one number and `time -l`'s other would then "disagree" for a
 * reason that has nothing to do with the sampler being wired right.
 *
 * Re-touching every 100 ms holds a PLATEAU instead of a spike, and a plateau is
 * what a codegraph build's footprint actually is. That makes the two
 * instruments comparable, which is what the self-check is for.
 *
 *   scripts/spikes/rss-tree-sampler.sh smoke node scripts/spikes/rss-tree-sampler-selfcheck.js
 *   /usr/bin/time -l node scripts/spikes/rss-tree-sampler-selfcheck.js
 *
 * The two must agree within 5 %.
 *
 * `RSS_SELFCHECK_CHILD=1` makes it fork one copy of itself, which is the OTHER
 * half of the check and the reason the sampler exists at all: the tree then
 * holds ~1.3 GB while `/usr/bin/time -l` on the parent still reports ~650 MB,
 * because the child is a separate PROCESS — exactly the DuckDB daemon's shape.
 *
 *   RSS_SELFCHECK_CHILD=1 scripts/spikes/rss-tree-sampler.sh tree \
 *     node scripts/spikes/rss-tree-sampler-selfcheck.js
 */
import { spawn } from "node:child_process";

const MB = 1024 * 1024;
if (process.env.RSS_SELFCHECK_CHILD === "1") {
  spawn(process.execPath, [import.meta.filename], {
    stdio: "inherit",
    env: { ...process.env, RSS_SELFCHECK_CHILD: "0" },
  });
}
const buffer = Buffer.alloc(600 * MB, 1);
const deadline = Date.now() + 4000;

let stamp = 0;
const timer = setInterval(() => {
  stamp = (stamp + 1) & 0xff;
  // Touch one byte per 4 KB page so every page stays resident and warm.
  for (let offset = 0; offset < buffer.length; offset += 4096) buffer[offset] = stamp;
  if (Date.now() >= deadline) {
    clearInterval(timer);
    process.stdout.write(`self rss MB ${Math.round(process.memoryUsage().rss / MB)}\n`);
  }
}, 100);
