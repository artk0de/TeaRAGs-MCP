/**
 * WorkerDispatchPool<Req, Res> — generic worker pool with pluggable transport.
 *
 * Owns the MECHANICS of distribution only (free-worker selection, round-robin,
 * routingKey affinity, busy-tracking, overflow queue, graceful shutdown) and
 * stays transport-agnostic: consumers inject a `WorkerTransport` (thread or
 * process) and the pool never touches Worker/ChildProcess directly.
 *
 * Worker DI rule (.claude/rules/domains-language.md): a class instance cannot
 * cross the postMessage structured-clone boundary, so `init` carries only
 * serializable data (including module-path strings the worker dynamic-imports).
 *
 * Note: this class lives next to the legacy `WorkerPool` (in-process retry/
 * backoff batch executor for the embedding pipeline) under a deliberately
 * distinct name. "WorkerDispatch" denotes the generic transport-backed pool;
 * "worker" remains the in-process executor's vocabulary.
 */
import { PipelineNotStartedError, WorkerTimeoutError } from "../../errors.js";
import { defaultWorkerDispatchTimeoutMs } from "./pool-defaults.js";
import { isDebug } from "./runtime.js";
import type { WorkerHandle, WorkerTransport } from "./worker-transport.js";

interface Pending<Res> {
  resolve: (result: Res) => void;
  reject: (error: Error) => void;
}

interface PoolThread<Req, Res> {
  handle: WorkerHandle<Req, Res>;
  busy: boolean;
  pending: Pending<Res> | null;
  index: number;
  /**
   * Active per-dispatch liveness timer (or null when idle / after it fires or is
   * cleared). At most one in-flight dispatch per thread, so one timer slot here
   * suffices. Armed in `dispatchTo` (when work actually goes to the worker),
   * cleared on every completion and on recycle.
   */
  timer: ReturnType<typeof setTimeout> | null;
}

interface QueueItem<Req, Res> {
  request: Req;
  pending: Pending<Res>;
  /** Pinned thread index when the request carried a routingKey, else null. */
  affinityIndex: number | null;
}

export class WorkerDispatchPool<Req, Res> {
  private readonly threads: PoolThread<Req, Res>[] = [];
  private queue: QueueItem<Req, Res>[] = [];
  /** routingKey → pinned thread index (affinity). */
  private readonly affinity = new Map<string, number>();
  private isShutdown = false;

  /**
   * @param poolSize   Number of workers to spawn.
   * @param transport  Factory for worker handles (ThreadTransport or ProcessTransport).
   * @param init       Serializable init payload forwarded to each spawned worker.
   * @param name       Public label embedded in error messages (`<name> shutting down`,
   *                   `PipelineNotStartedError(<name>)`). Lets the public facade
   *                   (e.g. `ChunkerPool`) preserve its identity in user-facing
   *                   errors without leaking the internal pool term.
   * @param dispatchTimeoutMs Per-dispatch liveness timeout (ms). The clock starts
   *                   when a request is actually dispatched TO A WORKER
   *                   (`dispatchTo`), NOT while it waits in the overflow queue — a
   *                   long queue wait is back-pressure, not a worker hang. On
   *                   expiry the dispatch promise rejects with `WorkerTimeoutError`
   *                   and the silent/hung worker is recycled (terminated +
   *                   replaced) so the slot recovers capacity. A value `<= 0`
   *                   disables the bound (legacy unbounded behavior) — used by the
   *                   enrichment pool, whose collection-affinity finalize
   *                   (codegraph streaming SCC + PageRank) can legitimately run for
   *                   minutes. Defaults to the generous finite bound in
   *                   `defaultWorkerDispatchTimeoutMs` (env `CHUNKER_WORKER_TIMEOUT_MS`).
   */
  constructor(
    private readonly poolSize: number,
    private readonly transport: WorkerTransport<Req, Res>,
    private readonly init: unknown,
    private readonly name = "WorkerDispatchPool",
    private readonly dispatchTimeoutMs = defaultWorkerDispatchTimeoutMs(),
  ) {
    this.initThreads();
  }

  private initThreads(): void {
    for (let i = 0; i < this.poolSize; i++) {
      const pt: PoolThread<Req, Res> = {
        handle: this.transport.spawn(this.init),
        busy: false,
        pending: null,
        index: i,
        timer: null,
      };
      this.bindHandle(pt);
      this.threads.push(pt);
    }
    if (isDebug()) {
      console.error(`[WorkerDispatchPool:${this.name}] Initialized ${this.poolSize} workers`);
    }
  }

