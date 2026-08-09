/**
 * DuckDB implementation of the codegraph `GraphDbClient` contract.
 *
 * Slice 1 uses an embedded, file-backed DuckDB instance per collection,
 * routed by `GraphDbClientPool` to `<dataDir>/codegraph/<collection>.duckdb`.
 * Slice 4 adds
 * `PostgresGraphClient` behind the same interface — this client owns
 * driver-specific concerns (prepared-statement reuse, BEGIN/COMMIT, value
 * binding) and the contract owns the SQL-agnostic shape.
 *
 * This file is the FACADE only. The contract's 39 methods are answered by seven
 * role collaborators over one shared {@link DuckDbGraphSession}, each owning the
 * tables its role is about:
 *
 * | Collaborator                 | Owns                                            |
 * | ---------------------------- | ----------------------------------------------- |
 * | `DuckDbGraphSession`         | connection, write queue, transactions, batching |
 * | `DuckDbFileGraphStore`       | `cg_symbols_files` + everything keyed by file   |
 * | `DuckDbFileMetricsReader`    | fanIn / fanOut / p95 / transitive impact        |
 * | `DuckDbSymbolStore`          | `cg_symbols` persistence + chunk resolution     |
 * | `DuckDbMethodEdgeReader`     | callers, callees, fan-out, chunk signals        |
 * | `DuckDbHierarchyReader`      | `cg_symbols_inheritance` reads                  |
 * | `DuckDbGraphAnalyticsStore`  | adjacency out, cycles + PageRank back in        |
 * | `DuckDbRunStatsStore`        | `cg_run_stats` + edge-kind distribution         |
 *
 * Concurrency: methods run sequentially on a single shared connection owned by
 * the session; a transactional write holds the queue for its whole BEGIN/COMMIT
 * body. The `MigrationCapableClient` adapter surface (`exec` / `run` /
 * `queryAll`) is also exposed for the migration runner.
 */

import type {
  AmbiguousCallerSite,
  BulkFileUpsertEntry,
  BulkSymbolUpsertEntry,
  CalleeEdge,
  CallerEdge,
  ChunkGraphSignals,
  CycleEntry,
  CycleScope,
  EdgeKindCount,
  GraphDbClient,
  GraphEdges,
  GraphFileNode,
  HierarchySnapshot,
  InheritanceEdge,
  RelPath,
  ResolveRunStatsRow,
  SymbolChunkLocation,
  SymbolDefinition,
  SymbolId,
} from "../../contracts/types/codegraph.js";
import { DuckDbFileGraphStore } from "./file-graph-store.js";
import { DuckDbFileMetricsReader } from "./file-metrics-reader.js";
import { DuckDbGraphAnalyticsStore } from "./graph-analytics-store.js";
import { DuckDbGraphSession, type DuckDbGraphSessionOptions } from "./graph-session.js";
import { DuckDbHierarchyReader } from "./hierarchy-reader.js";
import { DuckDbMethodEdgeReader } from "./method-edge-reader.js";
import { DuckDbRunStatsStore } from "./run-stats-store.js";
import { DuckDbSymbolStore } from "./symbol-store.js";

// Graph algorithms (Tarjan SCC, PageRank) intentionally NOT imported
// here. Per the layering rules in .claude/rules/domain-boundaries.md
// adapters/ may not import from domains/. Cycle/PageRank computation
// lives in domains/trajectory/codegraph/infra/ and the adapter only
// exposes the primitives (listAdjacency, replaceCycles, replacePageRanks)
// the domain orchestrator drives.

export { splitMethodSymbol } from "./symbol-id-text.js";

/**
 * Construction options for {@link DuckDbGraphClient}. Everything they configure
 * — the DB file, its access mode, the resource ceiling — belongs to the
 * connection, so the shape is defined and consumed by the session.
 */
export type DuckDbGraphClientOptions = DuckDbGraphSessionOptions;

export class DuckDbGraphClient implements GraphDbClient {
  private readonly session: DuckDbGraphSession;
  private readonly fileGraph: DuckDbFileGraphStore;
  private readonly fileMetrics: DuckDbFileMetricsReader;
  private readonly symbols: DuckDbSymbolStore;
  private readonly methodEdges: DuckDbMethodEdgeReader;
  private readonly hierarchy: DuckDbHierarchyReader;
  private readonly analytics: DuckDbGraphAnalyticsStore;
  private readonly runStats: DuckDbRunStatsStore;

