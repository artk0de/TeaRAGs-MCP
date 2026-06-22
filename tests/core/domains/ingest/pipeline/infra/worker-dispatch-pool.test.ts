import { describe, expect, it } from "vitest";

import { WorkerDispatchPool } from "../../../../../../src/core/domains/ingest/pipeline/infra/worker-dispatch-pool.js";
/**
 * Custom WorkerTransport that supports HANG (never replies) semantics needed by
 * the affinity-steal and queue-drain tests. FakeWorkerTransport always fires
 * queueMicrotask — we need a transport that can suppress the reply for HANG.
 */
import type {
  WorkerHandle,
  WorkerTransport,
} from "../../../../../../src/core/domains/ingest/pipeline/infra/worker-transport.js";
import { FakeWorkerTransport } from "./__helpers__/fake-worker-transport.js";

/**
 * Echo request/response types — mirrors the thread-pool.test.ts contract but
 * swaps `threadId` (a real worker_threads property) for `index` (the
 * FakeHandle's spawn-order index). All assertions on "which worker handled
 * this" compare `index`; all value/error/ordering assertions are preserved
 * verbatim from the original ThreadPool test suite.
 */
interface EchoReq {
  value: string;
}
interface EchoRes {
  index: number;
  value: string;
}

class HangAwareTransport implements WorkerTransport<EchoReq, EchoRes> {
  readonly handles: HangAwareHandle[] = [];

  spawn(init: unknown): WorkerHandle<EchoReq, EchoRes> {
    const handle = new HangAwareHandle(this.handles.length, init);
    this.handles.push(handle);
    return handle;
  }
}

class HangAwareHandle implements WorkerHandle<EchoReq, EchoRes> {
  private msgCb?: (m: EchoRes | { error: string }) => void;
  private exitCb?: () => void;

  constructor(
    readonly index: number,
    readonly init: unknown,
  ) {}

  post(request: EchoReq): void {
    if (request.value === "HANG") {
      // Never reply — keeps the worker "busy" forever (until shutdown).
      return;
    }
    if (request.value === "BOOM") {
      queueMicrotask(() => this.msgCb?.({ error: "boom" }));
      return;
    }
    queueMicrotask(() => this.msgCb?.({ index: this.index, value: request.value }));
  }

  onMessage(cb: (m: EchoRes | { error: string }) => void): void {
    this.msgCb = cb;
  }
  onError(_cb: (e: Error) => void): void {
    /* fakes never raise transport errors */
  }
  onExit(cb: () => void): void {
    this.exitCb = cb;
  }
  shutdown(): void {
    queueMicrotask(() => this.exitCb?.());
  }
  async terminate(): Promise<void> {
    this.exitCb?.();
  }
}

function makeTransport(): HangAwareTransport {
  return new HangAwareTransport();
}

