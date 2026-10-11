/**
 * API-facing enrichment health types — shared across the api/public surface,
 * the ingest enrichment domain (health-mapper), and mcp consumers.
 *
 * Internal coordinator/marker types stay in
 * `core/domains/ingest/pipeline/enrichment/types.ts`; only the read-side health
 * shape lives here so consumers can import it without crossing a domain
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