  constructor(options: DuckDbGraphClientOptions) {
    this.session = new DuckDbGraphSession(options);
    this.fileGraph = new DuckDbFileGraphStore(this.session);
    this.fileMetrics = new DuckDbFileMetricsReader(this.session);
    this.symbols = new DuckDbSymbolStore(this.session);
    this.methodEdges = new DuckDbMethodEdgeReader(this.session);
    this.hierarchy = new DuckDbHierarchyReader(this.session);
    this.analytics = new DuckDbGraphAnalyticsStore(this.session);
    this.runStats = new DuckDbRunStatsStore(this.session);
  }

  // ── Lifecycle + durability ──

  async init(): Promise<void> {
    return this.session.open();
  }

  async close(): Promise<void> {
    return this.session.close();
  }

  async checkpoint(): Promise<void> {
    return this.session.checkpoint();
  }

  async hasData(): Promise<boolean> {
    return this.fileGraph.hasData();
  }

  // ── Migration-runner surface (MigrationCapableClient) ──

  /** Generic exec — used by the migration runner. Returns no rows. */
  async exec(sql: string): Promise<void> {
    return this.session.exec(sql);
  }

  /** Generic prepared exec with positional params. */
  async run(sql: string, params: unknown[] = []): Promise<void> {
    return this.session.run(sql, params);
  }

