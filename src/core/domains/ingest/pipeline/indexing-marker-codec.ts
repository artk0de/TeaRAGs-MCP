/**
 * Codec for indexing marker payload stored in Qdrant.
 * Normalizes historical format variations (completedAt as string/number/Date)
 * into a single canonical format.
 */

import type { LanguageCodeVersions } from "../../../contracts/types/language.js";
import type { EnrichmentMarkerMap } from "./enrichment/types.js";

/**
 * What a first index seeded from a sibling worktree still owes its collection
 * (bd tea-rags-mcp-k8gac). Written right after the clone, removed once the
 * seed's language-version stamp AND its git rebuild are done; a run that finds
 * it resumes both. It lives on the marker because the marker is cloned and
 * dropped WITH the collection — a seeded collection has no registry entry until
 * its first incremental run records one, which is exactly the window a kill
 * must survive.
 */
export interface WorktreeSeedPending {
  /** When the sibling's footprint was cloned (ISO). */
  seededAt: string;
  /**
   * The stamp the seed owes the registry: the SEEDING build's versions. A
   * later process may run another build, and stamping its versions would claim
   * the cloned data as its own.
   */
  languageVersions: Record<string, Partial<LanguageCodeVersions>>;
}

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
  worktreeSeedPending?: WorktreeSeedPending;
}

/**
 * How long a marker may sit at `indexingComplete: false` without advancing
 * before the run that owns it is presumed dead.
 *
 * Shared because two callers must agree on the number: `status-module` decides
 * whether to report `stale_indexing`, and `infra/collection-build-lease` decides
 * whether a half-built versioned collection may be reclaimed — by orphan cleanup
 * and by the next run picking a version. If those drift apart, one of them is
 * wrong about whether a run is alive — and the reclaim side deletes a collection
 * when it guesses wrong.
 *
 * They deliberately do NOT share the treatment of an UNDATED marker: cleanup
 * treats it as dead (never hoard collections), status treats it as live (never
 * cry failure). Opposite safe directions, so each keeps its own guard.
 */
export const STALE_INDEXING_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * How often a live indexing run proves it is alive: the indexing marker's
 * `lastHeartbeat` and the collection indexing lock's `heartbeatAt` both refresh
 * on this cadence. Twenty beats fit in {@link STALE_INDEXING_THRESHOLD_MS}, so a
 * run is presumed dead only after missing many in a row.
 */
export const INDEXING_HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Is the run that wrote this marker presumed dead? Cleanup's reading.
 *
 * `lastHeartbeat` is the live signal; `startedAt` is the fallback for markers
 * written before heartbeats existed. A marker with neither cannot be aged, so
 * it counts as stale — an un-datable in-progress marker would otherwise pin its
 * collection forever.
 */
export function isIndexingRunStale(marker: IndexingMarkerPayload, now: number = Date.now()): boolean {
  const heartbeatAt = indexingRunHeartbeatAt(marker);
  if (heartbeatAt === undefined) return true;
  return now - heartbeatAt > STALE_INDEXING_THRESHOLD_MS;
}

/**
 * Epoch ms of the marker's last sign of life — `lastHeartbeat`, else `startedAt`
 * for markers written before heartbeats existed. Undefined when it has neither.
 */
export function indexingRunHeartbeatAt(marker: IndexingMarkerPayload): number | undefined {
  const referenceTime = marker.lastHeartbeat ?? marker.startedAt;
  return referenceTime === undefined ? undefined : new Date(referenceTime).getTime();
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
    worktreeSeedPending: parseWorktreeSeedPending(raw.worktreeSeedPending),
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
  if (marker.worktreeSeedPending !== undefined) result.worktreeSeedPending = marker.worktreeSeedPending;
  return result;
}

function parseWorktreeSeedPending(value: unknown): WorktreeSeedPending | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.seededAt !== "string") return undefined;
  const versions = obj.languageVersions;
  return {
    seededAt: obj.seededAt,
    languageVersions:
      typeof versions === "object" && versions !== null
        ? (versions as Record<string, Partial<LanguageCodeVersions>>)
        : {},
  };
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
