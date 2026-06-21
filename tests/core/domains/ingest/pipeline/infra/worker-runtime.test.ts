import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkerRuntime,
  INIT_KEY,
} from "../../../../../../src/core/domains/ingest/pipeline/infra/worker-runtime.js";
import { SHUTDOWN_MESSAGE } from "../../../../../../src/core/domains/ingest/pipeline/infra/worker-transport.js";

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

/**
 * ProcessWorkerRuntime in-process unit tests.
 *
 * createWorkerRuntime() returns ProcessWorkerRuntime when isMainThread===true
 * (the main vitest process). We drive its IPC handlers by emitting "message"
 * events on `process` directly — no fork needed, so v8 coverage instruments
 * the actual class methods.
 */
describe("ProcessWorkerRuntime (in-process unit tests)", () => {
  afterEach(() => {
    // No persistent listeners added — clean-up is a no-op.
  });

  it("init() resolves when the {__init} IPC message arrives", async () => {
    const rt = createWorkerRuntime<{ base: number }, unknown>();
    const initPromise = rt.init();

    // Simulate the init message arriving via IPC
    process.emit("message", { [INIT_KEY]: { base: 42 } }, null);

    const payload = await initPromise;
    expect(payload).toEqual({ base: 42 });
  });

  it("onRequest() delivers non-init non-shutdown messages to the handler", async () => {
    const rt = createWorkerRuntime<unknown, { value: number }>();

    // init() must be called first to register the IPC listener, even if we don't await it
    // (we're driving the test manually so we skip awaiting)
    void rt.init();
    // Consume the init message so init() doesn't block
    process.emit("message", { [INIT_KEY]: {} }, null);

    const received: unknown[] = [];
    rt.onRequest((req) => received.push(req));

    // A regular request message should be forwarded
    process.emit("message", { value: 7 }, null);
    // Init envelope should be filtered out
    process.emit("message", { [INIT_KEY]: { base: 1 } }, null);
    // Shutdown envelope should be filtered out
    process.emit("message", SHUTDOWN_MESSAGE, null);

    expect(received).toEqual([{ value: 7 }]);
  });

  it("respond() calls process.send with the response", () => {
    const rt = createWorkerRuntime<unknown, unknown>();
    const spy = vi.spyOn(process, "send").mockImplementation(() => true);

    rt.respond({ result: "ok" });

    expect(spy).toHaveBeenCalledWith({ result: "ok" });
    spy.mockRestore();
  });

  it("onShutdown() fires the callback when the shutdown message arrives", async () => {
    const rt = createWorkerRuntime<unknown, unknown>();

    const shutdownFired = new Promise<void>((resolve) => {
      rt.onShutdown(() => {
        resolve();
      });
    });

    process.emit("message", SHUTDOWN_MESSAGE, null);

    await expect(shutdownFired).resolves.toBeUndefined();
  });

  it("onShutdown() does NOT fire for unrelated messages", () => {
    const rt = createWorkerRuntime<unknown, unknown>();
    const cb = vi.fn();
    rt.onShutdown(cb);

    process.emit("message", { type: "other" }, null);
    process.emit("message", { value: 1 }, null);

    expect(cb).not.toHaveBeenCalled();
  });
});
