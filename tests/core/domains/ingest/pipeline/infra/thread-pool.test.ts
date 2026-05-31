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
  // "SLOW:<ms>:<tag>" — reply after the given delay, echoing the tag. Lets the
  // test stagger completion timing so concurrent dispatches overlap and the
  // pinned-thread steal/strand interleaving is exercised deterministically.
  if (typeof msg.value === "string" && msg.value.startsWith("SLOW:")) {
    const parts = msg.value.split(":");
    const ms = Number(parts[1]);
    setTimeout(() => parentPort.postMessage({ threadId, value: msg.value }), ms);
    return;
  }
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

  // icfj — HARD DEADLOCK regression guard. An affinity-pinned item must never be
  // stranded in the queue once its pinned thread is idle with no pending
  // completion event. Repro of the root race (suspect 3): the affinity item is
  // enqueued (its pinned thread was busy at dispatch time), but the completion
  // that frees the pinned thread runs processQueue BEFORE the item lands in the
  // queue. Since the only thing that re-runs processQueue is a worker completion
  // EVENT, and every worker is now idle with nothing in flight, the queued
  // affinity item is never reconsidered: all threads idle, queue non-empty, 0%
  // CPU forever (matches the live sample: main + all workers in kevent).
  //
  // The dispatch path that enqueues never nudges processQueue, so a runnable
  // item that arrives "between" completion events is stranded.
  //
  // Deterministic construction: we drive the affinity dispatch from INSIDE the
  // resolution of the pinned thread's own completion — i.e. exactly the moment
  // after pt.busy=false and after that handler's processQueue() already ran on a
  // queue that did NOT yet contain the affinity item. The pinned thread is now
  // idle, no other work is in flight, and the affinity item is enqueued with no
  // event left to fire. Before the fix this HANGS (4s timeout); after it (the
  // enqueue path nudges processQueue) it resolves immediately.
  // icfj — HARD DEADLOCK regression guard (suspect 1: stateless steals an
  // affinity-pinned thread). Stateless selection used `find(w => !w.busy)`,
  // which never excluded affinity-pinned threads. A stateless item could occupy
  // the very thread a collection is pinned to; an affinity item for that
  // collection then queues behind it and can ONLY run on that one thread. If the
  // stolen stateless work is long-lived (a cold codegraph build pins its thread
  // for minutes — modelled here by HANG), the affinity item is stranded: queue
  // non-empty, the pinned thread busy with foreign work, no progress — exactly
  // the live force_reindex hang on commons-lang (all workers idle/blocked,
  // 0% CPU). The fix: stateless work prefers an UNPINNED free thread, so it can
  // never steal the thread an affinity item depends on while another thread is
  // free.
  it("never lets stateless work steal an affinity-pinned thread (affinity item must dispatch)", async () => {
    const pool = new ThreadPool<EchoReq, EchoRes>(2, workerPath, {});

    // Pin "X" to a thread and let it complete so affinity is established and the
    // pinned thread returns idle. resolveAffinity prefers an unpinned thread.
    const warm = await pool.dispatch({ value: "warm" }, "X");
    const pinnedThreadId = warm.threadId;

    // Dispatch long-lived stateless work. Pre-fix, find(!busy) picks the first
    // idle thread — which is the pinned one — STEALING it. Post-fix, stateless
    // work avoids the pinned thread and lands on the unpinned one.
    const hog = pool.dispatch({ value: "HANG" });
    void hog.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20)); // let the steal/placement settle

    // Now an affinity-"X" item. Pre-fix the pinned thread is busy with the HANG
    // steal, so this queues with affinityIndex = pinned and never runs (HANG
    // never frees the thread) → 4s timeout. Post-fix the pinned thread is free,
    // so it dispatches immediately and resolves on the same thread.
    const affinity = pool.dispatch({ value: "q-affinity" }, "X");
    await expect(affinity).resolves.toMatchObject({ value: "q-affinity" });
    expect((await affinity).threadId).toBe(pinnedThreadId);

    await pool.shutdown();
  }, 4000);

  // icfj — corollary: when EVERY thread is pinned (more collections than
  // threads), stateless work has no unpinned thread to prefer, so it falls back
  // to any free thread without deadlocking. Guards that findFreeStatelessThread's
  // fallback preserves throughput rather than refusing to place stateless work.
  it("falls back to a pinned-but-free thread for stateless work when no unpinned thread exists", async () => {
    const pool = new ThreadPool<EchoReq, EchoRes>(2, workerPath, {});
    // Pin both threads to distinct collections.
    await Promise.all([pool.dispatch({ value: "a" }, "collA"), pool.dispatch({ value: "b" }, "collB")]);
    // Now both threads are pinned. A stateless burst must still run (fallback to
    // any free thread), not hang for lack of an unpinned thread.
    const results = await Promise.all(["s0", "s1", "s2", "s3"].map(async (v) => pool.dispatch({ value: v })));
    expect(results.map((r) => r.value).sort()).toEqual(["s0", "s1", "s2", "s3"]);
    await pool.shutdown();
  }, 4000);

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
