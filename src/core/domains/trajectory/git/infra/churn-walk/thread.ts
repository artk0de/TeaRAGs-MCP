/**
 * ChunkChurnWalkThread — main-side host of the dedicated churn-walk worker
 * thread (bd tea-rags-mcp-iqpuu).
 *
 * The git chunk-churn walk chains 7-15 awaits per commit hold; running it on
 * the ingest main thread inflated holds 120ms->1.2s and embed calls ~2x
 * (event-loop resumption delay under embedding/Qdrant load). This host moves
 * the whole walk pipeline onto ONE dedicated worker thread: serializable
 * per-batch jobs go in (protocol.ts), overlay maps + walk stats come back.
 *
 * Lifecycle is owned by ChunkPhase (mirrors the 82va1 commit-discovery
 * pattern): lazy create at the first git chunk dispatch via the provider's
 * `createChunkChurnWalkThread` hook, closed at drain(). The Worker itself is
 * spawned lazily on the first walk(), so a run with no git chunk work never
 * forks a thread.
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
 *   production: .../build/core/domains/trajectory/git/infra/churn-walk/thread.js
 *   vitest:     .../src/core/domains/trajectory/git/infra/churn-walk/thread.ts (remap to build/)
 */
const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)).replace("/src/", "/build/"), "worker.js");

/** How long close() waits for a graceful worker exit before terminate(). */
const CLOSE_TIMEOUT_MS = 5000;

interface PendingWalk {
  resolve: (outcome: ChunkChurnWalkOutcome) => void;
  reject: (error: Error) => void;
}

export class ChunkChurnWalkThread {
  private worker?: Worker;
  private closed = false;
  private nextId = 0;
  private readonly pending = new Map<number, PendingWalk>();

  /** Dispatch one walk job; resolves with the worker's overlays + stats. */
  async walk(job: ChunkChurnWalkJobInput): Promise<ChunkChurnWalkOutcome> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<ChunkChurnWalkOutcome>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ type: "walk", id, job } satisfies ChurnWalkThreadRequest);
    });
  }

  /**
   * Idempotent teardown. Posts the "close" envelope (the worker closes its
   * cat-file readers and its parentPort), waits for a graceful exit with a
   * bounded timeout, then hard-terminates as fallback. Any walk still
   * pending at close time is rejected — its batch reports a failed walk and
   * backfill/recovery covers the chunks.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const { worker } = this;
    if (!worker) return;
    this.worker = undefined;
    try {
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
    } finally {
      this.rejectAll(new ChunkChurnWalkThreadError("thread closed with walks still pending"));
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    if (this.closed) throw new ChunkChurnWalkThreadError("walk() after close()");
    const worker = new Worker(WORKER_PATH);
    worker.on("message", (response: ChurnWalkThreadResponse) => {
      this.onResponse(response);
    });
    worker.on("error", (error: Error) => {
      this.rejectAll(new ChunkChurnWalkThreadError("worker thread error", error));
    });
    worker.on("exit", (code: number) => {
      if (!this.closed) {
        this.rejectAll(new ChunkChurnWalkThreadError(`worker thread exited unexpectedly (code ${code})`));
      }
    });
    this.worker = worker;
    return worker;
  }

  private onResponse(response: ChurnWalkThreadResponse): void {
    // This host only ever dispatches "walk" jobs — ignore the pool's blame
    // responses (they share the worker.js protocol union but never arrive here).
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
