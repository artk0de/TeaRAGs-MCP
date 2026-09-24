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

import { toPhysicalPayloadKey } from "../../contracts/signal-utils.js";
import type { RankingOverlay } from "../../contracts/types/reranker.js";
import type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";
import { compilePathPatternMatcher } from "../../infra/path-pattern.js";
import type { Reranker, RerankMode } from "./reranker.js";
import { keepPathPatternMatches } from "./strategies/path-pattern-fill.js";

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
export async function postProcess(results: SearchResult[], options: PostProcessOptions): Promise<SearchResult[]> {
  // pathPattern reaches Qdrant as a text pre-filter — a directory-token SUPERSET
  // of what the glob names (bd tea-rags-mcp-xf01b) — so it is enforced exactly here.
  const matcher = compilePathPatternMatcher(options.pathPattern);
  let filtered: SearchResult[] = matcher ? keepPathPatternMatches(results, matcher) : results;

  if (options.rerank && options.rerank !== "relevance") {
    filtered = await options.reranker.rerank(filtered, options.rerank, "semantic_search", {
      signalLevel: options.level,
      query: options.query,
    });
  }

  return filtered.slice(0, options.limit);
}

// ---------------------------------------------------------------------------
// filterMetaOnly — metaOnly formatting
// ---------------------------------------------------------------------------
//
// metaOnly contract: the payload is RAW, identical in form to the full payload
// minus the fields metaOnly does not select — every value sits at its owner
// path in its stored form, never as `{value, label}`. Labels live only on the
// hit's `rankingOverlay` (`{preset, file, chunk}`), which the strategies keep
// on metaOnly results. The overlay is never merged into the payload.

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
 * Filter each signal namespace of a result's payload down to its essential
 * signals, leaving every other payload field untouched.
 *
 * Trajectory-agnostic: namespaces come from the essentialKeys list at runtime
 * (keys shaped `<namespace>.<level>.<field>`, e.g. `git.file.commitCount`),
 * each resolved to its PHYSICAL payload path first (`toPhysicalPayloadKey` —
 * `codegraph.file.fanIn` is stored at `codegraph.symbols.file.fanIn`, bd
 * tea-rags-mcp-0x55i). A namespace no essential key names passes through
 * whole. The ranking overlay stays on the result, never in the payload.
 *
 * Use case: outline strategies (find_symbol) need to enforce the metaOnly
 * signal contract without losing synthetic outline fields (chunkCount,
 * mergedChunkIds). filterMetaOnly rebuilds the payload from payloadSignals
 * and would drop those synthetic fields; this helper preserves everything
 * outside the signal namespaces.
 */
export function applyEssentialSignals(result: SearchResult, essentialKeys: string[]): SearchResult {
  const byNamespace = groupEssentialPathsByNamespace(essentialKeys);
  if (byNamespace.size === 0) return result;

  const newPayload: Record<string, unknown> = { ...result.payload };

  for (const [namespace, subPaths] of byNamespace) {
    const filtered: Record<string, unknown> = {};
    for (const subPath of subPaths) {
      const value = readPath(result.payload?.[namespace], subPath);
      if (value !== undefined) writePath(filtered, subPath, value);
    }

    if (Object.keys(filtered).length > 0) {
      newPayload[namespace] = filtered;
    } else if (newPayload[namespace] !== undefined) {
      delete newPayload[namespace];
    }
  }

  return { ...result, payload: newPayload };
}

/**
 * Group essential keys by namespace, as PHYSICAL sub-paths below it. Keys with
 * fewer than 3 logical segments are flat — they live on the payload root and
 * are the caller's concern.
 */
function groupEssentialPathsByNamespace(essentialKeys: string[]): Map<string, string[][]> {
  const byNamespace = new Map<string, string[][]>();
  for (const key of essentialKeys) {
    if (key.split(".").length < 3) continue;
    const [namespace, ...subPath] = toPhysicalPayloadKey(key).split(".");
    const paths = byNamespace.get(namespace);
    if (paths) paths.push(subPath);
    else byNamespace.set(namespace, [subPath]);
  }
  return byNamespace;
}

function readPath(node: unknown, path: string[]): unknown {
  let current = node;
  for (const segment of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Write into a tree this module built itself — no shared subtrees to protect. */
function writePath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let node = target;
  for (const segment of path.slice(0, -1)) {
    const child = node[segment];
    if (typeof child !== "object" || child === null || Array.isArray(child)) node[segment] = {};
    node = node[segment] as Record<string, unknown>;
  }
  node[path[path.length - 1]] = value;
}

/**
 * Format results for metaOnly mode: select metadata, exclude raw content.
 * Returns the payload only — the caller carries id, score and rankingOverlay.
 *
 * Selection: flat payload signals at the root, git reduced to its essential
 * fields, the codegraph branch forwarded whole — all raw.
 *
 * @param payloadSignals - Base payload signal descriptors (injected, not imported from trajectory)
 * @param essentialTrajectoryFields - Keys like "git.file.ageDays" to include in the git block
 */
export function filterMetaOnly(
  results: SearchResult[],
  payloadSignals: PayloadSignalDescriptor[],
  essentialTrajectoryFields: string[],
): Record<string, unknown>[] {
  return results.map((r) => {
    // The score stays on the hit — a payload copy duplicated it (bd tea-rags-mcp-947xf).
    const meta: Record<string, unknown> = {};
    for (const signal of payloadSignals) {
      if (r.payload?.[signal.key] !== undefined) {
        meta[signal.key] = r.payload[signal.key];
      }
    }

    const fullGit = r.payload?.git as Record<string, Record<string, unknown>> | undefined;
    const gitResult = fullGit ? filterGitByEssential(fullGit, essentialTrajectoryFields) : {};
    if (Object.keys(gitResult).length > 0) meta.git = gitResult;

    // Preserve codegraph nested section (tea-rags-mcp-0am0). MCP callers in
    // metaOnly mode need codegraph signals (fanIn/fanOut/instability/...)
    // visible alongside git, otherwise the architectural-hub/blastRadius
    // surfaces show only git-side context. The codegraph payload lives at
    // payload.codegraph.symbols.{file,chunk} with bare inner keys
    // (tea-rags-mcp-k6xu — Qdrant resolves the `codegraph.symbols` providerKey
    // path); we forward the whole nested branch unchanged so consumers see the
    // same shape they would observe without metaOnly.
    const codegraph = r.payload?.codegraph;
    if (codegraph && typeof codegraph === "object") {
      meta.codegraph = codegraph;
    }

    return meta;
  });
}
