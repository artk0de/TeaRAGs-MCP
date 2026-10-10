import type { Ignore } from "ignore";

import type { EnrichmentProvider } from "../../../../contracts/types/provider.js";

export type {
  ChunkSignalOptions,
  EnrichmentProvider,
  FileSignalTransform,
} from "../../../../contracts/types/provider.js";

/**
 * Per-run, immutable context for a single enrichment provider. Computed once
 * by EnrichmentCoordinator.beginRun() and shared read-only with all phases
 * (FilePhase, ChunkPhase, Backfiller, EnrichmentRecovery).
 */
export interface ProviderContext {
  readonly key: string;
  readonly provider: EnrichmentProvider;
  readonly effectiveRoot: string | null;
  readonly ignoreFilter: Ignore | null;
}

// Enrichment marker types (per-provider, per-level) live in `ingest/infra`: the
// persisted marker format is read by the collection lease below the pipeline.
// Re-exported here so internal enrichment code keeps the same import paths.
export type {
  ChunkEnrichmentMarker,
  EnrichmentLevelMarker,
  EnrichmentLevelStatus,
  EnrichmentMarkerMap,
  FileEnrichmentMarker,
  ProviderEnrichmentMarker,
  RunMarker,
} from "../../infra/index.js";

// API-facing enrichment health types live in core/contracts/types/enrichment.ts.
// Re-exported here so internal ingest code keeps the same import paths.
export type {
  EnrichmentLevelHealth,
  EnrichmentProviderHealth,
  EnrichmentHealthMap,
} from "../../../../contracts/types/enrichment.js";

/** Input for EnrichmentMarkerStore.markFileFinal. */
export interface FileFinalInput {
  runId: string;
  status: "completed" | "degraded" | "failed";
  durationMs: number;
  unenrichedChunks: number;
  matchedFiles: number;
  missedFiles: number;
  /** Files intentionally skipped by per-file enrichment policy (not a failure). */
  ignoredFiles?: number;
  /**
   * Cause of a failed prefetch, carried into the TERMINAL marker — the worker
   * runs detached (stderr ignored), so the marker is the only durable place a
   * reader (get_index_status / prime) can surface the failure from (2nfdm).
   */
  errorMessage?: string;
}

/** Input for EnrichmentMarkerStore.markChunkFinal. */
export interface ChunkFinalInput {
  runId: string;
  status: "completed" | "degraded" | "failed";
  durationMs: number;
  unenrichedChunks: number;
  /** Cause of the upstream failure — see FileFinalInput.errorMessage. */
  errorMessage?: string;
}

/** Input for EnrichmentMarkerStore.markRecoveryResult. */
export interface RecoveryResultInput {
  runId: string;
  fileStatus: "completed" | "failed";
  fileUnenriched: number;
  chunkStatus: "completed" | "degraded" | "failed";
  chunkUnenriched: number;
}

/** Per-chunk reference for files whose chunks landed without file metadata. */
export interface MissedFileChunk {
  chunkId: string;
  startLine: number;
  endLine: number;
  /** The chunker's symbolId, carried into the backfill's chunk lookup entries (bd tea-rags-mcp-9i2ow). */
  symbolId?: string;
  /** File line count, so the backfill's chunk policy sees a size-driven decline (bd tea-rags-mcp-2brzq). */
  moduleLines?: number;
}
