import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProcessTransport } from "../../../../../../src/core/domains/ingest/pipeline/infra/process-transport.js";

const WORKER_SRC = `
import { createWorkerRuntime } from "${join(process.cwd(), "build/core/domains/ingest/pipeline/infra/worker-runtime.js")}";
const rt = createWorkerRuntime();
const init = await rt.init();
rt.onShutdown(() => process.exit(0));
rt.onRequest((req) => rt.respond({ doubled: req.n * 2, base: init.base }));
`;

/**
 * Worker that deliberately ignores shutdown so terminate() must SIGKILL it.
 * Uses raw IPC so it can receive the init message without crashing on unknown messages.
 */
const STUBBORN_WORKER_SRC = `
process.on("message", () => {
  // intentionally ignore all messages, including shutdown
});
// Keep alive indefinitely — only SIGKILL will stop it
`;

describe("ProcessTransport", () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-"));
  const workerPath = join(dir, "pt-worker.mjs");
  const stubbornWorkerPath = join(dir, "pt-stubborn-worker.mjs");
  writeFileSync(workerPath, WORKER_SRC, "utf8");
  writeFileSync(stubbornWorkerPath, STUBBORN_WORKER_SRC, "utf8");
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("forks a child, injects init, round-trips, and exits on shutdown", async () => {
    const transport = new ProcessTransport<{ n: number }, { doubled: number; base: number }>(workerPath);
    const handle = transport.spawn({ base: 7 });
    const got = await new Promise<{ doubled: number; base: number }>((resolve, reject) => {
      handle.onMessage((m) => {
        resolve(m as { doubled: number; base: number });
      });
      handle.onError(reject);
      handle.post({ n: 4 });
    });
    expect(got).toEqual({ doubled: 8, base: 7 });
    const exited = new Promise<void>((resolve) => {
      handle.onExit(resolve);
    });
    handle.shutdown();
    await exited;
  });

  it("terminate() SIGKILLs a process that is still running and resolves after exit", async () => {
    const transport = new ProcessTransport<object, object>(stubbornWorkerPath);
    const handle = transport.spawn({});

    // Wait briefly to ensure the child has started (IPC channel is ready after fork)
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // terminate() must resolve — it awaits the "exit" event after SIGKILL
    await expect(handle.terminate()).resolves.toBeUndefined();
  });

  it("terminate() is a no-op when the process has already exited", async () => {
    const transport = new ProcessTransport<{ n: number }, { doubled: number; base: number }>(workerPath);
    const handle = transport.spawn({ base: 3 });

    // Wait for a round-trip to confirm the process is fully started
    await new Promise<void>((resolve, reject) => {
      handle.onMessage(() => {
        resolve();
      });
      handle.onError(reject);
      handle.post({ n: 1 });
    });

    // Trigger clean shutdown and wait for exit
    const exited = new Promise<void>((resolve) => {
      handle.onExit(resolve);
    });
    handle.shutdown();
    await exited;

    // Now the process is gone — terminate() should resolve immediately without error
    await expect(handle.terminate()).resolves.toBeUndefined();
  });
});
