import type { Ignore } from "ignore";

import type { EnrichmentProvider } from "../../../../contracts/types/provider.js";

export type {
  ChunkSignalOptions,
  EnrichmentProvider,
  FileSignalTransform,
} from "../../../../contracts/types/provider.js";

/**
 * Per-run, immutable context for a single enrichment provider. Computed once
 * by EnrichmentCoordinator.prefetch() and shared read-only with all phases
 * (FilePhase, ChunkPhase, Backfiller, EnrichmentRecovery).
 */
export interface ProviderContext {
  readonly key: string;
  readonly provider: EnrichmentProvider;
  readonly effectiveRoot: string | null;
  readonly ignoreFilter: Ignore | null;
}

// --- Enrichment marker types (per-provider, per-level) ---

export type EnrichmentLevelStatus = "pending" | "in_progress" | "completed" | "degraded" | "failed";

export interface EnrichmentLevelMarker {
  status: EnrichmentLevelStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  matchedFiles?: number;
  missedFiles?: number;
  unenrichedChunks: number;
  /** ISO timestamp of last progress heartbeat */
  lastProgressAt?: string;
  /** Enriched chunk count at last heartbeat */
  lastProgressChunks?: number;
  /**
   * Propagated error message when `status === "failed"`. Surfaced to
   * `get_index_status` via the health mapper so MCP consumers see the
   * concrete failure (e.g. "Codegraph spill write failed at .spill/…")
   * instead of a generic "in_progress" stuck marker. Optional because
   * the markStart / markFileFinal paths don't carry one.
   */
  errorMessage?: string;
}

export interface FileEnrichmentMarker extends EnrichmentLevelMarker {
  status: "pending" | "in_progress" | "completed" | "failed";
}

export interface ChunkEnrichmentMarker extends EnrichmentLevelMarker {
  status: "pending" | "in_progress" | "completed" | "degraded" | "failed";
}

export interface ProviderEnrichmentMarker {
  runId: string;
  file: FileEnrichmentMarker;
  chunk: ChunkEnrichmentMarker;
}

/** Shape stored in Qdrant metadata point (ID=1) payload.enrichment */
export type EnrichmentMarkerMap = Record<string, ProviderEnrichmentMarker>;

/** API-facing health per level */
export interface EnrichmentLevelHealth {
  status: "healthy" | "in_progress" | "degraded" | "failed";
  unenrichedChunks?: number;
  message?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  matchedFiles?: number;
  missedFiles?: number;
}

/** API-facing health per provider */
export interface EnrichmentProviderHealth {
  file: EnrichmentLevelHealth;
  chunk: EnrichmentLevelHealth;
}

/** API-facing enrichment health map */
export type EnrichmentHealthMap = Record<string, EnrichmentProviderHealth>;

/** Input for EnrichmentMarkerStore.markFileFinal. */
export interface FileFinalInput {
  status: "completed" | "failed";
  durationMs: number;
  unenrichedChunks: number;
  matchedFiles: number;
  missedFiles: number;
}

/** Input for EnrichmentMarkerStore.markChunkFinal. */
export interface ChunkFinalInput {
  status: "completed" | "degraded" | "failed";
  durationMs: number;
  unenrichedChunks: number;
}

/** Input for EnrichmentMarkerStore.markRecoveryResult. */
export interface RecoveryResultInput {
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
}
