/**
 * TracePathOps — cross-domain orchestration for the `trace_path` MCP tool.
 *
 * Bridges the codegraph adjacency (DuckDB) and the explore reranker in the
 * one layer (`api/internal`) allowed to cross domain boundaries:
 *
 *   1. Frontier BFS from `from` — bounds graph reads to `maxDepth` rounds of
 *      `getCalleeEdges`, building a PARTIAL adjacency map (never the full graph).
 *   2. Pure `enumeratePaths` — finds simple `from`->`to` paths over that map.
 *   3. Qdrant hydration — one scroll for the union of step symbols.
 *   4. Annotate-only rerank (`reorder:false`) — attaches a danger overlay per
 *      step WITHOUT reordering; `steps` stays execution-ordered.
 *   5. Assemble — `dangerRanking` indexes the riskiest steps; `aggregateDanger`
 *      is the max per-step danger (riskiest step defines the path), and the
 *      path list sorts by it descending.
 */

import type { CollectionGraphHandle, GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { SymbolId } from "../../../contracts/types/codegraph.js";
import type { RankingOverlay } from "../../../contracts/types/reranker.js";
import type { Reranker } from "../../../domains/explore/reranker.js";
import { enumeratePaths } from "../../../domains/trajectory/codegraph/symbols/index.js";
import { resolveCollection } from "../../../infra/collection-name.js";
import type { CollectionRegistry } from "../../../infra/registry/index.js";
import type { PathStep, PathTraceResult, TracePathRequest, TracedPath } from "../../public/dto/graph.js";

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_PATHS = 10;
const DEFAULT_PRESET = "bugHunt";

export interface TracePathOpsDeps {
  pool: GraphDbClientPool;
  qdrant: QdrantManager;
  reranker: Reranker;
  collectionRegistry: CollectionRegistry;
  resolveActiveCollection?: (collectionName: string) => Promise<string>;
}

const EMPTY: PathTraceResult = { paths: [], truncated: false };

export class TracePathOps {
  constructor(private readonly deps: TracePathOpsDeps) {}

  async tracePath(req: TracePathRequest): Promise<PathTraceResult> {
    const maxDepth = req.maxDepth ?? DEFAULT_MAX_DEPTH;
    const maxPaths = req.maxPaths ?? DEFAULT_MAX_PATHS;
    const preset = req.rerank ?? DEFAULT_PRESET;

    const { collectionName } = resolveCollection(this.deps.collectionRegistry, req);
    const active = this.deps.resolveActiveCollection
      ? await this.deps.resolveActiveCollection(collectionName).catch(() => collectionName)
      : collectionName;

    // 1. Build a bounded adjacency map by expanding the call frontier from `from`.
    let handle: CollectionGraphHandle | undefined;
    let adjacency: Map<SymbolId, SymbolId[]>;
    try {
      handle = await this.deps.pool.acquireReader(active);
    } catch {
      return EMPTY;
    }
    try {
      adjacency = await this.buildBoundedAdjacency(handle, req.from, maxDepth);
    } finally {
      await handle.graphDb.close().catch(() => undefined);
    }

    // 2. Enumerate simple paths over the partial map (pure).
    const { paths, truncated } = enumeratePaths(adjacency, req.from, req.to, { maxDepth, maxPaths });
    if (paths.length === 0) return { paths: [], truncated };

    // 3. Hydrate every step symbol from Qdrant (one scroll for the whole union).
    const unique = [...new Set(paths.flat())];
    // Hydrate every unique step symbol — pass the exact count as the limit so a
    // wide trace (many paths * depth) can never be silently truncated by the
    // scroll's default cap.
    const chunks = await this.deps.qdrant.scrollBySymbolIds(active, unique, unique.length);
    // Index hydrated chunks by symbolId. A symbol spanning multiple chunks keeps
    // the last one — a path step is a symbol-level overview, not chunk-precise.
    const byId = new Map(chunks.map((c) => [c.payload.symbolId as string, c]));

    // 4. Annotate-only rerank over the hydrated chunks -> danger score + overlay.
    const rerankInput = chunks.map((c) => ({ id: c.id, score: 0, payload: c.payload }));
    const annotated = await this.deps.reranker.rerank(rerankInput, preset, "semantic_search", { reorder: false });
    const dangerById = new Map<string, { score: number; overlay?: RankingOverlay }>();
    for (const r of annotated) {
      const sid = r.payload?.symbolId as string | undefined;
      if (!sid) continue;
      dangerById.set(sid, { score: r.score, overlay: r.rankingOverlay });
    }

    // 5. Assemble TracedPath per enumerated path; sort the list by aggregateDanger desc.
    const traced: TracedPath[] = paths.map((p) => this.assemble(p, byId, dangerById));
    traced.sort((a, b) => b.aggregateDanger - a.aggregateDanger);
    return { paths: traced, truncated };
  }

  /**
   * Level-by-level BFS from `from`, calling `getCalleeEdges(frontier)` at most
   * `maxDepth` times. Builds a PARTIAL adjacency map reachable within `maxDepth`
   * hops — never materialises the full call graph.
   */
  private async buildBoundedAdjacency(
    handle: CollectionGraphHandle,
    from: SymbolId,
    maxDepth: number,
  ): Promise<Map<SymbolId, SymbolId[]>> {
    const adjacency = new Map<SymbolId, SymbolId[]>();
    const visited = new Set<SymbolId>([from]);
    let frontier: SymbolId[] = [from];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const edges = await handle.graphDb.getCalleeEdges(frontier);
      const next: SymbolId[] = [];
      for (const src of frontier) {
        const targets = edges.get(src) ?? [];
        adjacency.set(src, targets);
        for (const t of targets) {
          if (!visited.has(t)) {
            visited.add(t);
            next.push(t);
          }
        }
      }
      frontier = next;
    }
    return adjacency;
  }

  private assemble(
    path: SymbolId[],
    byId: Map<string, { id: string | number; payload: Record<string, unknown> }>,
    dangerById: Map<string, { score: number; overlay?: RankingOverlay }>,
  ): TracedPath {
    const steps: PathStep[] = path.map((symbolId) => {
      const payload = byId.get(symbolId)?.payload ?? {};
      const danger = dangerById.get(symbolId);
      return {
        symbolId,
        relativePath: (payload.relativePath as string) ?? "",
        startLine: (payload.startLine as number) ?? 0,
        endLine: (payload.endLine as number) ?? 0,
        dangerOverlay: danger?.overlay,
      };
    });
    const dangers = path.map((id) => dangerById.get(id)?.score ?? 0);
    const dangerRanking = steps.map((_, i) => i).sort((a, b) => dangers[b] - dangers[a]);
    const aggregateDanger = dangers.length > 0 ? Math.max(...dangers) : 0;
    return { steps, dangerRanking, aggregateDanger };
  }
}
