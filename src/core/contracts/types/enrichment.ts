/**
 * API-facing enrichment health types — shared across the api/public surface,
 * the ingest enrichment domain (health-mapper), and mcp consumers.
 *
 * Internal coordinator types stay in
 * `core/domains/ingest/pipeline/enrichment/types.ts`; only the read-side health
 * shape, the persisted marker format it is rendered from, and the mapper
 * signature live here so consumers can import them without crossing a domain
 * boundary.
 */

/** API-facing health per level (file / chunk). */
/**
 * Why a terminal marker is `degraded` when the cause is not a measured residual
 * of unenriched points. `barrier-timeout`: Qdrant never confirmed this run's
 * queued payload writes applied within `QDRANT_TUNE_WRITE_BARRIER_BUDGET_MS`,
 * so the unenriched scan was not run — its count would have read writes still
 * in flight (bd tea-rags-mcp-yf4je).
 */
export type EnrichmentDegradedReason = "barrier-timeout";

export interface EnrichmentLevelHealth {
  status: "healthy" | "in_progress" | "degraded" | "failed";
  /** Set on a `degraded` level whose cause is not an unenriched count. */
  degradedReason?: EnrichmentDegradedReason;
  unenrichedChunks?: number;
  message?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  matchedFiles?: number;
  missedFiles?: number;
  /** Files intentionally skipped by per-file enrichment policy (not a failure). */
  ignoredFiles?: number;
}

/** API-facing health per enrichment provider. */
export interface EnrichmentProviderHealth {
  file: EnrichmentLevelHealth;
  chunk: EnrichmentLevelHealth;
}

/** API-facing enrichment health map — keyed by provider key. */
export type EnrichmentHealthMap = Record<string, EnrichmentProviderHealth>;

// --- Persisted enrichment marker format (payload.enrichment on the indexing-metadata point) ---
//
// Pure shape: ingest writes and reads it, explore reads it and renders it through
// an injected `EnrichmentHealthMapper`, so it lives here rather than in either domain.

/**
 * Run-pointer — the ONLY pre-completion marker write. Lives at
 * `payload.enrichment._run`. Written once at run start (`markRunStart`) and
 * refreshed by a throttled heartbeat.
 *
 * It is evidence about the providers it COVERS (`providers`) and about nobody
 * else. For a covered provider the health mapper compares each per-kind
 * marker's `runId` against `runId` here to detect stale/in-flight work (a
 * marker whose runId differs is derived from these timestamps — in_progress or
 * failed, never healthy). For an ACTIVE provider this run did not cover, these
 * timestamps describe someone else's work and are not consulted at all: its own
 * latest terminal marker stands. See `health-mapper.ts` for the full frame.
 */
export interface RunMarker {
  runId: string;
  startedAt: string;
  /** Throttled heartbeat; advanced on real apply progress. */
  lastProgressAt: string;
  /**
   * Provider keys THIS RUN covered — a coverage set, not the frame of the
   * health report. `--force-enrichments codegraph` writes a run naming
   * `codegraph.symbols` alone while git markers from an earlier run stay valid
   * on the same points, so the health mapper navigates from the RUNNING
   * COMPOSITION's provider list (passed in by the caller) and consults this
   * list only to decide whether the run's timestamps describe a given provider.
   *
   * Markers are stored NESTED (`enrichment.codegraph.symbols.file`, matching
   * the applier's codegraph convention), so the marker tree is not
   * self-describing — a dotted key like `codegraph.symbols` is
   * indistinguishable from nesting. Both lists are dotted keys read the same
   * way, which is why either can drive the navigation.
   */
  providers: string[];
}

/**
 * PERSISTED per-level status is terminal-only. `in_progress` / `pending` /
 * `stalled` are NEVER written — they are DERIVED at read time by the health
 * mapper from the `_run` pointer, for a provider the run covers (absent or
 * stale-runId marker). An active provider the run does NOT cover is never
 * derived as in progress: its own terminal marker renders as is, and a missing
 * or non-terminal one renders as a derived `failed`. See
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
  /** Files intentionally skipped by per-file enrichment policy (not a failure). */
  ignoredFiles?: number;
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

/**
 * Renders the persisted marker map as API-facing health, framed on the running
 * composition's provider list. Injected into explore's `IndexMetricsQuery` so the
 * read path never imports the ingest implementation (`mapMarkerToHealth`).
 */
export type EnrichmentHealthMapper = (
  markerMap: EnrichmentMarkerMap,
  activeEnrichmentProviders: readonly string[],
) => EnrichmentHealthMap | undefined;
