/**
 * Codec for indexing marker payload stored in Qdrant.
 * Normalizes historical format variations (completedAt as string/number/Date)
 * into a single canonical format.
 */

import type { EnrichmentMarkerMap } from "./enrichment/types.js";

export interface IndexingMarkerPayload {
  indexingComplete: boolean;
  startedAt?: string;
  completedAt?: string;
  lastHeartbeat?: string;
  embeddingModel?: string;
  enrichment?: EnrichmentMarkerMap;
}

/** Parse raw Qdrant payload into typed IndexingMarkerPayload. */
export function parseMarkerPayload(raw: Record<string, unknown>): IndexingMarkerPayload {
  return {
    indexingComplete: raw.indexingComplete === true,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : undefined,
    completedAt: normalizeTimestamp(raw.completedAt),
    lastHeartbeat: typeof raw.lastHeartbeat === "string" ? raw.lastHeartbeat : undefined,
    embeddingModel: typeof raw.embeddingModel === "string" ? raw.embeddingModel : undefined,
    enrichment:
      raw.enrichment !== null && raw.enrichment !== undefined && typeof raw.enrichment === "object"
        ? (raw.enrichment as EnrichmentMarkerMap)
        : undefined,
  };
}

/** Serialize IndexingMarkerPayload for Qdrant storage. Omits undefined fields. */
export function serializeMarkerPayload(marker: IndexingMarkerPayload): Record<string, unknown> {
  const result: Record<string, unknown> = {
    indexingComplete: marker.indexingComplete,
  };
  if (marker.startedAt !== undefined) result.startedAt = marker.startedAt;
  if (marker.completedAt !== undefined) result.completedAt = marker.completedAt;
  if (marker.lastHeartbeat !== undefined) {
    result.lastHeartbeat = marker.lastHeartbeat;
  }
  if (marker.embeddingModel !== undefined) {
    result.embeddingModel = marker.embeddingModel;
  }
  if (marker.enrichment !== undefined) result.enrichment = marker.enrichment;
  return result;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  if (value instanceof Date) return value.toISOString();
  return undefined;
}
