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

/** API-facing health per enrichment provider. */
export interface EnrichmentProviderHealth {
  file: EnrichmentLevelHealth;
  chunk: EnrichmentLevelHealth;
}

/** API-facing enrichment health map — keyed by provider key. */
export type EnrichmentHealthMap = Record<string, EnrichmentProviderHealth>;
