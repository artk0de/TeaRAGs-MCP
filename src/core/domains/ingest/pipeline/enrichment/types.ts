export type { EnrichmentProvider, FileSignalTransform } from "../../../../contracts/types/provider.js";

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
