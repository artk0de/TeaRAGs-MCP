/**
 * Chunker worker entry — shutdown ownership (bd tea-rags-mcp-m9g7k).
 *
 * Invariant: the entry's shutdown handler may terminate the PROCESS only when
 * it owns the process. Under a thread transport (`isMainThread === false`) the
 * process is the HOST, and `process.exit(0)` from a worker thread would kill it.
 * The runtime is faked so the handler registered by the entry can be driven
 * directly under either threading mode.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  isMainThread: true,
  shutdownHandler: null as (() => void) | null,
}));

vi.mock("node:worker_threads", () => ({
  get isMainThread() {
    return state.isMainThread;
  },
  parentPort: null,
  workerData: undefined,
}));

vi.mock("../../../../../../../src/core/domains/ingest/pipeline/infra/worker-runtime.js", () => ({
  createWorkerRuntime: () => ({
    // Never resolves: the engine build is irrelevant to shutdown ownership.
    init: async () => new Promise(() => undefined),
    onRequest: () => undefined,
    respond: () => undefined,
    onShutdown: (cb: () => void) => {
      state.shutdownHandler = cb;
    },
  }),
}));

async function loadEntryShutdownHandler(isMainThread: boolean): Promise<() => void> {
  state.isMainThread = isMainThread;
  state.shutdownHandler = null;
  vi.resetModules();
  await import("../../../../../../../src/core/domains/ingest/pipeline/chunker/infra/worker.js");
  if (!state.shutdownHandler) throw new Error("worker entry registered no shutdown handler");
  return state.shutdownHandler;
}

describe("chunker worker entry shutdown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not exit the host process when running as a worker thread", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const handler = await loadEntryShutdownHandler(false);

    handler();

    expect(exit).not.toHaveBeenCalled();
  });

  it("exits its own process cleanly when running as a forked child", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const handler = await loadEntryShutdownHandler(true);

    handler();

    expect(exit).toHaveBeenCalledWith(0);
  });
});
