import type {
  EnrichmentHealthMap,
  EnrichmentLevelHealth,
  EnrichmentLevelMarker,
  EnrichmentMarkerMap,
} from "./types.js";

const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

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

  if (level.status === "in_progress") {
    const isStale =
      level.lastProgressAt !== undefined && Date.now() - Date.parse(level.lastProgressAt) > STALE_THRESHOLD_MS;
    return {
      status: "in_progress",
      message: isStale
        ? "Enrichment appears stalled — no progress in 2 minutes. May need reindex."
        : "Enrichment in progress...",
    };
  }

  if (level.status === "completed") {
    return { status: "healthy" };
  }

  if (level.status === "degraded") {
    return {
      status: "degraded",
      unenrichedChunks: level.unenrichedChunks,
      message: `${level.unenrichedChunks} chunks missing ${levelName}-level signals. Will recover on next reindex.`,
    };
  }

  // failed
  return {
    status: "failed",
    unenrichedChunks: level.unenrichedChunks,
    message: `Git ${levelName} enrichment failed. Will recover on next reindex.`,
  };
}
