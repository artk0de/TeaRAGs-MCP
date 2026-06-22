/**
 * ThreadWorkerRuntime unit tests — mocks node:worker_threads so
 * isMainThread=false triggers ThreadWorkerRuntime inside createWorkerRuntime().
 * Each method is driven via the mocked parentPort.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SHUTDOWN_MESSAGE } from "../../../../../../src/core/domains/ingest/pipeline/infra/worker-transport.js";

// --- Mock node:worker_threads ---
// isMainThread=false → ThreadWorkerRuntime is selected by createWorkerRuntime().

type AnyHandler = (...args: unknown[]) => void;

interface MockPort {
  messageHandlers: AnyHandler[];
  postMessageCalls: unknown[];
  closed: boolean;
  on: (event: string, handler: AnyHandler) => void;
  postMessage: (msg: unknown) => void;
  close: () => void;
}

const state = vi.hoisted(() => ({
  workerData: {} as unknown,
  port: null as MockPort | null,
}));

vi.mock("node:worker_threads", () => {
  const port: MockPort = {
    messageHandlers: [],
    postMessageCalls: [],
    closed: false,
    on(event: string, handler: AnyHandler) {
      if (event === "message") this.messageHandlers.push(handler);
    },
    postMessage(msg: unknown) {
      this.postMessageCalls.push(msg);
    },
    close() {
      this.closed = true;
    },
  };
  state.port = port;

  return {
    isMainThread: false,
    get workerData() {
      return state.workerData;
    },
    parentPort: port,
  };
});

function emitMessage(msg: unknown): void {
  if (!state.port) throw new Error("port not initialised");
  for (const h of [...state.port.messageHandlers]) h(msg);
}

describe("ThreadWorkerRuntime (mocked worker_threads)", () => {
  beforeEach(() => {
    if (state.port) {
      state.port.messageHandlers = [];
      state.port.postMessageCalls = [];
      state.port.closed = false;
    }
    state.workerData = {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("init() returns workerData synchronously", async () => {
    // Must re-import after vi.mock to get the mocked module
    const { createWorkerRuntime } =
      await import("../../../../../../src/core/domains/ingest/pipeline/infra/worker-runtime.js");
    state.workerData = { base: 99 };
    const rt = createWorkerRuntime<{ base: number }, unknown>();
    const result = await rt.init();
    expect(result).toEqual({ base: 99 });
  });

  it("onRequest() delivers non-shutdown messages to the handler", async () => {
    const { createWorkerRuntime } =
      await import("../../../../../../src/core/domains/ingest/pipeline/infra/worker-runtime.js");
    const rt = createWorkerRuntime<unknown, { val: number }>();
    const received: unknown[] = [];
    rt.onRequest((req) => received.push(req));

    emitMessage({ val: 42 });
    emitMessage(SHUTDOWN_MESSAGE); // must be filtered out

    expect(received).toEqual([{ val: 42 }]);
  });

  it("respond() calls parentPort.postMessage", async () => {
    const { createWorkerRuntime } =
      await import("../../../../../../src/core/domains/ingest/pipeline/infra/worker-runtime.js");
    const rt = createWorkerRuntime<unknown, unknown>();
    rt.respond({ answer: 7 });
    expect(state.port!.postMessageCalls).toEqual([{ answer: 7 }]);
  });

  it("onShutdown() closes the port and fires the callback", async () => {
    const { createWorkerRuntime } =
      await import("../../../../../../src/core/domains/ingest/pipeline/infra/worker-runtime.js");
    const rt = createWorkerRuntime<unknown, unknown>();
    const fired = vi.fn();
    rt.onShutdown(fired);

    emitMessage(SHUTDOWN_MESSAGE);

    expect(state.port!.closed).toBe(true);
    expect(fired).toHaveBeenCalledOnce();
  });

  it("onShutdown() does not fire for non-shutdown messages", async () => {
    const { createWorkerRuntime } =
      await import("../../../../../../src/core/domains/ingest/pipeline/infra/worker-runtime.js");
    const rt = createWorkerRuntime<unknown, unknown>();
    const fired = vi.fn();
    rt.onShutdown(fired);

    emitMessage({ type: "other" });
    emitMessage({ val: 1 });

    expect(fired).not.toHaveBeenCalled();
  });
});
