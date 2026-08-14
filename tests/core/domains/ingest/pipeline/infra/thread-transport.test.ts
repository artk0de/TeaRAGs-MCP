import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ThreadTransport } from "../../../../../../src/core/domains/ingest/pipeline/infra/thread-transport.js";

// A trivial worker that echoes { n } -> { doubled } and exits on shutdown.
const WORKER_SRC = `
import { parentPort, workerData } from "node:worker_threads";
parentPort.on("message", (m) => {
  if (m && m.type === "shutdown") { parentPort.close(); return; }
  parentPort.postMessage({ doubled: m.n * 2, base: workerData.base });
});
`;

// A worker that reports back the resource limits V8 is actually enforcing on
// it. `resourceLimits` is the applied value, not the requested one, which makes
// the ceiling observable without allocating anything: an un-capped worker
// reports the process-wide old-generation default (4096 MB on Node 24), a
// capped one reports the cap.
const LIMITS_WORKER_SRC = `
import { parentPort, resourceLimits } from "node:worker_threads";
parentPort.on("message", () => {
  parentPort.postMessage({ maxOldGenerationSizeMb: resourceLimits.maxOldGenerationSizeMb });
});
`;

// A worker that reports back its own execArgv, so the --cpu-prof wiring is
// observable without actually writing a profile to disk.
const EXEC_ARGV_WORKER_SRC = `
import { parentPort } from "node:worker_threads";
parentPort.on("message", () => {
  parentPort.postMessage({ execArgv: process.execArgv });
});
`;

// A worker that reports back the stack size limit V8 is actually enforcing on
// it, same observability trick as LIMITS_WORKER_SRC above (applied value, not
// requested).
const STACK_LIMITS_WORKER_SRC = `
import { parentPort, resourceLimits } from "node:worker_threads";
parentPort.on("message", () => {
  parentPort.postMessage({ stackSizeMb: resourceLimits.stackSizeMb });
});
`;