describe("WorkerDispatchPool", () => {
  it("round-robins stateless requests across workers and returns results", async () => {
    const transport = makeTransport();
    const pool = new WorkerDispatchPool<EchoReq, EchoRes>(3, transport, {});
    const results = await Promise.all(["a", "b", "c", "d", "e", "f"].map(async (v) => pool.dispatch({ value: v })));
    expect(results.map((r) => r.value).sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    // 3 workers were used for 6 concurrent requests (proves fan-out)
    expect(new Set(results.map((r) => r.index)).size).toBeGreaterThan(1);
    await pool.shutdown();
  });

  it("pins a routingKey to ONE worker (affinity)", async () => {
    const transport = makeTransport();
    const pool = new WorkerDispatchPool<EchoReq, EchoRes>(3, transport, {});
    // Same key dispatched many times — all must land on the same index.
    const sameKey = await Promise.all(
      Array.from({ length: 6 }, async (_, i) => pool.dispatch({ value: `k${i}` }, "collectionA")),
    );
    const indices = new Set(sameKey.map((r) => r.index));
    expect(indices.size).toBe(1);
    await pool.shutdown();
  });

  // wy5i — processQueue drains ALL currently-runnable queued items per call
  // (loop), not one-then-return. Regression guard: a burst of queued stateless
  // work behind a permanently-busy (HANG) worker must fully drain across every
  // remaining free worker with no starvation, and all items must resolve. The
  // drain-all loop is what lets a queued git-chunk burst use every idle worker
  // instead of trickling one item per completion event.
  it("fully drains a queued stateless burst across all free workers (no trickle, no starvation)", async () => {
    const transport = makeTransport();
    const pool = new WorkerDispatchPool<EchoReq, EchoRes>(3, transport, {});
    const hung = pool.dispatch({ value: "HANG" }, "stuck"); // pins one worker forever
    void hung.catch(() => undefined);

    // Burst of 8 stateless items: 2 free workers, drain-all queue → all resolve,
    // fanning across exactly the 2 non-hung workers.
    const burst = Array.from({ length: 8 }, (_, i) => ({ value: `s${i}` }));
    const results = await Promise.all(burst.map(async (r) => pool.dispatch(r)));
    expect(results.map((r) => r.value).sort()).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
    expect(new Set(results.map((r) => r.index)).size).toBe(2);
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
    const transport = makeTransport();
    const pool = new WorkerDispatchPool<EchoReq, EchoRes>(2, transport, {});

    // Pin "X" to a worker and let it complete so affinity is established and the
    // pinned worker returns idle. resolveAffinity prefers an unpinned worker.
    const warm = await pool.dispatch({ value: "warm" }, "X");
    const pinnedIndex = warm.index;

    // Dispatch long-lived stateless work. Pre-fix, find(!busy) picks the first
    // idle worker — which is the pinned one — STEALING it. Post-fix, stateless
    // work avoids the pinned worker and lands on the unpinned one.
    const hog = pool.dispatch({ value: "HANG" });
    void hog.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20)); // let the steal/placement settle

    // Now an affinity-"X" item. Pre-fix the pinned worker is busy with the HANG
    // steal, so this queues with affinityIndex = pinned and never runs (HANG
    // never frees the worker) → 4s timeout. Post-fix the pinned worker is free,
    // so it dispatches immediately and resolves on the same worker.
    const affinity = pool.dispatch({ value: "q-affinity" }, "X");
    await expect(affinity).resolves.toMatchObject({ value: "q-affinity" });
    expect((await affinity).index).toBe(pinnedIndex);

    await pool.shutdown();
  }, 4000);

  // icfj — corollary: when EVERY worker is pinned (more collections than
  // workers), stateless work has no unpinned worker to prefer, so it falls back
  // to any free worker without deadlocking. Guards that findFreeStatelessThread's
  // fallback preserves throughput rather than refusing to place stateless work.
  it("falls back to a pinned-but-free thread for stateless work when no unpinned thread exists", async () => {
    const transport = makeTransport();
    const pool = new WorkerDispatchPool<EchoReq, EchoRes>(2, transport, {});
    // Pin both workers to distinct collections.
    await Promise.all([pool.dispatch({ value: "a" }, "collA"), pool.dispatch({ value: "b" }, "collB")]);
    // Now both workers are pinned. A stateless burst must still run (fallback to
    // any free worker), not hang for lack of an unpinned worker.
    const results = await Promise.all(["s0", "s1", "s2", "s3"].map(async (v) => pool.dispatch({ value: v })));
    expect(results.map((r) => r.value).sort()).toEqual(["s0", "s1", "s2", "s3"]);
    await pool.shutdown();
  }, 4000);

  it("rejects when the worker reports an error", async () => {
    const transport = makeTransport();
    const pool = new WorkerDispatchPool<EchoReq, EchoRes>(1, transport, {});
    await expect(pool.dispatch({ value: "BOOM" })).rejects.toThrow(/boom/);
    await pool.shutdown();
  });

  it("rejects queued work on shutdown", async () => {
    const transport = makeTransport();
    const pool = new WorkerDispatchPool<EchoReq, EchoRes>(1, transport, {});
    // Inflight is intentionally fire-and-forget by WorkerDispatchPool's shutdown
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

  it("exposes init payload on each spawned handle (FakeWorkerTransport)", async () => {
    const transport = new FakeWorkerTransport<{ n: number }, { r: number }>((req) => ({ r: req.n + 1 }));
    const pool = new WorkerDispatchPool<{ n: number }, { r: number }>(2, transport, { base: 1 });
    const results = await Promise.all([pool.dispatch({ n: 1 }), pool.dispatch({ n: 2 })]);
    expect(results.map((x) => x.r)).toEqual([2, 3]);
    expect(transport.handles).toHaveLength(2);
    expect(transport.handles[0].init).toEqual({ base: 1 });
    await pool.shutdown();
  });
});
