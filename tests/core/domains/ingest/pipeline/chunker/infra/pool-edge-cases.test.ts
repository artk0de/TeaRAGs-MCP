/**
 * Edge-case tests for ChunkerPool — worker error handler, shutdown with queued requests,
 * and shutdown timeout fallback.
 *
 * Uses mocked worker_threads to simulate error events and delayed exits
 * without requiring a compiled build.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChunkerPool as ChunkerPoolType } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/infra/pool.js";
import type { WorkerResponse } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/infra/worker.js";
import type { ChunkerConfig } from "../../../../../../../src/core/types.js";

// --- Shared mock state (hoisted so vi.mock can reference it) ---

type MessageHandler = (msg: WorkerResponse) => void;
type ErrorHandler = (err: Error) => void;
type ExitHandler = (code: number) => void;

interface MockWorkerInstance {
  messageHandlers: MessageHandler[];
  errorHandlers: ErrorHandler[];
  exitHandlers: ExitHandler[];
  onceExitHandlers: ExitHandler[];
  postMessageCalls: unknown[];
  terminated: boolean;
  unrefCalled: boolean;
}

const state = vi.hoisted(() => ({
  workers: [] as MockWorkerInstance[],
}));

// --- Mock worker_threads ---

vi.mock("node:worker_threads", () => {
  class MockWorker {
    private instance: MockWorkerInstance;

    constructor(_path: string, _opts?: unknown) {
      this.instance = {
        messageHandlers: [],
        errorHandlers: [],
        exitHandlers: [],
        onceExitHandlers: [],
        postMessageCalls: [],
        terminated: false,
        unrefCalled: false,
      };
      state.workers.push(this.instance);
    }

    on(event: string, handler: MessageHandler | ErrorHandler | ExitHandler): void {
      if (event === "message") this.instance.messageHandlers.push(handler as MessageHandler);
      if (event === "error") this.instance.errorHandlers.push(handler as ErrorHandler);
      if (event === "exit") this.instance.exitHandlers.push(handler as ExitHandler);
    }

    once(event: string, handler: ExitHandler): void {
      if (event === "exit") this.instance.onceExitHandlers.push(handler);
    }

    postMessage(msg: unknown): void {
      this.instance.postMessageCalls.push(msg);
    }

    async terminate(): Promise<number> {
      this.instance.terminated = true;
      return 0;
    }

    unref(): void {
      this.instance.unrefCalled = true;
    }
  }

  return { Worker: MockWorker };
});

// --- Helpers ---

function getWorker(index: number): MockWorkerInstance {
  return state.workers[index];
}

function emitMessage(workerIndex: number, msg: WorkerResponse): void {
  const w = getWorker(workerIndex);
  for (const h of [...w.messageHandlers]) h(msg);
}

function emitError(workerIndex: number, err: Error): void {
  const w = getWorker(workerIndex);
  for (const h of [...w.errorHandlers]) h(err);
}

function emitExit(workerIndex: number, code: number): void {
  const w = getWorker(workerIndex);
  for (const h of [...w.exitHandlers]) h(code);
  const once = [...w.onceExitHandlers];
  w.onceExitHandlers = [];
  for (const h of once) h(code);
}

function resetState(): void {
  state.workers = [];
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

      // The worker should have been created and message sent
      expect(state.workers).toHaveLength(1);

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

      // Verify shutdown message was posted
      const worker = getWorker(0);
      expect(worker.postMessageCalls).toContainEqual({ type: "shutdown" });
      expect(worker.unrefCalled).toBe(true);

      // Do NOT emit 'exit' — simulate a worker that hangs
      // Advance past the 2000ms timeout
      await vi.advanceTimersByTimeAsync(2100);

      // The terminate() fallback should have been called
      expect(worker.terminated).toBe(true);

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

      // Worker should NOT have been terminated (graceful exit)
      const worker = getWorker(0);
      expect(worker.terminated).toBe(false);

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

      await expect(pool.processFile("test.ts", "code", "typescript")).rejects.toThrow("ChunkerPool is shut down");
    });
  });

  describe("worker message handler", () => {
    it("should resolve with chunks on successful worker response", async () => {
      const pool = new ChunkerPool(1, CHUNKER_CONFIG);

      const promise = pool.processFile("test.ts", "const x = 1;", "typescript");

      // Simulate successful worker response
      emitMessage(0, {
        filePath: "test.ts",
        chunks: [{ content: "const x = 1;", startLine: 1, endLine: 1, metadata: {} as any }],
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
