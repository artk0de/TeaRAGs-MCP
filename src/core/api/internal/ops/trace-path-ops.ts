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
  type SymbolId,
} from "../../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type { RankingOverlay } from "../../../contracts/types/reranker.js";
import {
  claimWorkingTreeFloors,
  historyClockRerankOption,
  mergedWorkingTreeSymbolRow,
  recordTreeGraphState,
  relativePathOf,
  type WorkingTreeOverlay,
  type WorkingTreeView,
} from "../../../domains/explore/index.js";
import type { Reranker } from "../../../domains/explore/reranker.js";
import type { CollectionRegistry } from "../../../domains/maintenance/registry/index.js";
import { resolveInheritedMemberDefiner } from "../../../domains/trajectory/codegraph/inherited-member-definer.js";
import { enumeratePaths } from "../../../domains/trajectory/codegraph/symbols/index.js";
import { resolvePhysicalCollection } from "../../../infra/collection-name.js";
import type { DeclaredVisibilityIndex } from "../../../infra/declared-visibility-index.js";
import type { PathStep, PathTraceResult, TracedPath, TracePathRequest } from "../../public/dto/graph.js";
import { resolveIndexedWorkingTree, type IndexExistenceCheck } from "../collection-resolver.js";
import type { IndexHistoryAnchorResolver } from "../infra/index-history-anchor.js";
import { selectWorkingTreeGraphHandle } from "../infra/working-tree-graph-read.js";
import { lookupDeclaredVisibility } from "./declared-visibility-lookup.js";

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
  resolveActiveCollection?: (collectionName: string) => Promise<PhysicalCollectionName>;
  /** The `workingTree` marker source (bd tea-rags-mcp-xi2r9). Optional: absent (unit wiring), no marker. */
  workingTreeOverlay?: Pick<WorkingTreeOverlay, "view">;
  /**
   * Whether the resolved index exists — a read of one that does not is refused
   * with the typed not-found error (live round-3 D3, `resolveIndexedWorkingTree`).
   * Absent (unit wiring): not checked.
   */
  indexExists?: IndexExistenceCheck;
  /**
   * The query clock of an index (bd tea-rags-mcp-zwu7m): the danger rerank of a
   * head-anchored index derives age / recency from its indexed commit's time.
   * Absent (unit wiring) → the wall clock.
   */
  historyAnchor?: Pick<IndexHistoryAnchorResolver, "anchorSecOf">;
}

const EMPTY: PathTraceResult = { paths: [], truncated: false };

/** One endpoint resolved to the graph nodes its bare symbolId can denote. */
interface EndpointCandidates {
  /** Files kept after the caller's optional exact-path filter. */
  refs: FileScopedSymbolRef[];
  /** Every file the symbol appears in, BEFORE the filter — what `namesakes` reports. */
  allPaths: RelPath[];
  /** The definer id traced instead, when the requested id was a host-class alias (bd tea-rags-mcp-u0t4p). */
  resolvedSymbolId?: SymbolId;
}

type HydratedChunk = { id: string | number; payload: Record<string, unknown> };
type StepLineRange = { startLine: number; endLine: number };
type StepDanger = { score: number; overlay?: RankingOverlay };

export class TracePathOps {
  constructor(private readonly deps: TracePathOpsDeps) {}

  /**
   * The trace, carrying the `workingTree` marker on every return path (bd
   * tea-rags-mcp-xi2r9). A tree with a non-empty delta is walked over its own
   * graph when that is built (WTO-7, marker `floors: ["codegraph"]`), over the
   * index's otherwise with `treeGraphUnavailable` saying why. A step in a file
   * the tree touched is hydrated from the tree, never from the index's payload
   * (live D2, `hydrateForWorkingTree`).
   */
  async tracePath(req: TracePathRequest): Promise<PathTraceResult> {
    const workingTree = await resolveIndexedWorkingTree(this.deps.collectionRegistry, req, this.deps.indexExists);
    const view = await this.deps.workingTreeOverlay?.view(workingTree, req.project);
    const selection = await selectWorkingTreeGraphHandle(view?.readTreeGraph, this.deps.pool);
    const result = await this.traceInCollection(
      req,
      workingTree.baseIndex.collectionName,
      selection.kind === "tree" ? selection.handle : undefined,
      view,
    );
    if (!view) return result;
    if (selection.state) recordTreeGraphState(view.marker, selection.state);
    return { ...result, workingTree: view.marker };
  }

