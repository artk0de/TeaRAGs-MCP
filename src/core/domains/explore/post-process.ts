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
import { buildSignalKeyMap, type Reranker, type RerankMode } from "./reranker.js";
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

/** Check if overlay has any meaningful data. */
function hasOverlayData(overlay: RankingOverlay): boolean {
  return Boolean(
    (overlay.file && Object.keys(overlay.file).length > 0) || (overlay.chunk && Object.keys(overlay.chunk).length > 0),
  );
}

/**
 * Merge each ranking-overlay value into the payload namespace of the signal
 * descriptor that OWNS it (bd tea-rags-mcp-rtjrn). A preset's overlayMask mixes
 * trajectories — techDebt lists git signals, the static `imports` and
 * `codegraph.file.fanIn` — while the overlay itself is keyed by bare field name
 * per level, so the owner is recovered the way `Reranker#applyLabelResolution`
 * recovers it: `<level>.<field>` first, then the bare field, through
 * `buildSignalKeyMap`.
 *
 *   - a nested owner (`git.file.commitCount`, `codegraph.file.fanIn`) receives
 *     the labelled value at its PHYSICAL path (`toPhysicalPayloadKey` —
 *     `codegraph.symbols.file.fanIn`);
 *   - a flat owner (`imports`, `methodLines`) is a top-level static key the
 *     caller already carries raw — writing it anywhere would duplicate it;
 *   - a field no descriptor owns has no namespace to go to and is dropped.
 *
 * Copy-on-write along each written path: `target` may share subtrees with the
 * hit's own payload, which must not change.
 */
function mergeOverlayIntoOwners(
  target: Record<string, unknown>,
  overlay: RankingOverlay,
  signalKeyMap: ReadonlyMap<string, string>,
): void {
  for (const level of ["file", "chunk"] as const) {
    const entries = overlay[level];
    if (!entries) continue;
    for (const [field, value] of Object.entries(entries)) {
      const ownerKey = signalKeyMap.get(`${level}.${field}`) ?? signalKeyMap.get(field);
      if (!ownerKey?.includes(".")) continue;
      setAtPathCopyOnWrite(target, toPhysicalPayloadKey(ownerKey).split("."), value);
    }
  }
}

function setAtPathCopyOnWrite(target: Record<string, unknown>, path: string[], value: unknown): void {
  let node = target;
  for (const segment of path.slice(0, -1)) {
    const child = node[segment];
    const copy: Record<string, unknown> =
      typeof child === "object" && child !== null && !Array.isArray(child)
        ? { ...(child as Record<string, unknown>) }
        : {};
    node[segment] = copy;
    node = copy;
  }
  node[path[path.length - 1]] = value;
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
 * fields; the ranking overlay's `{file, chunk}` signals are then merged into
 * the namespace that owns each one (`mergeOverlayIntoOwners`).
 *
 * Use case: outline strategies (find_symbol) need to enforce the metaOnly
 * signal contract without losing synthetic outline fields (chunkCount,
 * mergedChunkIds). filterMetaOnly rebuilds the payload from payloadSignals
 * and would drop those synthetic fields; this helper preserves everything
 * outside the signal namespaces.
 *
 * Overlay namespace: the RankingOverlay shape carries `{file, chunk}` levels
 * without a namespace, and one preset's mask spans several trajectories, so
 * the owner of each overlay key comes from `payloadSignals` — never from which
 * namespaces essentialKeys happens to name (bd tea-rags-mcp-rtjrn).
 */
export function applyEssentialSignalsToOverlay(
  result: SearchResult,
  essentialKeys: string[],
  payloadSignals: PayloadSignalDescriptor[],
): SearchResult {
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

    if (Object.keys(filtered).length > 0) {
      newPayload[namespace] = filtered;
    } else if (newPayload[namespace] !== undefined) {
      delete newPayload[namespace];
    }
  }

  if (overlay && overlayActive) mergeOverlayIntoOwners(newPayload, overlay, buildSignalKeyMap(payloadSignals));
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
  const signalKeyMap = buildSignalKeyMap(payloadSignals);
  return results.map((r) => {
    // The score stays on the hit — a payload copy duplicated it (bd tea-rags-mcp-947xf).
    const meta: Record<string, unknown> = {};
    for (const signal of payloadSignals) {
      if (r.payload?.[signal.key] !== undefined) {
        meta[signal.key] = r.payload[signal.key];
      }
    }

    const overlay = r.rankingOverlay;
    const fullGit = r.payload?.git as Record<string, Record<string, unknown>> | undefined;

    // Always include essential trajectory fields from full payload
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

    // Overlay values take precedence over essential/raw fields, each inside the
    // namespace that owns it — a static or codegraph key never lands in `git`
    // (bd tea-rags-mcp-rtjrn).
    if (overlay && hasOverlayData(overlay)) mergeOverlayIntoOwners(meta, overlay, signalKeyMap);
    if (overlay?.preset) meta.preset = overlay.preset;

    return meta;
  });
}