  /** Generic query returning all rows as plain JSON objects. */
  async queryAll<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.session.queryAll<T>(sql, params);
  }

  // ── File-graph writes ──
  //
  // `upsertFile` and `upsertFilesBulk` write the SAME rows and differ only in
  // transaction granularity — one BEGIN/COMMIT per file versus one per batch.
  // The facade therefore keeps the two envelopes and dispatches both through a
  // single `upsertFileRows` seam; the row body itself lives in the store.

  async upsertFile(node: GraphFileNode, edges: GraphEdges): Promise<void> {
    return this.session.transaction(async () => this.upsertFileRows(node, edges));
  }

  /**
   * Bulk variant of `upsertFile` (mirrors `upsertSymbolsBulk`): fold M files'
   * node + edge writes into ONE `BEGIN/COMMIT` instead of M per-file
   * transactions — and, on the daemon path, ONE IPC round-trip instead of M.
   * Each file keeps its own per-`source_rel_path` DELETE+INSERT (last-wins) via
   * the shared `upsertFileRows` body, so the persisted edge / inheritance /
   * ambiguous-fanout set is byte-identical to calling `upsertFile` per file —
   * only the transaction + round-trip count drops. Any row failure rolls the
   * whole batch back (callers cap batch size + skip pathological files upstream).
   */
  async upsertFilesBulk(entries: readonly BulkFileUpsertEntry[]): Promise<void> {
    if (entries.length === 0) return;
    return this.session.transaction(async () => {
      for (const { node, edges } of entries) await this.upsertFileRows(node, edges);
    });
  }

  /** The per-file DELETE+INSERT body both envelopes above share, unwrapped. */
  private async upsertFileRows(node: GraphFileNode, edges: GraphEdges): Promise<void> {
    return this.fileGraph.writeFileRows(node, edges);
  }

  async removeFile(relPath: RelPath): Promise<void> {
    return this.fileGraph.removeFile(relPath);
  }

  async listFileContentHashes(): Promise<{ relPath: RelPath; contentHash: string | null }[]> {
    return this.fileGraph.listFileContentHashes();
  }

  // ── File metric reads ──

  async getFanIn(relPath: RelPath): Promise<number> {
    return this.fileMetrics.getFanIn(relPath);
  }

  async getFanOut(relPath: RelPath): Promise<number> {
    return this.fileMetrics.getFanOut(relPath);
  }

  async getFanInP95(): Promise<number> {
    return this.fileMetrics.getFanInP95();
  }

  async getTransitiveImpact(relPath: RelPath, maxDepth = 5): Promise<number> {
    return this.fileMetrics.getTransitiveImpact(relPath, maxDepth);
  }

  // ── Symbol persistence ──

  async upsertSymbols(relPath: RelPath, definitions: SymbolDefinition[]): Promise<void> {
    return this.symbols.upsertSymbols(relPath, definitions);
  }

  async upsertSymbolsBulk(entries: BulkSymbolUpsertEntry[]): Promise<void> {
    return this.symbols.upsertSymbolsBulk(entries);
  }

  async removeSymbolsForFile(relPath: RelPath): Promise<void> {
    return this.symbols.removeSymbolsForFile(relPath);
  }

  async listAllSymbols(): Promise<SymbolDefinition[]> {
    return this.symbols.listAllSymbols();
  }

  async updateSymbolChunkIds(relPath: RelPath, chunkIds: ReadonlyMap<SymbolId, string>): Promise<void> {
    return this.symbols.updateSymbolChunkIds(relPath, chunkIds);
  }

  async findSymbolChunk(symbolId: SymbolId): Promise<SymbolChunkLocation | null> {
    return this.symbols.findSymbolChunk(symbolId);
  }

  // ── Method-edge / chunk-signal reads ──

  async getCallers(symbolId: SymbolId): Promise<CallerEdge[]> {
    return this.methodEdges.getCallers(symbolId);
  }

  async getCallees(symbolId: SymbolId): Promise<CalleeEdge[]> {
    return this.methodEdges.getCallees(symbolId);
  }

  async getCalleeEdges(symbolIds: SymbolId[]): Promise<Map<SymbolId, SymbolId[]>> {
    return this.methodEdges.getCalleeEdges(symbolIds);
  }

  async getAmbiguousCallersByMember(member: string, limit = 50): Promise<AmbiguousCallerSite[]> {
    return this.methodEdges.getAmbiguousCallersByMember(member, limit);
  }

  async getCalledByCount(symbolId: SymbolId): Promise<number> {
    return this.methodEdges.getCalledByCount(symbolId);
  }

  async getCallSiteCount(symbolId: SymbolId): Promise<number> {
    return this.methodEdges.getCallSiteCount(symbolId);
  }

  async getChunkSignalsBulk(): Promise<Map<SymbolId, ChunkGraphSignals>> {
    return this.methodEdges.getChunkSignalsBulk();
  }

  // ── Class hierarchy (bd tea-rags-mcp-f10y) ──

  async getSupertypes(fqName: string): Promise<InheritanceEdge[]> {
    return this.hierarchy.getSupertypes(fqName);
  }

  async getSubtypes(fqName: string): Promise<InheritanceEdge[]> {
    return this.hierarchy.getSubtypes(fqName);
  }

  async getTransitiveSubtypes(fqName: string): Promise<InheritanceEdge[]> {
    return this.hierarchy.getTransitiveSubtypes(fqName);
  }

  async loadHierarchySnapshot(): Promise<HierarchySnapshot> {
    return this.hierarchy.loadHierarchySnapshot();
  }

  // ── Graph analytics ──
  //
  // `computeAndPersistCyclesAndSignals` is deliberately NOT implemented here:
  // the in-process client leaves it undefined so the provider runs Tarjan +
  // PageRank inline over `streamAdjacency`. Only the daemon-routed client
  // implements it.

  async findCycles(scope: CycleScope, pathPattern?: string): Promise<CycleEntry[]> {
    return this.analytics.findCycles(scope, pathPattern);
  }

  async replaceCycles(scope: CycleScope, sccs: readonly (readonly string[])[]): Promise<void> {
    return this.analytics.replaceCycles(scope, sccs);
  }

  async listAdjacency(scope: CycleScope): Promise<Map<string, string[]>> {
    return this.analytics.listAdjacency(scope);
  }

  streamAdjacency(scope: CycleScope): AsyncIterableIterator<[source: string, target: string, weight?: number]> {
    return this.analytics.streamAdjacency(scope);
  }

  async replacePageRanks(ranks: ReadonlyMap<string, number>): Promise<void> {
    return this.analytics.replacePageRanks(ranks);
  }

  async getPageRank(symbolId: SymbolId): Promise<number> {
    return this.analytics.getPageRank(symbolId);
  }

  // ── Resolve-run stats (bd tea-rags-mcp-j431) ──

  async recordRunStats(rows: ResolveRunStatsRow[]): Promise<void> {
    return this.runStats.recordRunStats(rows);
  }

  async getRunStats(): Promise<ResolveRunStatsRow[]> {
    return this.runStats.getRunStats();
  }

  async getEdgeKindDistribution(): Promise<EdgeKindCount[]> {
    return this.runStats.getEdgeKindDistribution();
  }
}