  /** `treeHandle`, when given, is the graph walked instead of the index's; it is closed here like any other. */
  private async traceInCollection(
    req: TracePathRequest,
    collectionName: string,
    treeHandle?: CollectionGraphHandle,
    view?: WorkingTreeView,
  ): Promise<PathTraceResult> {
    const maxDepth = req.maxDepth ?? DEFAULT_MAX_DEPTH;
    const maxPaths = req.maxPaths ?? DEFAULT_MAX_PATHS;
    const preset = req.rerank; // no default — danger overlay is opt-in (tea-rags-mcp-prqsj)

    // No resolver, or a failed one: the addressed name, resolved against no aliases.
    const activePhysicalCollectionName = this.deps.resolveActiveCollection
      ? await this.deps
          .resolveActiveCollection(collectionName)
          .catch(() => resolvePhysicalCollection(collectionName, []))
      : resolvePhysicalCollection(collectionName, []);

    let handle: CollectionGraphHandle | undefined = treeHandle;
    try {
      handle ??= await this.deps.pool.acquireReader(activePhysicalCollectionName);
    } catch (err) {
      // GraphFacade#withReadHandle's contract (bd tea-rags-mcp-kn2cb): "no
      // path" asserts something about the code, so it is only answered when
      // there is no graph database at all. A graph that exists but cannot be
      // read (lock held, unreadable or corrupt file, daemon down) is a failure
      // the caller must see — not an empty result it would act on.
      if (this.deps.pool.hasDatabase(activePhysicalCollectionName)) throw err;
      return EMPTY;
    }

    // 0. Resolve both endpoints to concrete (relPath, symbolId) nodes, then
    //    1. expand the frontier from EVERY from-candidate.
    let from: EndpointCandidates;
    let to: EndpointCandidates;
    let paths: FileScopedSymbolId[][];
    let truncated: boolean;
    let visibility: DeclaredVisibilityIndex;
    let graphRanges: Map<FileScopedSymbolId, StepLineRange>;
    try {
      ({ from, to } = await this.resolveEndpoints(handle, req));
      if (from.refs.length === 0 || to.refs.length === 0) {
        // An endpoint the graph does not know, or narrowed away by an exact
        // path that matches no candidate. Report the real candidates so the
        // caller can correct the request rather than guess.
        return this.withEndpointFacts({ paths: [], truncated: false }, from, to);
      }
      const adjacency = await this.buildBoundedAdjacency(handle, from.refs, maxDepth);
      // 2. Enumerate simple paths over the partial map (pure), once per
      //    candidate pair under one shared budget.
      ({ paths, truncated } = this.enumerateAcrossCandidates(adjacency, from.refs, to.refs, maxDepth, maxPaths));
      // Declared visibility of the path nodes (bd tea-rags-mcp-sqqkz) — one
      // batched read, while the handle is still open; an empty index on failure.
      visibility = await lookupDeclaredVisibility(
        handle.graphDb,
        paths.flat().map((key) => parseFileScopedSymbolKey(key).symbolId),
      );
      graphRanges = await this.readNodeLineRanges(handle, paths.flat());
    } finally {
      await handle.graphDb.close().catch(() => undefined);
    }

    if (paths.length === 0) return this.withEndpointFacts({ paths: [], truncated }, from, to);

    // 3. Hydrate every step symbol from Qdrant (one scroll for the whole union).
    const nodes = [...new Set(paths.flat())];
    const symbolIds = [...new Set(nodes.map((key) => parseFileScopedSymbolKey(key).symbolId))];
    const chunks = await this.hydrateForWorkingTree(
      await this.deps.qdrant.scrollBySymbolIds(
        activePhysicalCollectionName,
        symbolIds,
        nodes.length * HYDRATION_SCROLL_HEADROOM,
      ),
      nodes,
      view,
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
    const dangerByNode = preset ? await this.computeDanger(chunks, preset, collectionName) : undefined;

    // 5. Assemble TracedPath per enumerated path. With danger, sort by
    //    aggregateDanger desc; without, keep enumeration order.
    const traced: TracedPath[] = paths.map((p) => this.assemble(p, byNode, graphRanges, visibility, dangerByNode));
    if (dangerByNode) traced.sort((a, b) => (b.aggregateDanger ?? 0) - (a.aggregateDanger ?? 0));
    return this.withEndpointFacts({ paths: traced, truncated }, from, to);
  }

  /**
   * The hydration rows for a working tree (live D2): the index's chunks of the
   * files the tree did not touch, plus — per path node in a file the tree
   * CHANGED — the tree's row of that symbol (`#partN` windows merged, as
   * find_symbol merges them), which also carries the payload its danger is
   * ranked on. A node in a deleted file, or in a changed file the tree's rows
   * do not hold, gets no row: its step falls to the graph's range and carries
   * no overlay. The index's payload of a touched file describes another commit
   * and never reaches a step.
   */
  private async hydrateForWorkingTree(
    chunks: HydratedChunk[],
    nodes: readonly FileScopedSymbolId[],
    view: WorkingTreeView | undefined,
  ): Promise<HydratedChunk[]> {
    if (!view || view.touchedPaths.size === 0) return chunks;
    const untouched = chunks.filter((chunk) => !view.touchedPaths.has(relativePathOf(chunk.payload)));
    const treeNodes = nodes
      .map(parseFileScopedSymbolKey)
      .filter(({ relPath }) => view.touchedPaths.has(relPath) && !view.deletedPaths.has(relPath));
    if (treeNodes.length === 0 || !view.readDeltaChunks) return untouched;
    const deltaRows = await view.readDeltaChunks();
    const merged = treeNodes.flatMap(({ relPath, symbolId }) => {
      const row = mergedWorkingTreeSymbolRow(deltaRows, relPath, symbolId);
      return row ? [row] : [];
    });
    // Only the steps' rows carry the payload their danger is ranked on (live C1).
    const treeRows = view.signalDeltaRows ? await view.signalDeltaRows(merged) : merged;
    claimWorkingTreeFloors(view, ["chunks"], treeRows.length);
    return [...untouched, ...treeRows];
  }

  /**
   * Resolve the bare `from` / `to` symbolIds to the graph nodes they denote,
   * narrowed by the optional exact `fromPath` / `toPath`. One graph read covers
   * both endpoints; an endpoint the graph has no node for is then aliased onto
   * the member's definer (bd tea-rags-mcp-u0t4p) — the 63l69 policy
   * `get_callers` / `get_callees` answer a host-class id with.
   */
  private async resolveEndpoints(
    handle: CollectionGraphHandle,
    req: TracePathRequest,
  ): Promise<{ from: EndpointCandidates; to: EndpointCandidates }> {
    const relPaths = await handle.graphDb.getSymbolRelPaths([req.from, req.to]);
    const [from, to] = await Promise.all([
      this.resolveEndpoint(handle, req.from, relPaths.get(req.from) ?? [], req.fromPath),
      this.resolveEndpoint(handle, req.to, relPaths.get(req.to) ?? [], req.toPath),
    ]);
    return { from, to };
  }

  /**
   * One endpoint's candidates. A symbolId with graph nodes is answered as-is;
   * one with none falls back to `resolveInheritedMemberDefiner`, whose failure
   * leaves the endpoint unresolved — the pre-aliasing behaviour. The exact
   * path, when given, filters the DEFINER's files after an alias.
   */
  private async resolveEndpoint(
    handle: CollectionGraphHandle,
    symbolId: SymbolId,
    paths: RelPath[],
    exactPath: RelPath | undefined,
  ): Promise<EndpointCandidates> {
    if (paths.length > 0) return candidatesFor(symbolId, paths, exactPath);
    const definer = await resolveInheritedMemberDefiner(handle.graphDb, symbolId).catch(() => null);
    if (definer === null) return candidatesFor(symbolId, paths, exactPath);
    const definerPaths = (await handle.graphDb.getSymbolRelPaths([definer])).get(definer) ?? [];
    return { ...candidatesFor(definer, definerPaths, exactPath), resolvedSymbolId: definer };
  }

  /**
   * Attach the `namesakes` listing when at least one endpoint was ambiguous,
   * and `resolvedEndpoints` when at least one was aliased onto its definer.
   * Each is omitted entirely otherwise, so the lean response shape is unchanged
   * from before file scoping and endpoint aliasing.
   */
  private withEndpointFacts(
    result: PathTraceResult,
    from: EndpointCandidates,
    to: EndpointCandidates,
  ): PathTraceResult {
    let out = result;
    if (from.allPaths.length > 1 || to.allPaths.length > 1) {
      out = { ...out, namesakes: { from: from.allPaths, to: to.allPaths } };
    }
    if (from.resolvedSymbolId !== undefined || to.resolvedSymbolId !== undefined) {
      out = {
        ...out,
        resolvedEndpoints: {
          ...(from.resolvedSymbolId === undefined ? {} : { from: from.resolvedSymbolId }),
          ...(to.resolvedSymbolId === undefined ? {} : { to: to.resolvedSymbolId }),
        },
      };
    }
    return out;
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

  /**
   * The codegraph line range of every path node — the fallback for a step whose
   * symbol has no chunk of its own (bd tea-rags-mcp-kz89o): a short method
   * folded into its class-body chunk hydrates nothing and reported 0 / 0 while
   * the graph knew where it lives. One batched read over the nodes' files; an
   * empty map on failure, so a trace never fails on a line range.
   */
  private async readNodeLineRanges(
    handle: CollectionGraphHandle,
    nodes: FileScopedSymbolId[],
  ): Promise<Map<FileScopedSymbolId, StepLineRange>> {
    const wanted = new Set(nodes);
    const relPaths = [...new Set(nodes.map((key) => parseFileScopedSymbolKey(key).relPath))];
    const out = new Map<FileScopedSymbolId, StepLineRange>();
    try {
      for (const [relPath, file] of await handle.graphDb.getSymbolLineRangesBulk(relPaths)) {
        for (const { symbolId, startLine, endLine } of file.ranges) {
          const key = fileScopedSymbolKey({ relPath, symbolId });
          if (wanted.has(key)) out.set(key, { startLine, endLine });
        }
      }
    } catch {
      return new Map();
    }
    return out;
  }

  /**
   * Annotate-only rerank over hydrated chunks → per-node danger score + overlay,
   * under the index's history clock (bd tea-rags-mcp-zwu7m), read once here —
   * the only age read of a trace.
   */
  private async computeDanger(
    chunks: HydratedChunk[],
    preset: string,
    collectionName: string,
  ): Promise<Map<FileScopedSymbolId, StepDanger>> {
    const rerankInput = chunks.map((c) => ({ id: c.id, score: 0, payload: c.payload }));
    const historyAnchorSec = await this.deps.historyAnchor?.anchorSecOf(collectionName);
    const annotated = await this.deps.reranker.rerank(rerankInput, preset, "trace_path", {
      reorder: false,
      ...historyClockRerankOption({ historyAnchorSec }),
    });
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
    graphRanges: Map<FileScopedSymbolId, StepLineRange>,
    visibility: DeclaredVisibilityIndex,
    dangerByNode?: Map<FileScopedSymbolId, StepDanger>,
  ): TracedPath {
    const steps: PathStep[] = path.map((node) => {
      // relativePath comes from the GRAPH node, never from a hydrated chunk:
      // the chunk is best-effort (it may be missing entirely), the graph edge
      // is what actually determined the walk.
      const ref = parseFileScopedSymbolKey(node);
      // Lines: the hydrated chunk's, else the graph node's range (a symbol
      // with no chunk of its own), else 0 / 0.
      const payload = byNode.get(node)?.payload ?? {};
      const graphRange = graphRanges.get(node);
      const step: PathStep = {
        symbolId: ref.symbolId,
        relativePath: ref.relPath,
        startLine: (payload.startLine as number | undefined) ?? graphRange?.startLine ?? 0,
        endLine: (payload.endLine as number | undefined) ?? graphRange?.endLine ?? 0,
      };
      // Omitted, never null, when the graph states no level (bd tea-rags-mcp-sqqkz).
      const level = visibility.at(ref.relPath, ref.symbolId);
      if (level !== undefined) step.visibility = level;
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
