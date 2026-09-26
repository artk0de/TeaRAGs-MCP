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
 * | `DuckDbTemporalCochangeStore`| `cg_temporal_*` co-change sub-graph             |
 * | `DuckDbIdentifierStore`      | `cg_identifiers` (naming lexicon)               |
 * | `DuckDbOntologyReportStore`  | `cg_identifiers` ontology audit reads           |
 *
 * Concurrency: methods run sequentially on a single shared connection owned by
 * the session; a transactional write holds the queue for its whole BEGIN/COMMIT
 * body. The `MigrationCapableClient` adapter surface (`exec` / `run` /
 * `queryAll`) is also exposed for the migration runner.
 */

import type {
  AmbiguousCallerSite,
  AnchorIdentifierTypeRow,
  BulkFileUpsertEntry,
  BulkSymbolUpsertEntry,
  CalleeEdge,
  CallerEdge,
  ChunkGraphSignals,
  CodegraphPass1FileAggregates,
  CodegraphSignalDrift,
  CodegraphStorageCompactionOutcome,
  CycleEntry,
  CycleScope,
  EdgeKindCount,
  FileDependencyGraph,
  FileGraphMetrics,
  FileImportLookup,
  FileResolveStatsWrite,
  FileScopedSymbolId,
  FileScopedSymbolRef,
  GraphDbClient,
  GraphEdges,
  GraphFileNode,
  HierarchySnapshot,
  IdentifierCalleeAggregateRow,
  IdentifierCalleeScopeQuery,
  IdentifierLanguageCountQuery,
  IdentifierLanguageCountRow,
  IdentifierNameKindTypeRow,
  IdentifierNameScopeQuery,
  IdentifierNameTypeRow,
  IdentifierReplaceEntry,
  IdentifierShapeSampleQuery,
  IdentifierShapeSampleRow,
  IdentifierTypeAggregateQuery,
  IdentifierTypeAggregateRow,
  IdentifierTypeScopeQuery,
  InheritanceEdge,
  NonPublicMemberEdge,
  OntologyReportQuery,
  OntologyReportSectionRows,
  OntologyReportSummaryRows,
  Pass1AggregateReadScope,
  PersistedSymbolLineRanges,
  RelPath,
  ResolveRunStatsRow,
  SymbolChunkIdJoinEntry,
  SymbolChunkLocation,
  SymbolDefinition,
  SymbolId,
  SymbolVisibilityRow,
  TemporalCochangeBuildMeta,
  TemporalCochangeGraph,
  TemporalCochangeSnapshot,
} from "../../contracts/types/codegraph.js";
import { DuckDbFileGraphStore } from "./file-graph-store.js";
import { DuckDbFileMetricsReader } from "./file-metrics-reader.js";
import { DuckDbGraphAnalyticsStore } from "./graph-analytics-store.js";
import { DuckDbGraphSession, type DuckDbGraphSessionOptions, type OpenedDatabaseFile } from "./graph-session.js";
import { DuckDbHierarchyReader } from "./hierarchy-reader.js";
import { DuckDbIdentifierStore } from "./identifier-store.js";
import { DuckDbMethodEdgeReader } from "./method-edge-reader.js";
import { DuckDbOntologyReportStore } from "./ontology-report-store.js";
import { DuckDbRunStatsStore } from "./run-stats-store.js";
import { DuckDbSignalDriftStore } from "./signal-drift-store.js";
import { DuckDbSymbolStore } from "./symbol-store.js";
import { DuckDbTemporalCochangeStore } from "./temporal-cochange-store.js";

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
  private readonly signalDrift: DuckDbSignalDriftStore;
  private readonly temporalCochange: DuckDbTemporalCochangeStore;
  private readonly identifiers: DuckDbIdentifierStore;
  private readonly ontology: DuckDbOntologyReportStore;

  constructor(options: DuckDbGraphClientOptions) {
    this.session = new DuckDbGraphSession(options);
    this.fileGraph = new DuckDbFileGraphStore(this.session);
    this.fileMetrics = new DuckDbFileMetricsReader(this.session);
    this.symbols = new DuckDbSymbolStore(this.session);
    this.methodEdges = new DuckDbMethodEdgeReader(this.session);
    this.hierarchy = new DuckDbHierarchyReader(this.session);
    this.analytics = new DuckDbGraphAnalyticsStore(this.session);
    this.runStats = new DuckDbRunStatsStore(this.session);
    this.signalDrift = new DuckDbSignalDriftStore(this.session);
    this.temporalCochange = new DuckDbTemporalCochangeStore(this.session);
    this.identifiers = new DuckDbIdentifierStore(this.session);
    this.ontology = new DuckDbOntologyReportStore(this.session);
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

  /** See `GraphDbClient.compactStorage`; the protocol is `DuckDbGraphSession#compactDatabaseFile`. */
  async compactStorage(): Promise<CodegraphStorageCompactionOutcome> {
    return this.session.compactDatabaseFile();
  }

  /** The database file this client holds open now — what the pool checks its path against. */
  openedDatabaseFile(): OpenedDatabaseFile | undefined {
    return this.session.openedDatabaseFile();
  }

  async hasData(): Promise<boolean> {
    return this.fileGraph.hasData();
  }

  /**
   * See `GraphDbClient.rebuildEdgeFileTargetIndex` (contracts/types/codegraph-storage.ts).
   *
   * Queued behind every transactional write, like `checkpoint` (bd
   * tea-rags-mcp-sgo8v). Every writer of this database shares ONE connection —
   * the daemon's per-collection client — so a DDL issued directly would execute
   * inside whichever writer's BEGIN happened to be open: the node-flush chain
   * during pass-2, and with one pass-2 per language partition, the other
   * partition's `upsertFilesBulk` into the very table being re-indexed.
   */
  async rebuildEdgeFileTargetIndex(): Promise<void> {
    await this.session.serialize(async () =>
      this.session.exec(
        "DROP INDEX IF EXISTS idx_cg_symbols_edges_file_target; " +
          "CREATE INDEX idx_cg_symbols_edges_file_target ON cg_symbols_edges_file (target_rel_path);",
      ),
    );
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
   * Unlike `upsertFile`, the DELETE+INSERT lifecycle is batched ACROSS the
   * whole set (`DuckDbFileGraphStore#writeFileRowsBulk`), not looped per file:
   * a chunked IN-list DELETE per table instead of one DELETE per file per
   * table. Persisted rows are byte-identical to calling `upsertFile` per
   * file — last-wins per relPath, cross-file PK collisions first-wins by
   * batch order — only the statement count drops (bd tea-rags-mcp-wgt19
   * follow-up: per-file DELETEs re-scanned the FSST-compressed
   * source_rel_path column on every call). Any row failure rolls the whole
   * batch back (callers cap batch size + skip pathological files upstream).
   */
  async upsertFilesBulk(entries: readonly BulkFileUpsertEntry[]): Promise<void> {
    if (entries.length === 0) return;
    return this.session.transaction(async () => this.fileGraph.writeFileRowsBulk(entries));
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

  async getFileMetricsBulk(relPaths: readonly RelPath[], maxDepth = 5): Promise<Map<RelPath, FileGraphMetrics>> {
    return this.fileMetrics.getFileMetricsBulk(relPaths, maxDepth);
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

  async listPass1Aggregates(scope: Pass1AggregateReadScope): Promise<CodegraphPass1FileAggregates[]> {
    return this.fileGraph.listPass1Aggregates(scope);
  }

  async updateSymbolChunkIds(relPath: RelPath, chunkIds: ReadonlyMap<SymbolId, string>): Promise<void> {
    return this.symbols.updateSymbolChunkIds(relPath, chunkIds);
  }

  async updateSymbolChunkIdsBulk(entries: readonly SymbolChunkIdJoinEntry[]): Promise<void> {
    return this.symbols.updateSymbolChunkIdsBulk(entries);
  }

  async findSymbolChunk(symbolId: SymbolId): Promise<SymbolChunkLocation | null> {
    return this.symbols.findSymbolChunk(symbolId);
  }

  async getSymbolVisibilities(symbolIds: readonly SymbolId[]): Promise<SymbolVisibilityRow[]> {
    return this.symbols.getSymbolVisibilities(symbolIds);
  }

  async getSymbolLineRangesBulk(relPaths: readonly RelPath[]): Promise<Map<RelPath, PersistedSymbolLineRanges>> {
    return this.symbols.getSymbolLineRangesBulk(relPaths);
  }

  // ── Identifier declarations (naming lexicon) ──

  async replaceIdentifiersBulk(entries: readonly IdentifierReplaceEntry[]): Promise<void> {
    return this.identifiers.replaceIdentifiersBulk(entries);
  }

  async aggregateIdentifiersByType(q: IdentifierTypeAggregateQuery): Promise<IdentifierTypeAggregateRow[]> {
    return this.identifiers.aggregateIdentifiersByType(q);
  }

  async aggregateIdentifiersByCallee(q: IdentifierCalleeScopeQuery): Promise<IdentifierCalleeAggregateRow[]> {
    return this.identifiers.aggregateIdentifiersByCallee(q);
  }

  async anchorIdentifierTypes(symbolIds: readonly SymbolId[]): Promise<AnchorIdentifierTypeRow[]> {
    return this.identifiers.anchorIdentifierTypes(symbolIds);
  }

  async identifierNameTypes(names: readonly string[]): Promise<IdentifierNameTypeRow[]> {
    return this.identifiers.identifierNameTypes(names);
  }

  async existingSymbolShortNames(names: readonly string[]): Promise<string[]> {
    return this.identifiers.existingSymbolShortNames(names);
  }

  async countIdentifiers(q: IdentifierTypeScopeQuery): Promise<number> {
    return this.identifiers.countIdentifiers(q);
  }

  async aggregateIdentifiersByName(q: IdentifierNameScopeQuery): Promise<IdentifierNameKindTypeRow[]> {
    return this.identifiers.aggregateIdentifiersByName(q);
  }

  async identifierLanguageCounts(q: IdentifierLanguageCountQuery): Promise<IdentifierLanguageCountRow[]> {
    return this.identifiers.identifierLanguageCounts(q);
  }

  async sampleIdentifierShapes(q: IdentifierShapeSampleQuery): Promise<IdentifierShapeSampleRow[]> {
    return this.identifiers.sampleIdentifierShapes(q);
  }

  async readOntologyReportSummary(q: OntologyReportQuery): Promise<OntologyReportSummaryRows> {
    return this.ontology.readOntologyReportSummary(q);
  }

  async readOntologyReportSections(
    q: OntologyReportQuery,
    excludedGenericNames: readonly string[],
  ): Promise<OntologyReportSectionRows> {
    return this.ontology.readOntologyReportSections(q, excludedGenericNames);
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

  async getCalleeEdgesScoped(refs: FileScopedSymbolRef[]): Promise<Map<FileScopedSymbolId, FileScopedSymbolRef[]>> {
    return this.methodEdges.getCalleeEdgesScoped(refs);
  }

  async getSymbolRelPaths(symbolIds: SymbolId[]): Promise<Map<SymbolId, RelPath[]>> {
    return this.methodEdges.getSymbolRelPaths(symbolIds);
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

  async getChunkSignalsBulk(): Promise<Map<FileScopedSymbolId, ChunkGraphSignals>> {
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

  /**
   * Whole-graph read for the boundary diagnostics (bd tea-rags-mcp-thc7s). The
   * report script opens a file copy in-process; `get_architecture_report` reads
   * it through the daemon op of the same name (bd tea-rags-mcp-94hd9).
   */
  async readFileDependencyGraph(): Promise<FileDependencyGraph> {
    return this.analytics.readFileDependencyGraph();
  }

  /** Convention-privacy candidates (bd tea-rags-mcp-r8hme.1); daemon op of the same name. */
  async readNonPublicMemberEdges(languages: readonly string[]): Promise<NonPublicMemberEdge[]> {
    return this.analytics.readNonPublicMemberEdges(languages);
  }

  // ── Temporal co-change sub-graph (bd tea-rags-mcp-x4rpp) ──

  async replaceTemporalCochange(snapshot: TemporalCochangeSnapshot): Promise<void> {
    return this.temporalCochange.replace(snapshot);
  }

  async readTemporalCochangeMeta(): Promise<TemporalCochangeBuildMeta | null> {
    return this.temporalCochange.readMeta();
  }

  async readTemporalCochangeGraph(): Promise<TemporalCochangeGraph> {
    return this.temporalCochange.readGraph();
  }

  /** File-scope `get_callers` (bd tea-rags-mcp-gfvr8): the files importing `relPath`. */
  async getFileImporters(relPath: RelPath): Promise<FileImportLookup> {
    return this.analytics.getFileImporters(relPath);
  }

  /** File-scope `get_callees` (bd tea-rags-mcp-gfvr8): the files `relPath` imports. */
  async getFileImports(relPath: RelPath): Promise<FileImportLookup> {
    return this.analytics.getFileImports(relPath);
  }

  async replacePageRanks(ranks: ReadonlyMap<string, number>): Promise<void> {
    return this.analytics.replacePageRanks(ranks);
  }

  async pruneDerivedForDeletedFiles(relPaths: readonly RelPath[]): Promise<void> {
    return this.analytics.pruneDerivedForDeletedFiles(relPaths);
  }

  async hasStaleDerivedTables(): Promise<boolean> {
    return this.analytics.hasStaleDerivedTables();
  }

  async getPageRank(symbolId: SymbolId, relPath?: RelPath): Promise<number> {
    return this.analytics.getPageRank(symbolId, relPath);
  }

  // ── Derived-signal drift (bd tea-rags-mcp-a2ddb) ──

  async diffSymbolSignals(): Promise<CodegraphSignalDrift> {
    return this.signalDrift.diffSymbolSignals();
  }

  async refreshSymbolSignalsPrev(): Promise<void> {
    return this.signalDrift.refreshSymbolSignalsPrev();
  }

  // ── Resolve-run stats (bd tea-rags-mcp-j431) ──

  async recordRunStats(rows: ResolveRunStatsRow[]): Promise<void> {
    return this.runStats.recordRunStats(rows);
  }

  async recordFileResolveStats(write: FileResolveStatsWrite): Promise<void> {
    return this.runStats.recordFileResolveStats(write);
  }

  async getRunStats(): Promise<ResolveRunStatsRow[]> {
    return this.runStats.getRunStats();
  }

  async getEdgeKindDistribution(): Promise<EdgeKindCount[]> {
    return this.runStats.getEdgeKindDistribution();
  }
}
