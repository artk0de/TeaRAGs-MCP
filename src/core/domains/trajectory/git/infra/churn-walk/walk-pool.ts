/**
 * ChunkChurnWalkPool — main-side host of N churn-walk worker threads
 * (bd tea-rags-mcp-iqpuu pool evolution, dog1v follow-up).
 *
 * The git chunk-churn walk chains 7-15 awaits per commit hold; running it on
 * the ingest main thread inflated holds 120ms->1.2s and embed calls ~2x. iqpuu
 * moved the whole walk onto ONE dedicated worker thread. But per-batch walks
 * are dispatched CONCURRENTLY (ChunkPhase pushes each batch's walk into
 * `chunkWork[]`, drained together) — a single worker serialises them, so on a
 * large repo the walk (git log + cat-file + structuredPatch over every chunk
 * batch) becomes the enrichment long-pole and spills past the embedding window.
 * This host fans the concurrent per-batch walks across N worker threads
 * (round-robin), each with its OWN run-scoped reader/memo/limiter (worker.ts) —
 * so the walk keeps pace with embedding instead of trailing it.
 *
 * Lifecycle is owned by ChunkPhase (mirrors the 82va1 commit-discovery
 * pattern): lazy create at the first git chunk dispatch via the provider's
 * `createChunkChurnWalkThread` hook, closed at drain(). Each Worker is spawned
 * lazily on its first walk, so a run with few batches never forks all N.
 *
 * Reuses the churn-walk worker.js "walk" job; differs from the BlameWorkerPool
 * only in dispatch (round-robin one job per call vs file sharding).
 */

import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { ChunkChurnWalkThreadError } from "../../errors.js";
import type {
  ChunkChurnWalkJobInput,
  ChunkChurnWalkOutcome,
  ChurnWalkThreadRequest,
  ChurnWalkThreadResponse,
} from "./protocol.js";

/**
 * Worker script path — always points to compiled JS in build/ (worker_threads
 * require compiled JS; chunker pool.ts idiom). import.meta.url resolves to:
 *   production: .../build/.../churn-walk/walk-pool.js
 *   vitest:     .../src/.../churn-walk/walk-pool.ts (remap to build/)
 */
const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)).replace("/src/", "/build/"), "worker.js");

/** How long close() waits for a graceful worker exit before terminate(). */
const CLOSE_TIMEOUT_MS = 5000;

interface PendingWalk {
  resolve: (outcome: ChunkChurnWalkOutcome) => void;
  reject: (error: Error) => void;
}

export class ChunkChurnWalkPool {
  private readonly size: number;
  private readonly workers: (Worker | undefined)[];
  private closed = false;
  private nextId = 0;
  private nextWorker = 0;
  private readonly pending = new Map<number, PendingWalk>();

  constructor(size: number) {
    this.size = Math.max(1, size);
    this.workers = new Array<Worker | undefined>(this.size).fill(undefined);
  }

  /** Dispatch one walk job to the next worker (round-robin); resolves with that
   *  worker's overlays + stats. Concurrent walk() calls land on distinct
   *  workers, so the per-batch walks run in parallel. */
  async walk(job: ChunkChurnWalkJobInput): Promise<ChunkChurnWalkOutcome> {
    const workerIdx = this.nextWorker;
    this.nextWorker = (this.nextWorker + 1) % this.size;
    const worker = this.ensureWorker(workerIdx);
    const id = this.nextId++;
    return new Promise<ChunkChurnWalkOutcome>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ type: "walk", id, job } satisfies ChurnWalkThreadRequest);
    });
  }

  /**
   * Idempotent teardown. Posts "close" to every live worker (each closes its
   * cat-file readers + parentPort), waits for graceful exits with a bounded
   * timeout, then hard-terminates the stragglers. Any walk still pending is
   * rejected — its batch reports a failed walk and backfill/recovery covers it.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const live = this.workers.filter((w): w is Worker => w !== undefined);
    this.workers.fill(undefined);
    try {
      await Promise.all(
        live.map(async (worker) => {
          worker.postMessage({ type: "close" } satisfies ChurnWalkThreadRequest);
          let timer: NodeJS.Timeout | undefined;
          const timedOut = new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => {
              resolve("timeout");
            }, CLOSE_TIMEOUT_MS);
          });
          const outcome = await Promise.race([once(worker, "exit").then(() => "exit" as const), timedOut]);
          if (timer) clearTimeout(timer);
          if (outcome === "timeout") await worker.terminate();
        }),
      );
    } finally {
      this.rejectAll(new ChunkChurnWalkThreadError("pool closed with walks still pending"));
    }
  }

  private ensureWorker(idx: number): Worker {
    const existing = this.workers[idx];
    if (existing) return existing;
    if (this.closed) throw new ChunkChurnWalkThreadError("walk() after close()");
    const worker = new Worker(WORKER_PATH);
    worker.on("message", (response: ChurnWalkThreadResponse) => {
      this.onResponse(response);
    });
    worker.on("error", (error: Error) => {
      this.rejectAll(new ChunkChurnWalkThreadError("worker thread error", error));
    });
    worker.on("exit", (code: number) => {
      if (!this.closed && code !== 0) {
        this.rejectAll(new ChunkChurnWalkThreadError(`worker thread exited unexpectedly (code ${code})`));
      }
    });
    this.workers[idx] = worker;
    return worker;
  }

  private onResponse(response: ChurnWalkThreadResponse): void {
    // This host only ever dispatches "walk" jobs — ignore any blame responses
    // that share the worker.js protocol union but never arrive here.
    if (response.type !== "walked" && response.type !== "walk-failed") return;
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    if (response.type === "walked") {
      entry.resolve({ overlays: response.overlays, stats: response.stats });
    } else {
      entry.reject(new ChunkChurnWalkThreadError(response.error));
    }
  }

  private rejectAll(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
