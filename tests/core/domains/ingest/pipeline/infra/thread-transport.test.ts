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
});
