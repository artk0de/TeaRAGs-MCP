/**
 * TracePathOps — cross-domain orchestration for the `trace_path` MCP tool.
 *
 * Bridges the codegraph adjacency (DuckDB) and the explore reranker in the
 * one layer (`api/internal`) allowed to cross domain boundaries:
 *
 *   0. Seed resolution — the request names symbols by BARE symbolId, which can
 *      denote several files; resolve each endpoint to its candidate files and
 *      narrow by the optional `fromPath` / `toPath`.
 *   1. Frontier BFS from every from-candidate — bounds graph reads to `maxDepth`
 *      rounds of `getCalleeEdgesScoped`, building a PARTIAL adjacency map
 *      (never the full graph).
 *   2. Pure `enumeratePaths` — finds simple `from`->`to` paths over that map,
 *      once per candidate pair, under a shared `maxPaths` budget.
 *   3. Qdrant hydration — one scroll for the union of step symbols.
 *   4. Annotate-only rerank (`reorder:false`) — when `rerank` is supplied,
 *      attaches a danger overlay per step WITHOUT reordering; `steps` stays
 *      execution-ordered. Skipped when `rerank` is omitted (lean default).
 *   5. Assemble — when `rerank` is supplied, `dangerRanking` indexes the
 *      riskiest steps; `aggregateDanger` is the max per-step danger, and the
 *      path list sorts by it descending. Omitted in lean mode.
 *
 * Node identity throughout is `(relPath, symbolId)`, never the bare symbolId
 * (bd tea-rags-mcp-oxnvl). Top-level declarations — React function components,
 * a `BaseTable` living in three directories — share one bare id, so a
 * bare-keyed walk merged them into a single node: paths crossed silently
 * between unrelated files mid-walk, and hydration ("last chunk wins for this
 * symbolId") stamped a third file's path onto the step.
 */

