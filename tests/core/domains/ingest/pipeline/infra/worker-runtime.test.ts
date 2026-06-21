import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

// A worker that uses createWorkerRuntime under the PROCESS transport: it is
// forked, so isMainThread is true -> ProcessWorkerRuntime is selected.
const WORKER_SRC = `
import { createWorkerRuntime } from "${join(process.cwd(), "build/core/domains/ingest/pipeline/infra/worker-runtime.js")}";
const rt = createWorkerRuntime();
const init = await rt.init();
rt.onShutdown(() => process.exit(0));
rt.onRequest((req) => rt.respond({ sum: req.a + init.base }));
`;

describe("ProcessWorkerRuntime (via fork)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wr-"));
  const workerPath = join(dir, "rt-worker.mjs");
  writeFileSync(workerPath, WORKER_SRC, "utf8");
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("receives init via {__init}, answers a request, exits on shutdown", async () => {
    const child = fork(workerPath, [], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child.send({ __init: { base: 100 } });
    const got = await new Promise<{ sum: number }>((resolve) => {
      child.on("message", (m) => {
        resolve(m as { sum: number });
      });
      child.send({ a: 5 });
    });
    expect(got.sum).toBe(105);
    const exited = new Promise<number>((resolve) =>
      child.on("exit", (c) => {
        resolve(c ?? -1);
      }),
    );
    child.send({ type: "shutdown" });
    expect(await exited).toBe(0);
  });
});
