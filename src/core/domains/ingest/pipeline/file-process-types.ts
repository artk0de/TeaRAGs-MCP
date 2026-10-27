/**
 * The file-processing batch contract shared by `file-processor.ts` and
 * `file-ingestor.ts` (bd tea-rags-mcp-54xwd.14): the processor constructs the
 * ingestor, so the option/result/callback types declare here — a leaf both
 * import — instead of in the processor, whose import the ingestor would mirror
 * back.
 */

import type { FileExtraction } from "../../../contracts/types/codegraph.js";
import type { ChunkLookupEntry } from "../../../types.js";
import type { ReindexCoordinator } from "../sync/deletion/reindex-coordinator.js";
import type { QuarantineStore, SkippedFileStore } from "../sync/index.js";

export interface FileProcessorOptions {
  enableGitMetadata: boolean;
  maxChunksPerFile?: number;
  maxTotalChunks?: number;
  concurrency?: number;
  /**
   * Optional per-file barrier. When set, files whose delete silently failed
   * (tracked by the coordinator) are skipped from upsert to prevent orphan
   * duplicates. Pass ONLY for the modified-files pass — added files have no
   * old chunks to collide with. See reindex-resilience plan Phase 3.2.
   */
  coordinator?: ReindexCoordinator;
  /**
   * Optional poison-pill quarantine. When set, files that fail to read or parse
   * are recorded here (instead of silently dropping out of the index) and
   * retried automatically on every subsequent indexing pass.
   */
  quarantineStore?: QuarantineStore;
  /**
   * Paths (relative to basePath) that were quarantined on a prior pass and are
   * being retried this pass. A file in this set that now processes successfully
   * is cleared from the quarantine. Files NOT in this set never trigger a clear,
   * so the common (never-failed) case pays no extra write.
   */
  quarantinedRetry?: Set<string>;
  /**
   * Optional deterministic-skip record (bd tea-rags-mcp-6xdwe). When set, a
   * file skipped by the secrets gate, the compiled-bundle gate, or for blank
   * content is recorded with its content hash; a path that later ingests with
   * chunks is cleared. Never retried — the verdict is a function of content.
   * A non-quarantinable failure is recorded here as a retryable `runtimeError`
   * (bd tea-rags-mcp-muj77); the pipelines keep it out of the saved snapshot.
   */
  skippedFileStore?: SkippedFileStore;
  /**
   * yl9tv cross-pass. When set (codegraph enabled), the chunker worker also
   * emits a codegraph `FileExtraction` from the SAME parse it chunks with, and
   * this hook forwards it (with a root-relative `relPath`) to the enrichment
   * coordinator → codegraph provider spill — eliminating the provider's
   * main-thread re-parse. Presence of this hook is what flips the worker's
   * `emitExtraction` on.
   */
  onFileExtraction?: (extraction: FileExtraction) => void;
}

export interface FileProcessResult {
  chunksCreated: number;
  filesProcessed: number;
  chunkMap: Map<string, ChunkLookupEntry[]>;
  errors: string[];
}

export interface FileProcessCallbacks {
  onFileProcessed?: (filePath: string, chunksCount: number) => void;
}