  /**
   * Wire the message/error listeners for a thread's CURRENT handle. Factored out
   * of `initThreads` so `recycleWorker` can re-bind a freshly spawned replacement
   * handle onto the same pool slot after a liveness-timeout kill — keeping the
   * worker lifecycle in ONE place rather than a parallel re-spawn path.
   */
  private bindHandle(pt: PoolThread<Req, Res>): void {
    pt.handle.onMessage((message) => {
      const { pending } = pt;
      pt.busy = false;
      pt.pending = null;
      this.clearTimer(pt); // normal completion — no leaked timer
      if (pending) {
        if (message && typeof message === "object" && "error" in message && (message as { error: string }).error) {
          pending.reject(new Error(`Worker error: ${(message as { error: string }).error}`));
        } else {
          pending.resolve(message as Res);
        }
      }
      this.processQueue();
    });

    pt.handle.onError((error) => {
      const { pending } = pt;
      pt.busy = false;
      pt.pending = null;
      this.clearTimer(pt); // error completion — no leaked timer
      if (pending) pending.reject(error);
      this.processQueue();
    });
  }

  /**
   * Dispatch a request. With routingKey, all same-key requests pin to ONE worker
   * (affinity — required for stateful trajectories like codegraph). Without it,
   * round-robin to any free worker (today's chunker behavior).
   */
  async dispatch(request: Req, routingKey?: string): Promise<Res> {
    if (this.isShutdown) throw new PipelineNotStartedError(this.name);

    return new Promise<Res>((resolve, reject) => {
      // Single-settle guard: the liveness timer and a (late) worker reply can
      // race; whichever fires first wins and the other becomes a no-op. Every
      // settle path — worker reply, transport error, timeout, shutdown — funnels
      // through these wrappers, so a promise can never resolve/reject twice.
      let settled = false;
      const pending: Pending<Res> = {
        resolve: (result) => {
          if (settled) return;
          settled = true;
          resolve(result);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
      };

      if (routingKey !== undefined) {
        const pinned = this.resolveAffinity(routingKey);
        const pt = this.threads[pinned];
        if (!pt.busy) this.dispatchTo(pt, request, pending);
        else this.queue.push({ request, pending, affinityIndex: pinned });
        return;
      }

      // Stateless work prefers an UNPINNED free thread (icfj): stealing an
      // affinity-pinned thread would strand the affinity items that can ONLY run
      // on it — a cold codegraph build holds its pinned thread for minutes, so a
      // stolen pinned thread never frees in time and the queued affinity work
      // hangs (all threads idle/blocked, 0% CPU; the live force_reindex hang).
      const free = this.findFreeStatelessThread();
      if (free) this.dispatchTo(free, request, pending);
      else this.queue.push({ request, pending, affinityIndex: null });
    });
  }

  /**
   * Drop a routingKey's affinity pinning. The next dispatch with this key
   * picks a fresh thread (least-loaded by current pin count). Used by the
   * enrichment executor's releaseCollection path so a finished collection
   * frees its thread for the next workload.
   *
   * Idempotent: dropping an unknown key is a benign no-op.
   */
  releaseAffinity(routingKey: string): void {
    this.affinity.delete(routingKey);
  }

  /** Pin a routingKey to a thread on first sight; reuse thereafter. */
  private resolveAffinity(routingKey: string): number {
    const existing = this.affinity.get(routingKey);
    if (existing !== undefined) return existing;
    // Prefer a thread that holds no affinity yet, else round-robin by current pin count.
    const pinnedIndices = new Set(this.affinity.values());
    const unpinned = this.threads.find((w) => !pinnedIndices.has(w.index));
    const chosen = unpinned ? unpinned.index : this.threads[this.affinity.size % this.poolSize].index;
    this.affinity.set(routingKey, chosen);
    return chosen;
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
    // Reject only QUEUED work. In-flight work stays fire-and-forget — when the
    // worker finishes its current message it either delivers a late result
    // (resolved by the message handler) or the worker exits and the promise is
    // simply abandoned. The public facade (e.g. `ChunkerPool`) relies on this
    // contract: its callers do NOT await an in-flight `processFile` past
    // shutdown. Rejecting here would surface as unhandled rejections in tests
    // that exercise the abandonment path.
    for (const { pending } of this.queue) {
      pending.reject(new Error(`${this.name} shutting down`));
    }
    this.queue = [];

    await Promise.all(
      this.threads.map(
        async (pt) =>
          new Promise<void>((resolve) => {
            // Cancel any in-flight liveness timer first — otherwise it could fire
            // after shutdown and recycle a worker into an already-torn-down pool.
            this.clearTimer(pt);
            const timer = setTimeout(() => void pt.handle.terminate().then(resolve), 2000);
            pt.handle.onExit(() => {
              clearTimeout(timer);
              resolve();
            });
            pt.handle.shutdown();
          }),
      ),
    );
    this.threads.length = 0;
    if (isDebug()) console.error(`[WorkerDispatchPool:${this.name}] Shut down`);
  }

  /**
   * Pick a free thread for STATELESS work, preferring one that is NOT pinned by
   * any affinity binding. Stealing an affinity-pinned thread for stateless work
   * strands the affinity items queued behind it (they can only run on that one
   * thread), so a stateless item only lands on a pinned thread when every
   * unpinned thread is busy. Falls back to any free thread to preserve
   * throughput when all free threads happen to be pinned.
   */
  private findFreeStatelessThread(): PoolThread<Req, Res> | undefined {
    const pinnedIndices = new Set(this.affinity.values());
    const unpinnedFree = this.threads.find((w) => !w.busy && !pinnedIndices.has(w.index));
    if (unpinnedFree) return unpinnedFree;
    return this.threads.find((w) => !w.busy);
  }

  private dispatchTo(pt: PoolThread<Req, Res>, request: Req, pending: Pending<Res>): void {
    pt.busy = true;
    pt.pending = pending;
    // Arm the liveness clock at the moment work goes TO the worker. Queue wait
    // time is deliberately excluded — `dispatchTo` is the single choke point for
    // both direct dispatch and queue drain, so the bound is always dispatch-to-
    // worker, never enqueue-to-worker (a long queue wait is back-pressure, not a
    // hang).
    this.armTimer(pt, request);
    pt.handle.post(request);
  }

  /**
   * Start the per-dispatch liveness timer for `pt`. On expiry the hung worker is
   * recycled (terminated + replaced) so the pool recovers capacity, and the
   * originating dispatch rejects with an actionable `WorkerTimeoutError`. A
   * non-positive `dispatchTimeoutMs` disables the bound entirely (no timer armed).
   */
  private armTimer(pt: PoolThread<Req, Res>, request: Req): void {
    if (this.dispatchTimeoutMs <= 0) return;
    pt.timer = setTimeout(() => {
      const { pending } = pt;
      pt.timer = null;
      // Recycle BEFORE settling so the slot is healthy again the moment queued
      // work is reconsidered. recycleWorker resets busy/pending and swaps in a
      // fresh handle; the captured `pending` is rejected with the typed timeout.
      this.recycleWorker(pt);
      pending?.reject(new WorkerTimeoutError(this.name, this.describeRequest(request), this.dispatchTimeoutMs));
      this.processQueue();
    }, this.dispatchTimeoutMs);
  }

  /** Cancel `pt`'s liveness timer if one is armed. Idempotent. */
  private clearTimer(pt: PoolThread<Req, Res>): void {
    if (pt.timer !== null) {
      clearTimeout(pt.timer);
      pt.timer = null;
    }
  }

  /**
   * Terminate a hung/poisoned worker and spawn a replacement onto the SAME pool
   * slot, re-binding listeners — so a poisoned worker can't keep failing
   * subsequent tasks and the slot's capacity is restored. Reuses the transport's
   * existing spawn/terminate primitives (no parallel lifecycle). The dead handle
   * is terminated fire-and-forget; its stale listeners are dropped with it.
   */
  private recycleWorker(pt: PoolThread<Req, Res>): void {
    this.clearTimer(pt);
    const dead = pt.handle;
    pt.busy = false;
    pt.pending = null;
    void Promise.resolve(dead.terminate()).catch(() => undefined);
    pt.handle = this.transport.spawn(this.init);
    this.bindHandle(pt);
  }

  /**
   * Best-effort human label for a request in timeout errors. Chunker requests
   * carry a `filePath`, which makes the error actionable; otherwise fall back to
   * a generic token (the pool is generic over `Req` and cannot assume a shape).
   */
  private describeRequest(request: Req): string {
    if (request && typeof request === "object") {
      const { filePath } = request as { filePath?: unknown };
      if (typeof filePath === "string" && filePath.length > 0) return filePath;
    }
    return "request";
  }

  private processQueue(): void {
    if (this.queue.length === 0) return;
    // Drain ALL currently-runnable queued items per call, not one. A single
    // worker-completion event must refill every free worker — dispatching one
    // item then returning made queued work trickle (one item per completion
    // event), serializing throughput that affinity + free workers could absorb
    // immediately (wy5i). Walk the queue, dispatch every item whose target is
    // free, and stop only when no further item can run on a currently-free
    // worker.
    for (let i = 0; i < this.queue.length; ) {
      const item = this.queue[i];
      if (item.affinityIndex !== null) {
        const pt = this.threads[item.affinityIndex];
        if (pt && !pt.busy) {
          this.queue.splice(i, 1);
          this.dispatchTo(pt, item.request, item.pending);
          continue; // do not advance i — splice shifted the next item into place
        }
        i++; // pinned thread still busy — leave queued, try the next item
        continue;
      }
      // Stateless item: any free thread, preferring an unpinned one so it does
      // not steal a thread an affinity item is waiting on.
      const free = this.findFreeStatelessThread();
      if (!free) {
        // No free thread for this stateless item right now. Later items may
        // still be affinity-pinned to a (different) free thread, so keep
        // scanning rather than bailing — preserves the original loop's ability
        // to honor a runnable affinity item sitting behind a blocked stateless
        // one.
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.dispatchTo(free, item.request, item.pending);
      // do not advance i — splice shifted the next item into place
    }
  }
}
