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

// --- Enrichment marker types (per-provider, per-level) ---

/**
 * Run-pointer — the ONLY pre-completion marker write. Lives at
 * `payload.enrichment._run`. Written once at run start (`markRunStart`) and
 * refreshed by a throttled heartbeat. `get_index_status` compares each per-kind
 * marker's `runId` against this to detect stale/in-flight runs (a marker whose
 * runId != the active `_run.runId` is rendered in_progress, never healthy).
 */
export interface RunMarker {
  runId: string;
  startedAt: string;
  /** Throttled heartbeat; advanced on real apply progress. */
  lastProgressAt: string;
  /**
   * Provider keys active in this run. Markers are stored NESTED
   * (`enrichment.codegraph.symbols.file`, matching the applier's codegraph
   * convention), so the marker tree is not self-describing — a dotted key like
   * `codegraph.symbols` is indistinguishable from nesting. This list tells the
   * health mapper which nested paths to navigate to find per-provider markers.
   */
  providers: string[];
}

/**
 * PERSISTED per-level status is terminal-only. `in_progress` / `pending` /
 * `stalled` are NEVER written — they are DERIVED at read time by the health
 * mapper from the `_run` pointer (absent or stale-runId marker). See
 * `EnrichmentLevelHealth` for the API-facing (derived) status union.
 */
export type EnrichmentLevelStatus = "completed" | "degraded" | "failed";

export interface EnrichmentLevelMarker {
  /** The run that produced this terminal marker (staleness key). */
  runId?: string;
  status: EnrichmentLevelStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  matchedFiles?: number;
  missedFiles?: number;
  unenrichedChunks: number;
  /**
   * Propagated error message when `status === "failed"`. Surfaced to
   * `get_index_status` via the health mapper so MCP consumers see the
   * concrete failure (e.g. "Codegraph spill write failed at .spill/…")
   * instead of a generic failure placeholder.
   */
  errorMessage?: string;
}

export type FileEnrichmentMarker = EnrichmentLevelMarker;

export type ChunkEnrichmentMarker = EnrichmentLevelMarker;

export interface ProviderEnrichmentMarker {
  runId: string;
  file: FileEnrichmentMarker;
  chunk: ChunkEnrichmentMarker;
}

/**
 * Shape stored in Qdrant metadata point (ID=1) payload.enrichment.
 * Per-provider entries are keyed by provider key; `_run` holds the run-pointer.
 */
export type EnrichmentMarkerMap = {
  _run?: RunMarker;
} & Record<string, ProviderEnrichmentMarker | RunMarker | undefined>;

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
  runId: string;
  status: "completed" | "degraded" | "failed";
  durationMs: number;
  unenrichedChunks: number;
  matchedFiles: number;
  missedFiles: number;
}

/** Input for EnrichmentMarkerStore.markChunkFinal. */
export interface ChunkFinalInput {
  runId: string;
  status: "completed" | "degraded" | "failed";
  durationMs: number;
  unenrichedChunks: number;
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
}