describe("ThreadTransport", () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-"));
  const workerPath = join(dir, "echo-worker.mjs");
  writeFileSync(workerPath, WORKER_SRC, "utf8");
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("spawns a worker, injects init as workerData, round-trips a message, and shuts down", async () => {
    const transport = new ThreadTransport<{ n: number }, { doubled: number; base: number }>(workerPath);
    const handle = transport.spawn({ base: 10 });
    const got = await new Promise<{ doubled: number; base: number }>((resolve, reject) => {
      handle.onMessage((m) => {
        resolve(m as { doubled: number; base: number });
      });
      handle.onError(reject);
      handle.post({ n: 21 });
    });
    expect(got.doubled).toBe(42);
    expect(got.base).toBe(10);
    const exited = new Promise<void>((resolve) => {
      handle.onExit(resolve);
    });
    handle.shutdown();
    await exited;
  });

  /**
   * bd tea-rags-mcp-8qf86 — the heap ceiling that stops a runaway enrichment
   * worker from taking the host's memory with it.
   *
   * Asserted against the limit V8 APPLIED rather than the options object handed
   * to the constructor, so the test would still catch the cap being silently
   * dropped or clamped. Nothing is allocated: deliberately, because a test that
   * proves the cap by exhausting it must allocate the PROCESS default (4 GB on
   * Node 24) whenever the cap fails to apply — which is the exact hazard this
   * whole change exists to remove.
   */
  async function appliedHeapCeilingMb(limit?: number): Promise<number | undefined> {
    const path = join(dir, "limits-worker.mjs");
    writeFileSync(path, LIMITS_WORKER_SRC, "utf8");
    const transport = new ThreadTransport<Record<string, never>, { maxOldGenerationSizeMb?: number }>(path, limit);
    const handle = transport.spawn({});
    try {
      return await new Promise<number | undefined>((resolve, reject) => {
        handle.onMessage((m) => {
          resolve((m as { maxOldGenerationSizeMb?: number }).maxOldGenerationSizeMb);
        });
        handle.onError(reject);
        handle.post({});
      });
    } finally {
      await handle.terminate();
    }
  }

  it("caps the spawned worker's heap at the configured ceiling", async () => {
    expect(await appliedHeapCeilingMb(64)).toBe(64);
  });

  it("leaves the worker on the process-wide heap limit when no ceiling is configured", async () => {
    const uncapped = await appliedHeapCeilingMb();

    // The pre-guard behaviour, still reachable by omitting the ceiling: nothing
    // stops the thread short of the whole process's limit. This is the state
    // that let one worker climb to 2.6 GB and drive the host into swap.
    expect(uncapped).toBeGreaterThan(1024);
  });

  it("treats a zero ceiling as no ceiling rather than capping the worker at nothing", async () => {
    expect(await appliedHeapCeilingMb(0)).toBeGreaterThan(1024);
  });

  /**
   * bd tea-rags-mcp-2j8s1 follow-up — Node's worker_threads default stack
   * (4 MB) is too small for `ts.createProgram`'s recursive module-resolution
   * walk on a large, barrel-connected TypeScript corpus: measured in
   * isolation, the default stack made 270/300 acquire() calls overflow and
   * fall through TSProgramCache#build's null-return path, each failed attempt
   * still costing real CPU and never populating the coverage cache (82.4s for
   * 300 files); an 8 MB stack made every one of those calls succeed on the
   * first try (1.5s for the same 300 files, programBuilds 300 -> 1). Same
   * observability approach as the heap ceiling above: assert the APPLIED
   * limit, not the requested one, and allocate nothing.
   */
  async function appliedStackSizeMb(limit?: number): Promise<number | undefined> {
    const path = join(dir, "stack-limits-worker.mjs");
    writeFileSync(path, STACK_LIMITS_WORKER_SRC, "utf8");
    const transport = new ThreadTransport<Record<string, never>, { stackSizeMb?: number }>(
      path,
      undefined,
      undefined,
      limit,
    );
    const handle = transport.spawn({});
    try {
      return await new Promise<number | undefined>((resolve, reject) => {
        handle.onMessage((m) => {
          resolve((m as { stackSizeMb?: number }).stackSizeMb);
        });
        handle.onError(reject);
        handle.post({});
      });
    } finally {
      await handle.terminate();
    }
  }

  it("caps the spawned worker's stack at the configured size", async () => {
    expect(await appliedStackSizeMb(16)).toBe(16);
  });

  it("leaves the worker on node's own default stack size when none is configured", async () => {
    const uncapped = await appliedStackSizeMb();

    // Node's own worker_threads default (4 MB as of Node 24) -- the size that
    // made ts.createProgram overflow on a large barrel-connected corpus.
    expect(uncapped).toBe(4);
  });

  it("treats a zero stack size as no override rather than a zero-byte stack", async () => {
    expect(await appliedStackSizeMb(0)).toBe(4);
  });

  /**
   * Diagnostic-only `--cpu-prof` wiring: opt-in, so absence must be the
   * default, and when present it must not clobber execArgv the worker would
   * otherwise inherit.
   */
  describe("cpuProfileDir", () => {
    async function workerExecArgv(cpuProfileDir?: string): Promise<string[]> {
      const path = join(dir, "exec-argv-worker.mjs");
      writeFileSync(path, EXEC_ARGV_WORKER_SRC, "utf8");
      const transport = new ThreadTransport<Record<string, never>, { execArgv: string[] }>(
        path,
        undefined,
        cpuProfileDir,
      );
      const handle = transport.spawn({});
      try {
        return await new Promise<string[]>((resolve, reject) => {
          handle.onMessage((m) => {
            resolve((m as { execArgv: string[] }).execArgv);
          });
          handle.onError(reject);
          handle.post({});
        });
      } finally {
        await handle.terminate();
      }
    }

    it("leaves execArgv untouched when no profile directory is configured", async () => {
      expect(await workerExecArgv()).toEqual(process.execArgv);
    });

    it("adds --cpu-prof and --cpu-prof-dir on top of the inherited execArgv when configured", async () => {
      const execArgv = await workerExecArgv("/tmp/profiles");
      expect(execArgv).toContain("--cpu-prof");
      expect(execArgv).toContain("--cpu-prof-dir=/tmp/profiles");
      for (const inherited of process.execArgv) {
        expect(execArgv).toContain(inherited);
      }
    });
  });
});
