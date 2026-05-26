/**
 * ChunkerPool - Worker thread pool for parallel AST parsing
 *
 * Manages a pool of worker_threads, each running its own TreeSitterChunker
 * with independent Parser instances. This enables true parallel AST parsing,
 * unblocking the main thread event loop.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { ChunkerConfig, CodeChunk } from "../../../../../types.js";
import { PipelineNotStartedError } from "../../../errors.js";
import { isDebug } from "../../infra/runtime.js";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol.js";

/**
 * Worker script path — always points to compiled JS in build/.
 *
 * worker_threads require compiled JS. The worker ENTRY is the second
 * composition root (spec §5) and now lives next to this pool — it is the pool's
 * ingest-local sibling `worker.js`. The worker stays free of any static
 * `domains/language` import: it loads the concrete `LanguageFactoryImpl` /
 * `DefaultSymbolIdComposer` at runtime via a dynamic `import(path)` where the
 * path (`LANGUAGE_MODULE_PATH`) is injected through `workerData` below.
 *
 * import.meta.url resolves to:
 *   production: .../build/core/domains/ingest/pipeline/chunker/infra/pool.js
 *   vitest:     .../src/core/domains/ingest/pipeline/chunker/infra/pool.ts (remap to build/)
 */
const POOL_DIR = path.dirname(fileURLToPath(import.meta.url)).replace("/src/", "/build/");
// POOL_DIR = build/core/domains/ingest/pipeline/chunker/infra — five levels
// below build/core (domains, ingest, pipeline, chunker, infra).
const CORE_DIR = path.resolve(POOL_DIR, "../../../../..");
const WORKER_PATH = path.join(POOL_DIR, "worker.js");
/**
 * Absolute path to the compiled `domains/language` barrel, computed here (a
 * runtime STRING — not an import) and injected into the worker via `workerData`
 * so the worker can dynamically import the concrete factory + composer without
 * `domains/ingest` ever statically importing `domains/language`. The variable
 * path is invisible to the leaf-domain eslint guard (it inspects only literal
 * import specifiers), so no exemption is needed.
 */
const LANGUAGE_MODULE_PATH = path.join(CORE_DIR, "domains", "language", "index.js");

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

export class ChunkerPool {
  private workers: PoolWorker[] = [];
  private queue: { request: WorkerRequest; pending: PendingRequest }[] = [];
  private isShutdown = false;

  constructor(
    private readonly poolSize: number,
    private readonly config: ChunkerConfig,
  ) {
    this.initWorkers();
  }

  private initWorkers(): void {
    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(WORKER_PATH, {
        // Inject the language-module path so the worker (a second composition
        // root) can dynamically import the concrete factory + composer in-thread.
        workerData: { ...this.config, languageModulePath: LANGUAGE_MODULE_PATH },
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

    if (isDebug()) {
      console.error(`[ChunkerPool] Initialized ${this.poolSize} worker threads`);
    }
  }

  /**
   * Process a single file in a worker thread.
   * Returns the same chunks that TreeSitterChunker.chunk() would produce.
   */
  async processFile(filePath: string, code: string, language: string): Promise<FileChunkResult> {
    if (this.isShutdown) {
      throw new PipelineNotStartedError("ChunkerPool");
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
   *
   * Sends a shutdown message so each worker can close its port and let
   * tree-sitter NAPI destructors run in the correct thread. Falls back
   * to terminate() if a worker doesn't exit within the timeout.
   */
  async shutdown(): Promise<void> {
    this.isShutdown = true;

    // Reject any queued requests
    for (const { pending } of this.queue) {
      pending.reject(new Error("ChunkerPool shutting down"));
    }
    this.queue = [];

    // Graceful shutdown: unref workers so they don't keep the process alive,
    // then post shutdown message and wait for exit with a timeout fallback.
    await Promise.all(
      this.workers.map(
        async (pw) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              void pw.worker.terminate().then(() => {
                resolve();
              });
            }, 2000);
            pw.worker.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
            pw.worker.unref();
            pw.worker.postMessage({ type: "shutdown" });
          }),
      ),
    );
    this.workers = [];

    if (isDebug()) {
      console.error("[ChunkerPool] Shut down all workers");
    }
  }

  private dispatch(poolWorker: PoolWorker, request: WorkerRequest, pending: PendingRequest): void {
    poolWorker.busy = true;
    poolWorker.pending = pending;
    poolWorker.worker.postMessage(request);
  }

  private processQueue(): void {
    if (this.queue.length === 0) return;

    const freeWorker = this.workers.find((w) => !w.busy);
    if (!freeWorker) return;

    const next = this.queue.shift();
    if (!next) return;
    this.dispatch(freeWorker, next.request, next.pending);
  }
}