import type { CollectionGraphHandle, GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import {
  fileScopedSymbolKey,
  parseFileScopedSymbolKey,
  type FileScopedSymbolId,
  type FileScopedSymbolRef,
  type RelPath,
} from "../../../contracts/types/codegraph.js";
import type { RankingOverlay } from "../../../contracts/types/reranker.js";
import type { Reranker } from "../../../domains/explore/reranker.js";
import type { CollectionRegistry } from "../../../domains/maintenance/registry/index.js";
import { enumeratePaths } from "../../../domains/trajectory/codegraph/symbols/index.js";
import type { PathStep, PathTraceResult, TracedPath, TracePathRequest } from "../../public/dto/graph.js";
import { resolveCollection } from "../collection-resolver.js";

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_PATHS = 10;

/**
 * Head-room multiplier on the hydration scroll (bd tea-rags-mcp-oxnvl). The
 * scroll filters by the BARE symbolId union, so one path node can pull back a
 * chunk per NAMESAKE file on top of a chunk per sub-chunk of a long symbol.
 * Passing the node count alone — what the pre-namesake code did — truncates
 * exactly the namesake rows the (relPath, symbolId) pair-match needs, and the
 * step silently loses its line numbers. The scroll returns fewer rows when
 * fewer match, so the ceiling costs nothing on an unambiguous trace.
 */
const HYDRATION_SCROLL_HEADROOM = 8;

export interface TracePathOpsDeps {
  pool: GraphDbClientPool;
  qdrant: QdrantManager;
  reranker: Reranker;
  collectionRegistry: CollectionRegistry;
  resolveActiveCollection?: (collectionName: string) => Promise<string>;
}

const EMPTY: PathTraceResult = { paths: [], truncated: false };

/** One endpoint resolved to the graph nodes its bare symbolId can denote. */
interface EndpointCandidates {
  /** Files kept after the caller's optional exact-path filter. */
  refs: FileScopedSymbolRef[];
  /** Every file the symbol appears in, BEFORE the filter — what `namesakes` reports. */
  allPaths: RelPath[];
}

type HydratedChunk = { id: string | number; payload: Record<string, unknown> };
type StepDanger = { score: number; overlay?: RankingOverlay };

export class TracePathOps {
  constructor(private readonly deps: TracePathOpsDeps) {}

  async tracePath(req: TracePathRequest): Promise<PathTraceResult> {
    const maxDepth = req.maxDepth ?? DEFAULT_MAX_DEPTH;
    const maxPaths = req.maxPaths ?? DEFAULT_MAX_PATHS;
    const preset = req.rerank; // no default — danger overlay is opt-in (tea-rags-mcp-prqsj)

    const { collectionName } = resolveCollection(this.deps.collectionRegistry, req);
    const active = this.deps.resolveActiveCollection
      ? await this.deps.resolveActiveCollection(collectionName).catch(() => collectionName)
      : collectionName;

    let handle: CollectionGraphHandle | undefined;
    try {
      handle = await this.deps.pool.acquireReader(active);
    } catch {
      return EMPTY;
    }

    // 0. Resolve both endpoints to concrete (relPath, symbolId) nodes, then
    //    1. expand the frontier from EVERY from-candidate.
    let from: EndpointCandidates;
    let to: EndpointCandidates;
    let adjacency: Map<FileScopedSymbolId, FileScopedSymbolId[]>;
    try {
      ({ from, to } = await this.resolveEndpoints(handle, req));
      if (from.refs.length === 0 || to.refs.length === 0) {
        // An endpoint the graph does not know, or narrowed away by an exact
        // path that matches no candidate. Report the real candidates so the
        // caller can correct the request rather than guess.
        return this.withNamesakes({ paths: [], truncated: false }, from, to);
      }
      adjacency = await this.buildBoundedAdjacency(handle, from.refs, maxDepth);
    } finally {
      await handle.graphDb.close().catch(() => undefined);
    }

    // 2. Enumerate simple paths over the partial map (pure), once per candidate
    //    pair under one shared budget.
    const { paths, truncated } = this.enumerateAcrossCandidates(adjacency, from.refs, to.refs, maxDepth, maxPaths);
    if (paths.length === 0) return this.withNamesakes({ paths: [], truncated }, from, to);

    // 3. Hydrate every step symbol from Qdrant (one scroll for the whole union).
    const nodes = [...new Set(paths.flat())];
    const symbolIds = [...new Set(nodes.map((key) => parseFileScopedSymbolKey(key).symbolId))];
    const chunks = await this.deps.qdrant.scrollBySymbolIds(
      active,
      symbolIds,
      nodes.length * HYDRATION_SCROLL_HEADROOM,
    );
    // Index hydrated chunks by the SCOPED key, so a namesake in another file
    // can never answer for this node. A symbol spanning multiple chunks within
    // one file keeps the last — a path step is a symbol-level overview, not
    // chunk-precise.
    const byNode = new Map<FileScopedSymbolId, HydratedChunk>();
    for (const chunk of chunks) {
      const key = this.chunkNodeKey(chunk);
      if (key) byNode.set(key, chunk);
    }

    // 4. Annotate-only rerank — ONLY when a rerank preset was requested.
    //    Without it, trace_path is lean path enumeration (no danger overlay,
    //    no danger sort). bugHunt is no longer an implicit default.
    const dangerByNode = preset ? await this.computeDanger(chunks, preset) : undefined;

    // 5. Assemble TracedPath per enumerated path. With danger, sort by
    //    aggregateDanger desc; without, keep enumeration order.
    const traced: TracedPath[] = paths.map((p) => this.assemble(p, byNode, dangerByNode));
    if (dangerByNode) traced.sort((a, b) => (b.aggregateDanger ?? 0) - (a.aggregateDanger ?? 0));
    return this.withNamesakes({ paths: traced, truncated }, from, to);
  }

  /**
   * Resolve the bare `from` / `to` symbolIds to the graph nodes they denote,
   * narrowed by the optional exact `fromPath` / `toPath`. One graph read covers
   * both endpoints.
   */
  private async resolveEndpoints(
    handle: CollectionGraphHandle,
    req: TracePathRequest,
  ): Promise<{ from: EndpointCandidates; to: EndpointCandidates }> {
    const relPaths = await handle.graphDb.getSymbolRelPaths([req.from, req.to]);
    return {
      from: candidatesFor(req.from, relPaths.get(req.from) ?? [], req.fromPath),
      to: candidatesFor(req.to, relPaths.get(req.to) ?? [], req.toPath),
    };
  }

  /**
   * Attach the `namesakes` listing when at least one endpoint was ambiguous.
   * Omitted entirely for an unambiguous trace so the lean response shape is
   * unchanged from before file scoping.
   */
  private withNamesakes(result: PathTraceResult, from: EndpointCandidates, to: EndpointCandidates): PathTraceResult {
    if (from.allPaths.length <= 1 && to.allPaths.length <= 1) return result;
    return { ...result, namesakes: { from: from.allPaths, to: to.allPaths } };
  }

  /**
   * Level-by-level BFS from every from-candidate, calling
   * `getCalleeEdgesScoped(frontier)` at most `maxDepth` times. Builds a PARTIAL
   * adjacency map reachable within `maxDepth` hops — never materialises the full
   * call graph.
   */
  private async buildBoundedAdjacency(
    handle: CollectionGraphHandle,
    seeds: FileScopedSymbolRef[],
    maxDepth: number,
  ): Promise<Map<FileScopedSymbolId, FileScopedSymbolId[]>> {
    const adjacency = new Map<FileScopedSymbolId, FileScopedSymbolId[]>();
    const visited = new Set<FileScopedSymbolId>(seeds.map(fileScopedSymbolKey));
    let frontier: FileScopedSymbolRef[] = [...seeds];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const edges = await handle.graphDb.getCalleeEdgesScoped(frontier);
      const next: FileScopedSymbolRef[] = [];
      for (const src of frontier) {
        const key = fileScopedSymbolKey(src);
        const targets = edges.get(key) ?? [];
        adjacency.set(
          key,
          targets.map((t) => fileScopedSymbolKey(t)),
        );
        for (const target of targets) {
          const targetKey = fileScopedSymbolKey(target);
          if (!visited.has(targetKey)) {
            visited.add(targetKey);
            next.push(target);
          }
        }
      }
      frontier = next;
    }
    return adjacency;
  }

  /**
   * Enumerate over every (from-candidate, to-candidate) pair under ONE shared
   * `maxPaths` budget, so an ambiguous endpoint cannot multiply the cap. The
   * typical trace is 1x1, so the loop costs nothing in the common case.
   */
  private enumerateAcrossCandidates(
    adjacency: ReadonlyMap<FileScopedSymbolId, readonly FileScopedSymbolId[]>,
    fromRefs: FileScopedSymbolRef[],
    toRefs: FileScopedSymbolRef[],
    maxDepth: number,
    maxPaths: number,
  ): { paths: FileScopedSymbolId[][]; truncated: boolean } {
    const paths: FileScopedSymbolId[][] = [];
    let truncated = false;
    let budgetSpent = false;
    for (const fromRef of fromRefs) {
      if (budgetSpent) break;
      for (const toRef of toRefs) {
        const remaining = maxPaths - paths.length;
        if (remaining <= 0) {
          // Pairs left unexplored — the cap, not the graph, ended enumeration.
          truncated = true;
          budgetSpent = true;
          break;
        }
        const result = enumeratePaths(adjacency, fileScopedSymbolKey(fromRef), fileScopedSymbolKey(toRef), {
          maxDepth,
          maxPaths: remaining,
        });
        paths.push(...result.paths);
        if (result.truncated) truncated = true;
      }
    }
    return { paths, truncated };
  }

  /** Annotate-only rerank over hydrated chunks → per-node danger score + overlay. */
  private async computeDanger(chunks: HydratedChunk[], preset: string): Promise<Map<FileScopedSymbolId, StepDanger>> {
    const rerankInput = chunks.map((c) => ({ id: c.id, score: 0, payload: c.payload }));
    const annotated = await this.deps.reranker.rerank(rerankInput, preset, "trace_path", { reorder: false });
    const dangerByNode = new Map<FileScopedSymbolId, StepDanger>();
    for (const r of annotated) {
      // Keyed by (relPath, symbolId): a dangerous namesake in another file must
      // not colour the step actually on the path.
      const key = this.chunkNodeKey(r);
      if (!key) continue;
      dangerByNode.set(key, { score: r.score, overlay: r.rankingOverlay });
    }
    return dangerByNode;
  }

  /** Scoped node key of a hydrated chunk, or undefined when its payload cannot name one. */
  private chunkNodeKey(chunk: { payload?: Record<string, unknown> }): FileScopedSymbolId | undefined {
    const symbolId = chunk.payload?.symbolId as string | undefined;
    const relPath = chunk.payload?.relativePath as string | undefined;
    if (!symbolId || relPath === undefined) return undefined;
    return fileScopedSymbolKey({ relPath, symbolId });
  }

  private assemble(
    path: FileScopedSymbolId[],
    byNode: Map<FileScopedSymbolId, HydratedChunk>,
    dangerByNode?: Map<FileScopedSymbolId, StepDanger>,
  ): TracedPath {
    const steps: PathStep[] = path.map((node) => {
      // relativePath comes from the GRAPH node, never from a hydrated chunk:
      // the chunk is best-effort (it may be missing entirely), the graph edge
      // is what actually determined the walk.
      const ref = parseFileScopedSymbolKey(node);
      const payload = byNode.get(node)?.payload ?? {};
      const step: PathStep = {
        symbolId: ref.symbolId,
        relativePath: ref.relPath,
        startLine: (payload.startLine as number) ?? 0,
        endLine: (payload.endLine as number) ?? 0,
      };
      const overlay = dangerByNode?.get(node)?.overlay;
      if (overlay) step.dangerOverlay = overlay;
      return step;
    });
    if (!dangerByNode) return { steps }; // lean — no dangerRanking / aggregateDanger
    const dangers = path.map((node) => dangerByNode.get(node)?.score ?? 0);
    const dangerRanking = steps.map((_, i) => i).sort((a, b) => dangers[b] - dangers[a]);
    const aggregateDanger = dangers.length > 0 ? Math.max(...dangers) : 0;
    return { steps, dangerRanking, aggregateDanger };
  }
}

/**
 * Narrow one endpoint's candidate files by the caller's optional exact path.
 * `allPaths` keeps the unfiltered set so the response can show what a too-narrow
 * `fromPath` / `toPath` excluded.
 */
function candidatesFor(symbolId: string, allPaths: RelPath[], exactPath?: RelPath): EndpointCandidates {
  const kept = exactPath === undefined ? allPaths : allPaths.filter((p) => p === exactPath);
  return { refs: kept.map((relPath) => ({ relPath, symbolId })), allPaths };
}
