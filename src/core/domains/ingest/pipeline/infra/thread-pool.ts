/**
 * ThreadPool<Req, Res> — generic worker_threads pool extracted from ChunkerPool.
 *
 * Owns the MECHANICS of distribution only (free-worker selection, round-robin,
 * routingKey affinity, busy-tracking, overflow queue, graceful shutdown) and
 * stays trajectory-agnostic: it sees (request, routingKey?) and nothing else.
 * Consumers (ChunkerPool, the enrichment executor) supply their own compiled
 * worker entry path + workerData, and — for stateful work — a routingKey.
 *
 * Worker DI rule (.claude/rules/domains-language.md): a class instance cannot
 * cross the postMessage structured-clone boundary, so workerData carries only
 * serializable init (including module-path strings the worker dynamic-imports).
 *
 * Note: this class lives next to the legacy `WorkerPool` (in-process retry/
 * backoff batch executor for the embedding pipeline) under a deliberately
 * distinct name. "Thread" denotes node:worker_threads here; "worker" remains
 * the in-process executor's vocabulary.
 */
import { Worker } from "node:worker_threads";

import { PipelineNotStartedError } from "../../errors.js";
import { isDebug } from "./runtime.js";

interface Pending<Res> {
  resolve: (result: Res) => void;
  reject: (error: Error) => void;
}

interface PoolThread<Res> {
  worker: Worker;
  busy: boolean;
  pending: Pending<Res> | null;
  index: number;
}

interface QueueItem<Req, Res> {
  request: Req;
  pending: Pending<Res>;
  /** Pinned thread index when the request carried a routingKey, else null. */
  affinityIndex: number | null;
}

/** Worker message shape: the result, or an error envelope. */
type ThreadMessage<Res> = Res | { error: string };

export class ThreadPool<Req, Res> {
  private readonly threads: PoolThread<Res>[] = [];
  private queue: QueueItem<Req, Res>[] = [];
  /** routingKey → pinned thread index (affinity). */
  private readonly affinity = new Map<string, number>();
  private isShutdown = false;

  /**
   * @param poolSize  Number of worker threads.
   * @param workerPath  Absolute path to a compiled worker entry (build/...js).
   * @param workerData  Serializable `workerData` passed to every spawned worker.
   * @param name  Public label embedded in error messages (`<name> shutting down`,
   *              `PipelineNotStartedError(<name>)`). Lets the public facade
   *              (e.g. `ChunkerPool`) preserve its identity in user-facing
   *              errors without leaking the internal `ThreadPool` term.
   */
  constructor(
    private readonly poolSize: number,
    private readonly workerPath: string,
    private readonly workerData: unknown,
    private readonly name = "ThreadPool",
  ) {
    this.initThreads();
  }

  private initThreads(): void {
    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(this.workerPath, {
        workerData: this.workerData,
      });
      const pt: PoolThread<Res> = {
        worker,
        busy: false,
        pending: null,
        index: i,
      };

      worker.on("message", (message: ThreadMessage<Res>) => {
        const { pending } = pt;
        pt.busy = false;
        pt.pending = null;
        if (pending) {
          if (message && typeof message === "object" && "error" in message && (message as { error: string }).error) {
            pending.reject(new Error(`Worker error: ${(message as { error: string }).error}`));
          } else {
            pending.resolve(message as Res);
          }
        }
        this.processQueue();
      });

      worker.on("error", (error) => {
        const { pending } = pt;
        pt.busy = false;
        pt.pending = null;
        if (pending) pending.reject(error);
        this.processQueue();
      });

      this.threads.push(pt);
    }
    if (isDebug()) {
      console.error(`[ThreadPool] Initialized ${this.poolSize} threads for ${this.workerPath}`);
    }
  }

  /**
   * Dispatch a request. With routingKey, all same-key requests pin to ONE thread
   * (affinity — required for stateful trajectories like codegraph). Without it,
   * round-robin to any free thread (today's chunker behavior).
   */
  async dispatch(request: Req, routingKey?: string): Promise<Res> {
    if (this.isShutdown) throw new PipelineNotStartedError(this.name);

    return new Promise<Res>((resolve, reject) => {
      const pending: Pending<Res> = { resolve, reject };

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
            const timer = setTimeout(() => {
              void pt.worker.terminate().then(() => {
                resolve();
              });
            }, 2000);
            pt.worker.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
            pt.worker.unref();
            pt.worker.postMessage({ type: "shutdown" });
          }),
      ),
    );
    this.threads.length = 0;
    if (isDebug()) console.error(`[ThreadPool] Shut down ${this.workerPath}`);
  }

  /**
   * Pick a free thread for STATELESS work, preferring one that is NOT pinned by
   * any affinity binding. Stealing an affinity-pinned thread for stateless work
   * strands the affinity items queued behind it (they can only run on that one
   * thread), so a stateless item only lands on a pinned thread when every
   * unpinned thread is busy. Falls back to any free thread to preserve
   * throughput when all free threads happen to be pinned.
   */
  private findFreeStatelessThread(): PoolThread<Res> | undefined {
    const pinnedIndices = new Set(this.affinity.values());
    const unpinnedFree = this.threads.find((w) => !w.busy && !pinnedIndices.has(w.index));
    if (unpinnedFree) return unpinnedFree;
    return this.threads.find((w) => !w.busy);
  }

  private dispatchTo(pt: PoolThread<Res>, request: Req, pending: Pending<Res>): void {
    pt.busy = true;
    pt.pending = pending;
    pt.worker.postMessage(request);
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
