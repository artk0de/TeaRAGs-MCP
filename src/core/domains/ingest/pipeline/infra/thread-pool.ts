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

      const free = this.threads.find((w) => !w.busy);
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

  private dispatchTo(pt: PoolThread<Res>, request: Req, pending: Pending<Res>): void {
    pt.busy = true;
    pt.pending = pending;
    pt.worker.postMessage(request);
  }

  private processQueue(): void {
    if (this.queue.length === 0) return;
    // First, try to honor an affinity-pinned item whose thread is now free.
    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];
      if (item.affinityIndex !== null) {
        const pt = this.threads[item.affinityIndex];
        if (pt && !pt.busy) {
          this.queue.splice(i, 1);
          this.dispatchTo(pt, item.request, item.pending);
          return;
        }
        continue; // pinned thread still busy — leave queued
      }
      // Stateless item: any free thread.
      const free = this.threads.find((w) => !w.busy);
      if (free) {
        this.queue.splice(i, 1);
        this.dispatchTo(free, item.request, item.pending);
        return;
      }
      return; // no free thread
    }
  }
}
