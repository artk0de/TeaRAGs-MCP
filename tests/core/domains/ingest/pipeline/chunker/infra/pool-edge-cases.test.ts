/**
 * Edge-case tests for ChunkerPool — worker error handler, shutdown with queued requests,
 * and shutdown timeout fallback.
 *
 * Uses mocked child_process.fork to simulate error events and delayed exits
 * without requiring a compiled build. After the ThreadTransport → ProcessTransport
 * flip, the mock target is child_process.fork (not node:worker_threads.Worker).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChunkerPool as ChunkerPoolType } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/infra/pool.js";
import type { WorkerResponse } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/infra/worker-protocol.js";
import type { ChunkerConfig } from "../../../../../../../src/core/types.js";

// --- Shared mock state (hoisted so vi.mock can reference it) ---

type MessageHandler = (msg: WorkerResponse) => void;
type ErrorHandler = (err: Error) => void;
type ExitHandler = (code: number | null, signal: NodeJS.Signals | null) => void;

interface MockChildInstance {
  messageHandlers: MessageHandler[];
  errorHandlers: ErrorHandler[];
  exitHandlers: ExitHandler[];
  onceExitHandlers: ExitHandler[];
  sendCalls: unknown[];
  killed: boolean;
  unrefCalled: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

const state = vi.hoisted(() => ({
  children: [] as MockChildInstance[],
}));

// --- Mock child_process ---

vi.mock("node:child_process", () => {
  const mockFork = (_path: string, _args: string[], _opts?: unknown) => {
    const instance: MockChildInstance = {
      messageHandlers: [],
      errorHandlers: [],
      exitHandlers: [],
      onceExitHandlers: [],
      sendCalls: [],
      killed: false,
      unrefCalled: false,
      exitCode: null,
      signalCode: null,
    };
    state.children.push(instance);

    return {
      get exitCode() {
        return instance.exitCode;
      },
      get signalCode() {
        return instance.signalCode;
      },
      send(msg: unknown) {
        instance.sendCalls.push(msg);
        return true;
      },
      on(event: string, handler: MessageHandler | ErrorHandler | ExitHandler) {
        if (event === "message") instance.messageHandlers.push(handler as MessageHandler);
        if (event === "error") instance.errorHandlers.push(handler as ErrorHandler);
        if (event === "exit") instance.exitHandlers.push(handler as ExitHandler);
      },
      once(event: string, handler: ExitHandler) {
        if (event === "exit") instance.onceExitHandlers.push(handler);
      },
      unref() {
        instance.unrefCalled = true;
      },
      kill(signal?: string) {
        instance.killed = true;
        instance.signalCode = (signal ?? "SIGTERM") as NodeJS.Signals;
        // Simulate synchronous exit for SIGKILL in terminate()
        const code = null;
        const sig = instance.signalCode;
        const once = [...instance.onceExitHandlers];
        instance.onceExitHandlers = [];
        const exitHs = [...instance.exitHandlers];
        for (const h of once) h(code, sig);
        for (const h of exitHs) h(code, sig);
      },
    };
  };

  return { fork: mockFork };
});

// --- Helpers ---

function getChild(index: number): MockChildInstance {
  return state.children[index];
}

function emitMessage(childIndex: number, msg: WorkerResponse): void {
  const c = getChild(childIndex);
  // The INIT send is index 0; real message handlers skip __init messages.
  // We emit directly on messageHandlers (post-init ones registered by WorkerDispatchPool).
  for (const h of [...c.messageHandlers]) h(msg);
}

function emitError(childIndex: number, err: Error): void {
  const c = getChild(childIndex);
  for (const h of [...c.errorHandlers]) h(err);
}

function emitExit(childIndex: number, code: number | null = 0): void {
  const c = getChild(childIndex);
  c.exitCode = code;
  for (const h of [...c.exitHandlers]) h(code, null);
  const once = [...c.onceExitHandlers];
  c.onceExitHandlers = [];
  for (const h of once) h(code, null);
}

function resetState(): void {
  state.children = [];
}

// --- Tests ---

const CHUNKER_CONFIG: ChunkerConfig = {
  chunkSize: 500,
  chunkOverlap: 50,
  maxChunkSize: 1000,
};

describe("ChunkerPool (edge cases with mocked workers)", () => {
  let ChunkerPool: typeof ChunkerPoolType;

  beforeEach(async () => {
    resetState();
    // Dynamic import so vi.mock is applied first
    ({ ChunkerPool } = await import("../../../../../../../src/core/domains/ingest/pipeline/chunker/infra/pool.js"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("worker error handler (lines 86-92)", () => {
    it("should reject pending promise when worker emits 'error'", async () => {
      const pool = new ChunkerPool(1, CHUNKER_CONFIG);

      // Submit a file — this sets up a pending request on the worker
      const promise = pool.processFile("test.ts", "const x = 1;", "typescript");

      // The child should have been created and init message sent
      expect(state.children).toHaveLength(1);

      // Simulate the worker emitting an error
      const workerError = new Error("Worker crashed unexpectedly");
      emitError(0, workerError);

      // The promise should reject with the worker error
      await expect(promise).rejects.toThrow("Worker crashed unexpectedly");
    });

    it("should not throw when worker emits 'error' with no pending request", () => {
      new ChunkerPool(1, CHUNKER_CONFIG);

      // Emit error without any pending request — should not throw
      expect(() => {
        emitError(0, new Error("Spurious error"));
      }).not.toThrow();
    });
  });

  describe("shutdown with queued requests (line 141)", () => {
    it("should reject queued requests during shutdown", async () => {
      const pool = new ChunkerPool(1, CHUNKER_CONFIG);

      // Submit first file — takes the only worker
      const _promise1 = pool.processFile("a.ts", "const a = 1;", "typescript");

      // Submit second file — goes to queue since worker is busy
      const promise2 = pool.processFile("b.ts", "const b = 2;", "typescript");

      // Submit third file — also queued
      const promise3 = pool.processFile("c.ts", "const c = 3;", "typescript");

      // Shutdown — should reject queued requests
      const shutdownPromise = pool.shutdown();

      // Queued requests (promise2, promise3) should be rejected
      await expect(promise2).rejects.toThrow("ChunkerPool shutting down");
      await expect(promise3).rejects.toThrow("ChunkerPool shutting down");

      // Simulate exit for the active worker so shutdown completes
      emitExit(0, 0);
      await shutdownPromise;

      // promise1 was pending on the worker — it won't resolve since worker exited
      // but it shouldn't hang the test either (worker exit resolves shutdown)
    });
  });

  describe("shutdown timeout fallback (lines 152-153)", () => {
    it("should terminate worker via timeout when it does not exit gracefully", async () => {
      vi.useFakeTimers();

      const pool = new ChunkerPool(1, CHUNKER_CONFIG);

      const shutdownPromise = pool.shutdown();

      // Verify shutdown message was sent (init message is sendCalls[0], shutdown is sendCalls[1])
      const child = getChild(0);
      expect(child.sendCalls).toContainEqual({ type: "shutdown" });
      expect(child.unrefCalled).toBe(true);

      // Do NOT emit 'exit' — simulate a worker that hangs
      // Advance past the 2000ms timeout
      await vi.advanceTimersByTimeAsync(2100);

      // The kill(SIGKILL) fallback should have been called
      expect(child.killed).toBe(true);

      await shutdownPromise;

      vi.useRealTimers();
    });

    it("should clear timeout when worker exits before timeout", async () => {
      vi.useFakeTimers();

      const pool = new ChunkerPool(1, CHUNKER_CONFIG);

      const shutdownPromise = pool.shutdown();

      // Worker exits promptly
      emitExit(0, 0);
      await shutdownPromise;

      // Worker should NOT have been killed (graceful exit)
      const child = getChild(0);
      expect(child.killed).toBe(false);

      vi.useRealTimers();
    });
  });

  describe("processFile after shutdown", () => {
    it("should throw when processFile is called after shutdown", async () => {
      const pool = new ChunkerPool(1, CHUNKER_CONFIG);

      // Shutdown (emit exit so it completes)
      const shutdownPromise = pool.shutdown();
      emitExit(0, 0);
      await shutdownPromise;

      await expect(pool.processFile("test.ts", "code", "typescript")).rejects.toThrow("ChunkerPool not started");
    });
  });

  describe("worker message handler", () => {
    it("should resolve with chunks on successful worker response", async () => {
      const pool = new ChunkerPool(1, CHUNKER_CONFIG);

      const promise = pool.processFile("test.ts", "const x = 1;", "typescript");

      // Simulate successful worker response
      emitMessage(0, {
        filePath: "test.ts",
        chunks: [{ content: "const x = 1;", startLine: 1, endLine: 1, metadata: {} as never }],
      });

      const result = await promise;
      expect(result.filePath).toBe("test.ts");
      expect(result.chunks).toHaveLength(1);

      // Clean up
      const shutdownPromise = pool.shutdown();
      emitExit(0, 0);
      await shutdownPromise;
    });

    it("should reject with error message on worker error response", async () => {
      const pool = new ChunkerPool(1, CHUNKER_CONFIG);

      const promise = pool.processFile("test.ts", "const x = 1;", "typescript");

      // Simulate error response from worker
      emitMessage(0, {
        filePath: "test.ts",
        chunks: [],
        error: "Parse failed: unexpected token",
      });

      await expect(promise).rejects.toThrow("Worker error: Parse failed: unexpected token");

      const shutdownPromise = pool.shutdown();
      emitExit(0, 0);
      await shutdownPromise;
    });

    it("should process queued items after worker completes", async () => {
      const pool = new ChunkerPool(1, CHUNKER_CONFIG);

      // Submit two files — second goes to queue
      const promise1 = pool.processFile("a.ts", "const a = 1;", "typescript");
      const promise2 = pool.processFile("b.ts", "const b = 2;", "typescript");

      // Complete first request — should trigger queue processing
      emitMessage(0, { filePath: "a.ts", chunks: [] });
      const result1 = await promise1;
      expect(result1.filePath).toBe("a.ts");

      // Complete second request
      emitMessage(0, { filePath: "b.ts", chunks: [] });
      const result2 = await promise2;
      expect(result2.filePath).toBe("b.ts");

      const shutdownPromise = pool.shutdown();
      emitExit(0, 0);
      await shutdownPromise;
    });
  });
});
