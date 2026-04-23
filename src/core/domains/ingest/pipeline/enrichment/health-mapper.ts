import type {
  EnrichmentHealthMap,
  EnrichmentLevelHealth,
  EnrichmentLevelMarker,
  EnrichmentMarkerMap,
} from "./types.js";

const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
const CRASHED_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour — pipeline crashed long ago

export function mapMarkerToHealth(markerMap: EnrichmentMarkerMap): EnrichmentHealthMap | undefined {
  const health: EnrichmentHealthMap = {};
  let hasAny = false;

  for (const [key, marker] of Object.entries(markerMap)) {
    if (!marker?.file && !marker?.chunk) continue;
    hasAny = true;
    health[key] = {
      file: mapLevelHealth(marker.file, "file"),
      chunk: mapLevelHealth(marker.chunk, "chunk"),
    };
  }

  return hasAny ? health : undefined;
}

function mapLevelHealth(level: EnrichmentLevelMarker | undefined, levelName: "file" | "chunk"): EnrichmentLevelHealth {
  if (!level || level.status === "pending") {
    return { status: "healthy" };
  }

  const base: Record<string, unknown> = {};
  if (level.unenrichedChunks) base.unenrichedChunks = level.unenrichedChunks;
  if (level.startedAt) base.startedAt = level.startedAt;
  if (level.completedAt) base.completedAt = level.completedAt;
  if (level.durationMs !== undefined) base.durationMs = level.durationMs;
  if (level.matchedFiles !== undefined) base.matchedFiles = level.matchedFiles;
  if (level.missedFiles !== undefined) base.missedFiles = level.missedFiles;

  if (level.status === "in_progress") {
    const crashedLongAgo =
      level.startedAt !== undefined &&
      level.completedAt === undefined &&
      Date.now() - Date.parse(level.startedAt) > CRASHED_THRESHOLD_MS;

    if (crashedLongAgo) {
      return {
        ...base,
        status: "failed",
        message:
          "Enrichment appears to have crashed (in_progress for over 1 hour with no completion). Status recovered on read. Will retry on next reindex.",
      };
    }

    const isStale =
      level.lastProgressAt !== undefined && Date.now() - Date.parse(level.lastProgressAt) > STALE_THRESHOLD_MS;
    return {
      ...base,
      status: "in_progress",
      message: isStale
        ? "Enrichment appears stalled — no progress in 2 minutes. May need reindex."
        : "Enrichment in progress...",
    };
  }

  if (level.status === "completed") {
    return { ...base, status: "healthy" };
  }

  if (level.status === "degraded") {
    return {
      ...base,
      status: "degraded",
      message: `${level.unenrichedChunks} chunks missing ${levelName}-level signals. Will recover on next reindex.`,
    };
  }

  // failed
  return {
    ...base,
    status: "failed",
    message:
      levelName === "file"
        ? "Git file enrichment failed. All file-level signals missing. Will recover on next reindex."
        : "Chunk enrichment failed. Will recover on next reindex.",
  };
}
