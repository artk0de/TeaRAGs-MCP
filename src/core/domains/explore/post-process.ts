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
 * Apply essential-signal filter + ranking overlay to a result's payload.
 *
 * Trajectory-agnostic: namespace, level, and field are derived from the
 * essentialKeys list at runtime (keys shaped `<namespace>.<level>.<field>`,
 * e.g. `git.file.commitCount`). For each namespace discovered in
 * essentialKeys, the corresponding payload branch is filtered to the allowed
 * fields, and any ranking overlay's `{file, chunk}` signals are merged on top.
 *
 * Use case: outline strategies (find_symbol) need to enforce the metaOnly
 * signal contract without losing synthetic outline fields (chunkCount,
 * mergedChunkIds). filterMetaOnly rebuilds the payload from payloadSignals
 * and would drop those synthetic fields; this helper preserves everything
 * outside the signal namespaces.
 *
 * Overlay namespace: the current RankingOverlay shape exposes only
 * `{file, chunk}` levels without namespace, so overlay signals are merged
 * into each namespace present in essentialKeys. In practice only one
 * trajectory contributes overlay at a time (rerank is single-preset), so the
 * merge is unambiguous. When multi-namespace overlay lands, this helper
 * needs a namespace hint — today's shape does not carry one.
 */
export function applyEssentialSignalsToOverlay(result: SearchResult, essentialKeys: string[]): SearchResult {
  const byNamespace = groupEssentialKeysByNamespace(essentialKeys);
  const overlay = result.rankingOverlay;
  const overlayActive = overlay ? hasOverlayData(overlay) : false;

  if (byNamespace.size === 0 && !overlayActive) return result;

  const newPayload: Record<string, unknown> = { ...result.payload };

  for (const [namespace, levelMap] of byNamespace) {
    const nsData = result.payload?.[namespace] as Record<string, Record<string, unknown>> | undefined;
    const filtered: Record<string, Record<string, unknown>> = {};

    for (const [level, fields] of levelMap) {
      const levelData = nsData?.[level];
      const levelFiltered: Record<string, unknown> = {};
      if (levelData) {
        for (const field of fields) {
          if (levelData[field] !== undefined) levelFiltered[field] = levelData[field];
        }
      }
      if (Object.keys(levelFiltered).length > 0) filtered[level] = levelFiltered;
    }

    if (overlay && overlayActive) {
      for (const level of ["file", "chunk"] as const) {
        const overlayLevel = overlay[level];
        if (overlayLevel && Object.keys(overlayLevel).length > 0) {
          filtered[level] = { ...(filtered[level] ?? {}), ...overlayLevel };
        }
      }
    }

    if (Object.keys(filtered).length > 0) {
      newPayload[namespace] = filtered;
    } else if (newPayload[namespace] !== undefined) {
      delete newPayload[namespace];
    }
  }

  if (overlay?.preset) newPayload.preset = overlay.preset;

  return { ...result, payload: newPayload };
}

/** Group `<namespace>.<level>.<field>` keys into namespace → level → fields. Flat keys (1 segment) are ignored — they live directly on the payload root and are preserved by caller. */
function groupEssentialKeysByNamespace(essentialKeys: string[]): Map<string, Map<string, Set<string>>> {
  const byNamespace = new Map<string, Map<string, Set<string>>>();
  for (const key of essentialKeys) {
    const parts = key.split(".");
    if (parts.length < 3) continue;
    const [namespace, level, ...fieldParts] = parts;
    const field = fieldParts.join(".");
    let levelMap = byNamespace.get(namespace);
    if (!levelMap) {
      levelMap = new Map();
      byNamespace.set(namespace, levelMap);
    }
    let fieldSet = levelMap.get(level);
    if (!fieldSet) {
      fieldSet = new Set();
      levelMap.set(level, fieldSet);
    }
    fieldSet.add(field);
  }
  return byNamespace;
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
