/**
 * ChunkerPool - Worker thread pool for parallel AST parsing
 *
 * Thin wrapper around the generic `ThreadPool<Req, Res>` (sibling at
 * `pipeline/infra/thread-pool.ts`). All distribution mechanics — worker
 * lifecycle, free-worker selection, round-robin, overflow queue, graceful
 * shutdown — live in `ThreadPool`. `ChunkerPool` only knows the chunker's
 * compiled worker path, its workerData shape (`ChunkerConfig` +
 * injected `languageModulePath`), and the `processFile` -> `FileChunkResult`
 * contract.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ChunkerConfig, CodeChunk } from "../../../../../types.js";
import { ThreadPool } from "../../infra/thread-pool.js";
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

export class ChunkerPool {
  private readonly pool: ThreadPool<WorkerRequest, WorkerResponse>;

  constructor(poolSize: number, config: ChunkerConfig) {
    // Inject the language-module path so the worker (a second composition
    // root) can dynamically import the concrete factory + composer in-thread.
    this.pool = new ThreadPool<WorkerRequest, WorkerResponse>(
      poolSize,
      WORKER_PATH,
      {
        ...config,
        languageModulePath: LANGUAGE_MODULE_PATH,
      },
      // Preserve "ChunkerPool"-flavored error messages in user-facing rejections
      // and `PipelineNotStartedError` — the consumer's identity, not the
      // internal pool's, belongs in error text.
      "ChunkerPool",
    );
  }

  /**
   * Process a single file in a worker thread.
   * Returns the same chunks that TreeSitterChunker.chunk() would produce.
   */
  async processFile(filePath: string, code: string, language: string): Promise<FileChunkResult> {
    const response = await this.pool.dispatch({ filePath, code, language });
    // ThreadPool already rejects on `response.error`; here we only narrow the
    // wire shape (`WorkerResponse`) to the public contract (`FileChunkResult`).
    return { filePath: response.filePath, chunks: response.chunks };
  }

  /**
   * Shut down all workers gracefully.
   *
   * Delegates to ThreadPool, which sends a shutdown message so each worker can
   * close its port and let tree-sitter NAPI destructors run in the correct
   * thread, falling back to terminate() if a worker doesn't exit within 2s.
   */
  async shutdown(): Promise<void> {
    return this.pool.shutdown();
  }
}
