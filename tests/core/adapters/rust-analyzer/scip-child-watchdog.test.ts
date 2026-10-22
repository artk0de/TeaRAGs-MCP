/**
 * The `rust-analyzer scip` child runs detached (its own process group), so
 * nothing reaps it when the thread that spawned it goes away — the wall-budget
 * poller dies with that thread. The spawn registers an exit hook that kills
 * the tree; this pins that it fires when an enrichment worker is terminated
 * mid-run (bd s3i8m.6 R2b). Runs the COMPILED runner inside a real worker
 * thread, so it needs `npm run build`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

import type { RustAnalyzerScipRunnerDeps } from "../../../../src/core/adapters/rust-analyzer/index.js";

const RUNNER_MODULE = resolve(__dirname, "../../../../build/core/adapters/rust-analyzer/scip-runner.js");

/**
 * Whether any process of the group `pgid` still runs, as `ps` sees it. A killed
 * child whose spawning thread is gone may linger as a zombie nobody reaps —
 * dead, but still answering `kill(pid, 0)` — so zombies do not count.
 */
function groupAlive(pgid: number): boolean {
  const rows = spawnSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8" }).stdout.split("\n");
  return rows.some((row) => {
    const [group, state] = row.trim().split(/\s+/);
    return Number(group) === pgid && state !== undefined && !state.startsWith("Z");
  });
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return condition();
}

describe.skipIf(!existsSync(RUNNER_MODULE) || process.platform === "win32")(
  "rust-analyzer scip child — exit hook (bd s3i8m.6 R2b)",
  () => {
    it("kills the detached child when its worker thread is terminated", async () => {
      const worker = new Worker(
        `
        const { parentPort, workerData } = require("node:worker_threads");
        import(workerData.runnerUrl).then(({ defaultRustAnalyzerScipRunnerDeps }) => {
          const child = defaultRustAnalyzerScipRunnerDeps().spawn("sleep", ["60"], {
            env: process.env,
            onOutput: () => {},
          });
          parentPort.postMessage(child.pid);
        });
        `,
        { eval: true, workerData: { runnerUrl: pathToFileURL(RUNNER_MODULE).href } },
      );
      const pid = await new Promise<number>((done, fail) => {
        worker.once("message", done);
        worker.once("error", fail);
      });
      try {
        expect(pid).toBeGreaterThan(0);
        expect(groupAlive(pid)).toBe(true);

        await worker.terminate();

        expect(await waitUntil(() => !groupAlive(pid), 3000)).toBe(true);
      } finally {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    });

    it("passes the command's output and exit code through, and leaves no process behind", async () => {
      const { defaultRustAnalyzerScipRunnerDeps } = (await import(pathToFileURL(RUNNER_MODULE).href)) as {
        defaultRustAnalyzerScipRunnerDeps: () => RustAnalyzerScipRunnerDeps;
      };
      let output = "";
      const child = defaultRustAnalyzerScipRunnerDeps().spawn("/bin/sh", ["-c", "echo scip-out; exit 3"], {
        env: process.env,
        onOutput: (chunk) => {
          output += chunk;
        },
      });

      expect(await child.exited).toEqual({ code: 3, signal: null });
      expect(output).toBe("scip-out\n");
      expect(await waitUntil(() => !groupAlive(child.pid), 3000)).toBe(true);
    });
  },
);
