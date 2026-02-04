/**
 * ChunkerPool - Worker thread pool for parallel AST parsing
 *
 * Manages a pool of worker_threads, each running its own TreeSitterChunker
 * with independent Parser instances. This enables true parallel AST parsing,
 * unblocking the main thread event loop.
 */

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ChunkerConfig, CodeChunk } from "../types.js";
import type { WorkerRequest, WorkerResponse } from "./chunker-worker.js";

/**
 * Worker script path — always points to compiled JS in build/.
 *
 * worker_threads require compiled JS. import.meta.url resolves to:
 *   production: .../build/code/chunker/chunker-pool.js  (sibling .js exists)
 *   vitest:     .../src/code/chunker/chunker-pool.ts    (no .js — remap to build/)
 */
const WORKER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)).replace("/src/", "/build/"),
  "chunker-worker.js",
);

export interface FileChunkResult {
  filePath: string;
  chunks: CodeChunk[];
}

interface PendingRequest {
  resolve: (result: FileChunkResult) => void;
  reject: (error: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
  pending: PendingRequest | null;
}

const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "1";

export class ChunkerPool {
  private workers: PoolWorker[] = [];
  private queue: Array<{ request: WorkerRequest; pending: PendingRequest }> = [];
  private isShutdown = false;

  constructor(
    private poolSize: number,
    private config: ChunkerConfig,
  ) {
    this.initWorkers();
  }

  private initWorkers(): void {
    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(WORKER_PATH, {
        workerData: this.config,
      });

      const poolWorker: PoolWorker = {
        worker,
        busy: false,
        pending: null,
      };

      worker.on("message", (response: WorkerResponse) => {
        const { pending } = poolWorker;
        poolWorker.busy = false;
        poolWorker.pending = null;

        if (pending) {
          if (response.error) {
            pending.reject(new Error(`Worker error: ${response.error}`));
          } else {
            pending.resolve({
              filePath: response.filePath,
              chunks: response.chunks,
            });
          }
        }

        // Process next queued item
        this.processQueue();
      });

      worker.on("error", (error) => {
        const { pending } = poolWorker;
        poolWorker.busy = false;
        poolWorker.pending = null;

        if (pending) {
          pending.reject(error);
        }
      });

      this.workers.push(poolWorker);
    }

    if (DEBUG) {
      console.error(`[ChunkerPool] Initialized ${this.poolSize} worker threads`);
    }
  }

  /**
   * Process a single file in a worker thread.
   * Returns the same chunks that TreeSitterChunker.chunk() would produce.
   */
  async processFile(
    filePath: string,
    code: string,
    language: string,
  ): Promise<FileChunkResult> {
    if (this.isShutdown) {
      throw new Error("ChunkerPool is shut down");
    }

    const request: WorkerRequest = { filePath, code, language };

    return new Promise<FileChunkResult>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };

      // Find a free worker
      const freeWorker = this.workers.find((w) => !w.busy);
      if (freeWorker) {
        this.dispatch(freeWorker, request, pending);
      } else {
        // All workers busy — queue the request
        this.queue.push({ request, pending });
      }
    });
  }

  /**
   * Shut down all workers gracefully.
   */
  async shutdown(): Promise<void> {
    this.isShutdown = true;

    // Reject any queued requests
    for (const { pending } of this.queue) {
      pending.reject(new Error("ChunkerPool shutting down"));
    }
    this.queue = [];

    // Terminate all workers
    await Promise.all(
      this.workers.map((pw) => pw.worker.terminate()),
    );
    this.workers = [];

    if (DEBUG) {
      console.error("[ChunkerPool] Shut down all workers");
    }
  }

  private dispatch(
    poolWorker: PoolWorker,
    request: WorkerRequest,
    pending: PendingRequest,
  ): void {
    poolWorker.busy = true;
    poolWorker.pending = pending;
    poolWorker.worker.postMessage(request);
  }

  private processQueue(): void {
    if (this.queue.length === 0) return;

    const freeWorker = this.workers.find((w) => !w.busy);
    if (!freeWorker) return;

    const next = this.queue.shift()!;
    this.dispatch(freeWorker, next.request, next.pending);
  }
}
