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
  // "HANG" never replies — pins its worker busy forever (test cleans up via shutdown).
  if (msg.value === "HANG") { return; }
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

  // wy5i — processQueue drains ALL currently-runnable queued items per call
  // (loop), not one-then-return. Regression guard: a burst of queued stateless
  // work behind a permanently-busy (HANG) worker must fully drain across every
  // remaining free worker with no starvation, and all items must resolve. The
  // drain-all loop is what lets a queued git-chunk burst use every idle worker
  // instead of trickling one item per completion event.
  it("fully drains a queued stateless burst across all free workers (no trickle, no starvation)", async () => {
    const pool = new ThreadPool<EchoReq, EchoRes>(3, workerPath, {});
    const hung = pool.dispatch({ value: "HANG" }, "stuck"); // pins one thread forever
    void hung.catch(() => undefined);

    // Burst of 8 stateless items: 2 free workers, drain-all queue → all resolve,
    // fanning across exactly the 2 non-hung workers.
    const burst = Array.from({ length: 8 }, (_, i) => ({ value: `s${i}` }));
    const results = await Promise.all(burst.map(async (r) => pool.dispatch(r)));
    expect(results.map((r) => r.value).sort()).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
    expect(new Set(results.map((r) => r.threadId)).size).toBe(2);
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
