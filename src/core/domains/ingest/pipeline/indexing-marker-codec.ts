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
  modelInfo?: {
    model: string;
    contextLength: number;
    dimensions: number;
  };
  enrichment?: EnrichmentMarkerMap;
}

/**
 * How long a marker may sit at `indexingComplete: false` without advancing
 * before the run that owns it is presumed dead.
 *
 * Shared because two callers must agree on the number: `status-module` decides
 * whether to report `stale_indexing`, and `infra/alias-cleanup` decides whether
 * a half-built versioned collection may be reclaimed. If those drift apart, one
 * of them is wrong about whether a run is alive — and the cleanup side deletes
 * a collection when it guesses wrong.
 *
 * They deliberately do NOT share the treatment of an UNDATED marker: cleanup
 * treats it as dead (never hoard collections), status treats it as live (never
 * cry failure). Opposite safe directions, so each keeps its own guard.
 */
export const STALE_INDEXING_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Is the run that wrote this marker presumed dead? Cleanup's reading.
 *
 * `lastHeartbeat` is the live signal; `startedAt` is the fallback for markers
 * written before heartbeats existed. A marker with neither cannot be aged, so
 * it counts as stale — an un-datable in-progress marker would otherwise pin its
 * collection forever.
 */
export function isIndexingRunStale(marker: IndexingMarkerPayload, now: number = Date.now()): boolean {
  const referenceTime = marker.lastHeartbeat ?? marker.startedAt;
  if (referenceTime === undefined) return true;
  return now - new Date(referenceTime).getTime() > STALE_INDEXING_THRESHOLD_MS;
}

/** Parse raw Qdrant payload into typed IndexingMarkerPayload. */
export function parseMarkerPayload(raw: Record<string, unknown>): IndexingMarkerPayload {
  return {
    indexingComplete: raw.indexingComplete === true,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : undefined,
    completedAt: normalizeTimestamp(raw.completedAt),
    lastHeartbeat: typeof raw.lastHeartbeat === "string" ? raw.lastHeartbeat : undefined,
    embeddingModel: typeof raw.embeddingModel === "string" ? raw.embeddingModel : undefined,
    modelInfo: parseModelInfoField(raw.modelInfo),
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
  if (marker.modelInfo !== undefined) result.modelInfo = marker.modelInfo;
  if (marker.enrichment !== undefined) result.enrichment = marker.enrichment;
  return result;
}

function parseModelInfoField(value: unknown): { model: string; contextLength: number; dimensions: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.model !== "string" || typeof obj.contextLength !== "number" || typeof obj.dimensions !== "number") {
    return undefined;
  }
  return { model: obj.model, contextLength: obj.contextLength, dimensions: obj.dimensions };
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  if (value instanceof Date) return value.toISOString();
  return undefined;
}
