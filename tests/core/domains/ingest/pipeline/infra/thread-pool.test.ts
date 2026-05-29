import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ThreadPool } from "../../../../../../src/core/domains/ingest/pipeline/infra/thread-pool.js";

// A trivial echo worker: returns { threadId, value } so the test can assert
// WHICH worker handled each request (to prove affinity routing).
const WORKER_SRC = `
import { parentPort, threadId } from "node:worker_threads";
parentPort.on("message", (msg) => {
  if (msg && msg.type === "shutdown") { parentPort.close(); return; }
  if (msg.value === "BOOM") { parentPort.postMessage({ error: "boom" }); return; }
  // small delay so concurrent dispatches actually overlap across workers
  setTimeout(() => parentPort.postMessage({ threadId, value: msg.value }), 5);
});
`;

interface EchoReq {
  value: string;
}
interface EchoRes {
  threadId: number;
  value: string;
}

describe("ThreadPool", () => {
  let dir: string;
  let workerPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tp-"));
    workerPath = join(dir, "echo-worker.mjs");
    writeFileSync(workerPath, WORKER_SRC);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-robins stateless requests across workers and returns results", async () => {
    const pool = new ThreadPool<EchoReq, EchoRes>(3, workerPath, {});
    const results = await Promise.all(["a", "b", "c", "d", "e", "f"].map(async (v) => pool.dispatch({ value: v })));
    expect(results.map((r) => r.value).sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    // 3 workers were used for 6 concurrent requests (proves fan-out)
    expect(new Set(results.map((r) => r.threadId)).size).toBeGreaterThan(1);
    await pool.shutdown();
  });

  it("pins a routingKey to ONE worker (affinity)", async () => {
    const pool = new ThreadPool<EchoReq, EchoRes>(3, workerPath, {});
    // Same key dispatched many times — all must land on the same threadId.
    const sameKey = await Promise.all(
      Array.from({ length: 6 }, async (_, i) => pool.dispatch({ value: `k${i}` }, "collectionA")),
    );
    const threadIds = new Set(sameKey.map((r) => r.threadId));
    expect(threadIds.size).toBe(1);
    await pool.shutdown();
  });

  it("rejects when the worker reports an error", async () => {
    const pool = new ThreadPool<EchoReq, EchoRes>(1, workerPath, {});
    await expect(pool.dispatch({ value: "BOOM" })).rejects.toThrow(/boom/);
    await pool.shutdown();
  });

  it("rejects queued work on shutdown", async () => {
    const pool = new ThreadPool<EchoReq, EchoRes>(1, workerPath, {});
    // Inflight is intentionally fire-and-forget by ThreadPool's shutdown
    // contract — preserve the catch handler purely to keep vitest happy if
    // the worker happens to fail late after the port closes.
    const inflight = pool.dispatch({ value: "x" });
    void inflight.catch(() => undefined);
    const queued = pool.dispatch({ value: "y" }); // queues behind the single worker
    // Pre-attach catch so the rejection inside shutdown() does not surface as
    // unhandled in the microtask gap before expect(...).rejects subscribes.
    const queuedSettled = queued.catch((e: Error) => e);
    await pool.shutdown();
    const queuedErr = await queuedSettled;
    expect(queuedErr).toBeInstanceOf(Error);
    expect((queuedErr as Error).message).toMatch(/shutting down/);
  });
});
