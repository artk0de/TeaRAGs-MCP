/**
 * `npm run build` pre-step (bd tea-rags-mcp-f924y): sweep this checkout's
 * orphaned index workers before `tsc` rewrites the build they run from.
 *
 * Scope is ONE checkout's `build/` on purpose. The machine is shared by
 * parallel sessions, each building its own worktree, and the daemons are shared
 * too, so nothing outside this build is touched:
 *
 * - `index-codebase` workers of this build whose CLI died before handing them
 *   off are stopped — the same proof and the same rule as
 *   `tea-rags doctor --sweep-workers`.
 * - Live workers of this build are reported, not stopped: the rebuild swaps the
 *   code their next worker thread or chunker child loads.
 * - The codegraph daemon is left alone. It loads nothing from `build/` after
 *   start, and the build handshake already restarts it from the new build on
 *   the next client connect; draining it here would cut off every other
 *   session using it.
 * - The embedded Qdrant daemon runs a downloaded binary outside `build/`; a
 *   rebuild does not change it.
 *
 * Never fails the build: a sweep that cannot run says so and steps aside.
 */

import { realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { IndexWorkerRegistry, indexWorkerRegistryDir } from "../src/cli/index-progress/worker-registry.js";
import {
  psIndexWorkerProcessProbe,
  sweepIndexWorkers,
  type IndexWorkerProcessProbe,
} from "../src/cli/index-progress/worker-sweep.js";

export interface PrebuildWorkerSweepDeps {
  /** The checkout being built. */
  repoRoot: string;
  registry: IndexWorkerRegistry;
  probe: IndexWorkerProcessProbe;
  now: () => number;
  log: (line: string) => void;
}

export async function prebuildWorkerSweep(deps: PrebuildWorkerSweepDeps): Promise<void> {
  try {
    const buildDir = `${join(realpathSync(deps.repoRoot), "build")}${sep}`;
    const outcomes = await sweepIndexWorkers(deps.registry, deps.probe, {
      now: deps.now,
      entryScriptPrefix: buildDir,
    });
    for (const { record, verdict, action } of outcomes) {
      if (action === "killed") {
        deps.log(`[prebuild] stopped orphaned index worker ${record.pid} (${record.projectPath})`);
      } else if (action === "kill-failed") {
        deps.log(`[prebuild] warning: orphaned index worker ${record.pid} (${record.projectPath}) did not exit`);
      } else if (action === "kept") {
        deps.log(
          `[prebuild] warning: index worker ${record.pid} from this build is still running ` +
            `(${verdict}, ${record.projectPath}) — the rebuild swaps its code underneath it`,
        );
      }
    }
  } catch (error) {
    deps.log(`[prebuild] worker sweep skipped: ${(error as Error).message}`);
  }
}

/* v8 ignore start -- process entry; the sweep itself is covered through prebuildWorkerSweep */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform !== "win32") {
    await prebuildWorkerSweep({
      repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      registry: new IndexWorkerRegistry(indexWorkerRegistryDir()),
      probe: psIndexWorkerProcessProbe,
      now: Date.now,
      log: (line) => {
        process.stderr.write(`${line}\n`);
      },
    });
  }
}
/* v8 ignore stop */
