/**
 * Post-processing module for search results.
 *
 * Extracted from MCP search-pipeline.ts. Contains:
 * - computeFetchLimit: determine Qdrant fetch limit with overfetch
 * - postProcess: apply glob filter + reranking + limit
 * - filterMetaOnly: format results for metaOnly mode
 *
 * NOTE: explore/ cannot import from trajectory/ (layer rule).
 * BASE_PAYLOAD_SIGNALS is injected via payloadSignals parameter.
 */

import type { RankingOverlay } from "../../contracts/types/reranker.js";
import type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";
import type { Reranker, RerankMode } from "./reranker.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  id?: string | number;
  score: number;
  payload?: Record<string, unknown>;
  rankingOverlay?: RankingOverlay;
}

export interface FetchLimits {
  requestedLimit: number;
  fetchLimit: number;
}

export interface PostProcessOptions {
  pathPattern?: string;
  rerank?: RerankMode<string>;
  limit: number;
  reranker: Reranker;
  level?: "file" | "chunk";
  query?: string;
}

// ---------------------------------------------------------------------------
// computeFetchLimit
// ---------------------------------------------------------------------------

/**
 * Compute fetch limit for Qdrant queries, accounting for overfetch
 * needed by reranking (glob is now a pre-filter, no overfetch needed for it).
 */
export function computeFetchLimit(
  requestedLimit: number | undefined,
  _pathPattern?: string,
  rerank?: RerankMode<string>,
): FetchLimits {
  const limit = requestedLimit || 5;
  const needsOverfetch = Boolean(rerank && rerank !== "relevance");
  const multiplier = needsOverfetch ? 4 : 2;
  const fetchLimit = Math.max(20, limit * multiplier);
  return { requestedLimit: limit, fetchLimit };
}

// ---------------------------------------------------------------------------
// postProcess
// ---------------------------------------------------------------------------

/**
 * Apply post-processing pipeline: glob filter → rerank → trim to limit.
 */
export function postProcess(results: SearchResult[], options: PostProcessOptions): SearchResult[] {
  // pathPattern is now resolved as a Qdrant pre-filter BEFORE the query.
  // No client-side glob filtering needed here.
  let filtered: SearchResult[] = results;

  if (options.rerank && options.rerank !== "relevance") {
    filtered = options.reranker.rerank(filtered, options.rerank, "semantic_search", {
      signalLevel: options.level,
      query: options.query,
    });
  }

  return filtered.slice(0, options.limit);
}

// ---------------------------------------------------------------------------
// filterMetaOnly — metaOnly formatting
// ---------------------------------------------------------------------------

/** Check if overlay has any meaningful data. */
function hasOverlayData(overlay: RankingOverlay): boolean {
  return Boolean(
    (overlay.file && Object.keys(overlay.file).length > 0) || (overlay.chunk && Object.keys(overlay.chunk).length > 0),
  );
}

/** Build git object from ranking overlay raw signals. */
function buildGitFromOverlay(overlay: RankingOverlay): Record<string, unknown> {
  const git: Record<string, unknown> = {};
  if (overlay.file && Object.keys(overlay.file).length > 0) git.file = overlay.file;
  if (overlay.chunk && Object.keys(overlay.chunk).length > 0) git.chunk = overlay.chunk;
  return git;
}

/** Filter full git payload to only essential trajectory fields. */
function filterGitByEssential(
  fullGit: Record<string, Record<string, unknown>>,
  essentialKeys: string[],
): Record<string, unknown> {
  const git: Record<string, unknown> = {};
  for (const level of ["file", "chunk"] as const) {
    const levelData = fullGit[level];
    if (!levelData) continue;
    const filtered: Record<string, unknown> = {};
    for (const key of essentialKeys) {
      const parts = key.split(".");
      if (parts.length === 3 && parts[0] === "git" && parts[1] === level) {
        const field = parts[2];
        if (levelData[field] !== undefined) {
          filtered[field] = levelData[field];
        }
      }
    }
    if (Object.keys(filtered).length > 0) git[level] = filtered;
  }
  return git;
}

/**
 * Format results for metaOnly mode: extract metadata + overlay signals,
 * exclude raw content. Returns null if metaOnly is falsy (caller should
 * use full results instead).
 *
 * @param payloadSignals - Base payload signal descriptors (injected, not imported from trajectory)
 * @param essentialTrajectoryFields - Keys like "git.file.ageDays" to include without overlay
 */
export function filterMetaOnly(
  results: SearchResult[],
  payloadSignals: PayloadSignalDescriptor[],
  essentialTrajectoryFields: string[],
): Record<string, unknown>[] {
  return results.map((r) => {
    const meta: Record<string, unknown> = { score: r.score };
    for (const signal of payloadSignals) {
      if (r.payload?.[signal.key] !== undefined) {
        meta[signal.key] = r.payload[signal.key];
      }
    }

    const overlay = r.rankingOverlay;
    const fullGit = r.payload?.git as Record<string, Record<string, unknown>> | undefined;

    // Always include essential trajectory fields from full payload
    let gitResult: Record<string, unknown> = {};
    if (fullGit) {
      gitResult = filterGitByEssential(fullGit, essentialTrajectoryFields);
    }

    if (overlay && hasOverlayData(overlay)) {
      const gitFromOverlay = buildGitFromOverlay(overlay);
      // Overlay signals take precedence over essential fields
      for (const level of ["file", "chunk"] as const) {
        if (gitFromOverlay[level]) {
          gitResult[level] = {
            ...(gitResult[level] as Record<string, unknown> | undefined),
            ...(gitFromOverlay[level] as Record<string, unknown>),
          };
        }
      }
      meta.preset = overlay.preset;
    } else if (overlay?.preset) {
      meta.preset = overlay.preset;
    }

    if (Object.keys(gitResult).length > 0) meta.git = gitResult;

    return meta;
  });
}
