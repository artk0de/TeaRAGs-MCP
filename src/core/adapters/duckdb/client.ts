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
 * This file is the FACADE only. `GraphDbClient` is the intersection of eight
 * storage sub-interfaces (contracts/types/codegraph-storage.ts); every member
 * here is a one-line delegation to the collaborator typed against the slice of
 * the sub-interface it answers, all over one shared {@link DuckDbGraphSession}:
 *
 * | Collaborator                 | Answers                          | Owns                                            |
 * | ---------------------------- | -------------------------------- | ----------------------------------------------- |
 * | `DuckDbGraphSession`         | —                                | connection, write queue, transactions, batching |
 * | `DuckDbStorageMaintenance`   | `CodegraphStorageMaintenance`    | lifecycle, durability, edge-index rebuild       |
 * | `DuckDbRunStatsStore`        | (maintenance slice)              | `cg_run_stats` + edge-kind distribution         |
 * | `DuckDbSymbolFileStore`      | `CodegraphSymbolFileStore`       | file-upsert transaction envelopes               |
 * | `DuckDbFileGraphStore`       | (symbol-file slice)              | `cg_symbols_files` + everything keyed by file   |
 * | `DuckDbSymbolStore`          | (symbol-file slice)              | `cg_symbols` persistence + chunk resolution     |
 * | `DuckDbFileMetricsReader`    | `CodegraphGraphReadStore` slice  | fanIn / fanOut / p95 / transitive impact        |
 * | `DuckDbMethodEdgeReader`     | `CodegraphGraphReadStore` slice  | callers, callees, fan-out, chunk signals        |
 * | `DuckDbHierarchyReader`      | `CodegraphGraphReadStore` slice  | `cg_symbols_inheritance` reads                  |
 * | `DuckDbGraphAnalyticsStore`  | `CodegraphGraphAnalyticsStore`   | adjacency out, cycles + PageRank back in        |
 * | `DuckDbSignalDriftStore`     | (analytics slice)                | derived-signal drift baseline                   |
 * | `DuckDbTemporalStoreFacade`  | `CodegraphTemporalStore`         | contract-name mapping over the temporal stores  |
 * | `DuckDbIdentifierStore`      | `CodegraphIdentifierStore` slice | `cg_identifiers` (naming lexicon)               |
 * | `DuckDbTypeNameStore`        | `CodegraphIdentifierStore` slice | type-level `cg_symbols` rows + their ancestors  |
 * | `DuckDbOntologyReportStore`  | `CodegraphOntologyReportStore`   | `cg_identifiers` ontology audit reads           |
 * | `DuckDbFieldAccessStore`     | `CodegraphFieldAccessStore`      | `cg_symbols_edges_field` (field-access edges)   |
 *
 * Concurrency: methods run sequentially on a single shared connection owned by
 * the session; a transactional write holds the queue for its whole BEGIN/COMMIT
 * body. The `MigrationCapableClient` adapter surface (`exec` / `run` /
 * `queryAll`) and `openedDatabaseFile` are concrete members of this class, not
 * part of any storage sub-interface.
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
  FieldAccessReplaceEntry,
  FileDependencyGraph,
  FileGraphMetrics,
  FileImportLookup,
  FileReexportEdge,
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
  MethodHeadWordQuery,
  MethodHeadWordRow,
  MethodNamePatternQuery,
  MethodNameRow,
  MethodTailVerbQuery,
  MethodTailVerbRow,
  NonPublicMemberEdge,
  OntologyReportQuery,
  OntologyReportSectionRows,
  OntologyReportSummaryRows,
  Pass1AggregateReadScope,
  PersistedHierarchyDescendantDependency,
  PersistedSymbolLineRanges,
  RelPath,
  ResolveRunStatsRow,
  StoredFieldAccessRow,
  SymbolChunkIdJoinEntry,
  SymbolChunkLocation,
  SymbolDefinition,
  SymbolId,
  SymbolVisibilityRow,
  TemporalCochangeBuildMeta,
  TemporalCochangeGraph,
  TemporalCochangeSnapshot,
  TemporalSymbolCommitFileSnapshot,
  TypeDeclarationReplaceEntry,
  TypeNameQuery,
  TypeNameRow,
} from "../../contracts/types/codegraph.js";
import { DuckDbFieldAccessStore } from "./field-access-store.js";
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
import { DuckDbStorageMaintenance } from "./storage-maintenance.js";
import { DuckDbSymbolFileStore } from "./symbol-file-store.js";
import { DuckDbSymbolStore } from "./symbol-store.js";
import { DuckDbTemporalCochangeStore } from "./temporal-cochange-store.js";
import { DuckDbTemporalStoreFacade } from "./temporal-store-facade.js";
import { DuckDbTemporalSymbolCommitStore } from "./temporal-symbol-commit-store.js";
import { DuckDbTypeNameStore } from "./type-name-store.js";

// Graph algorithms (Tarjan SCC, PageRank) intentionally NOT imported
// here. Per the layering rules in .claude/rules/domain-boundaries.md
// adapters/ may not import from domains/. Cycle/PageRank computation
// lives in domains/trajectory/codegraph/infra/ and the adapter only
// exposes the primitives (listAdjacency, replaceCycles, replacePageRanks)
// the domain orchestrator drives.

/**
 * Construction options for {@link DuckDbGraphClient}. Everything they configure
 * — the DB file, its access mode, the resource ceiling — belongs to the
 * connection, so the shape is defined and consumed by the session.
 */
export type DuckDbGraphClientOptions = DuckDbGraphSessionOptions;

export class DuckDbGraphClient implements GraphDbClient {
  private readonly session: DuckDbGraphSession;
  private readonly maintenance: DuckDbStorageMaintenance;
  private readonly symbolFiles: DuckDbSymbolFileStore;
  private readonly fileMetrics: DuckDbFileMetricsReader;
  private readonly methodEdges: DuckDbMethodEdgeReader;
  private readonly hierarchy: DuckDbHierarchyReader;
  private readonly analytics: DuckDbGraphAnalyticsStore;
  private readonly signalDrift: DuckDbSignalDriftStore;
  private readonly temporal: DuckDbTemporalStoreFacade;
  private readonly identifiers: DuckDbIdentifierStore;
  private readonly ontology: DuckDbOntologyReportStore;
  private readonly typeNames: DuckDbTypeNameStore;
  private readonly fieldAccesses: DuckDbFieldAccessStore;

  constructor(options: DuckDbGraphClientOptions) {
    this.session = new DuckDbGraphSession(options);
    const fileGraph = new DuckDbFileGraphStore(this.session);
    this.maintenance = new DuckDbStorageMaintenance(this.session, fileGraph, new DuckDbRunStatsStore(this.session));
    this.symbolFiles = new DuckDbSymbolFileStore(this.session, fileGraph, new DuckDbSymbolStore(this.session));
    this.fileMetrics = new DuckDbFileMetricsReader(this.session);
    this.methodEdges = new DuckDbMethodEdgeReader(this.session);
    this.hierarchy = new DuckDbHierarchyReader(this.session);
    this.analytics = new DuckDbGraphAnalyticsStore(this.session);
    this.signalDrift = new DuckDbSignalDriftStore(this.session);
    this.temporal = new DuckDbTemporalStoreFacade(
      new DuckDbTemporalCochangeStore(this.session),
      new DuckDbTemporalSymbolCommitStore(this.session),
    );
    this.identifiers = new DuckDbIdentifierStore(this.session);
    this.ontology = new DuckDbOntologyReportStore(this.session);
    this.typeNames = new DuckDbTypeNameStore(this.session);
    this.fieldAccesses = new DuckDbFieldAccessStore(this.session);
  }

  // ── Lifecycle + durability ──

  async init(): Promise<void> {
    return this.maintenance.init();
  }

  async close(): Promise<void> {
    return this.maintenance.close();
  }

  async checkpoint(): Promise<void> {
    return this.maintenance.checkpoint();
  }

  /** See `GraphDbClient.compactStorage`; the protocol is `DuckDbGraphSession#compactDatabaseFile`. */
  async compactStorage(): Promise<CodegraphStorageCompactionOutcome> {
    return this.maintenance.compactStorage();
  }

  /** See `GraphDbClient.exportSnapshot`; the protocol is `DuckDbGraphSession#exportSnapshot`. */
  async exportSnapshot(targetPath: string): Promise<void> {
    return this.maintenance.exportSnapshot(targetPath);
  }

  /** The database file this client holds open now — what the pool checks its path against. */
  openedDatabaseFile(): OpenedDatabaseFile | undefined {
    return this.session.openedDatabaseFile();
  }

  async hasData(): Promise<boolean> {
    return this.maintenance.hasData();
  }

  /** See `DuckDbStorageMaintenance#rebuildEdgeFileTargetIndex` — queued behind every transactional write. */
  async rebuildEdgeFileTargetIndex(): Promise<void> {
    return this.maintenance.rebuildEdgeFileTargetIndex();
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
  // The transaction envelopes of `upsertFile` / `upsertFilesBulk` live in
  // `DuckDbSymbolFileStore`, which owns the per-file write path.

  async upsertFile(node: GraphFileNode, edges: GraphEdges): Promise<void> {
    return this.symbolFiles.upsertFile(node, edges);
  }

  /** See `DuckDbSymbolFileStore#upsertFilesBulk` — one BEGIN/COMMIT for the whole batch. */
  async upsertFilesBulk(entries: readonly BulkFileUpsertEntry[]): Promise<void> {
    return this.symbolFiles.upsertFilesBulk(entries);
  }

  async removeFile(relPath: RelPath): Promise<void> {
    return this.symbolFiles.removeFile(relPath);
  }

  async removeFiles(relPaths: readonly RelPath[]): Promise<void> {
    return this.symbolFiles.removeFiles(relPaths);
  }

  async listFileContentHashes(): Promise<{ relPath: RelPath; contentHash: string | null }[]> {
    return this.symbolFiles.listFileContentHashes();
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
    return this.symbolFiles.upsertSymbols(relPath, definitions);
  }

  async upsertSymbolsBulk(entries: BulkSymbolUpsertEntry[]): Promise<void> {
    return this.symbolFiles.upsertSymbolsBulk(entries);
  }

  async removeSymbolsForFile(relPath: RelPath): Promise<void> {
    return this.symbolFiles.removeSymbolsForFile(relPath);
  }

  async listAllSymbols(): Promise<SymbolDefinition[]> {
    return this.symbolFiles.listAllSymbols();
  }

  async listPass1Aggregates(scope: Pass1AggregateReadScope): Promise<CodegraphPass1FileAggregates[]> {
    return this.symbolFiles.listPass1Aggregates(scope);
  }

  async listHierarchyDependencies(scope: Pass1AggregateReadScope): Promise<PersistedHierarchyDescendantDependency[]> {
    return this.symbolFiles.listHierarchyDependencies(scope);
  }

  async invalidateHierarchyDependentsOfDeletedFiles(relPaths: readonly RelPath[]): Promise<void> {
    return this.symbolFiles.invalidateHierarchyDependentsOfDeletedFiles(relPaths);
  }

  async updateSymbolChunkIds(relPath: RelPath, chunkIds: ReadonlyMap<SymbolId, string>): Promise<void> {
    return this.symbolFiles.updateSymbolChunkIds(relPath, chunkIds);
  }

  async updateSymbolChunkIdsBulk(entries: readonly SymbolChunkIdJoinEntry[]): Promise<void> {
    return this.symbolFiles.updateSymbolChunkIdsBulk(entries);
  }

  async findSymbolChunk(symbolId: SymbolId): Promise<SymbolChunkLocation | null> {
    return this.symbolFiles.findSymbolChunk(symbolId);
  }

  async getSymbolVisibilities(symbolIds: readonly SymbolId[]): Promise<SymbolVisibilityRow[]> {
    return this.symbolFiles.getSymbolVisibilities(symbolIds);
  }

  async getSymbolLineRangesBulk(relPaths: readonly RelPath[]): Promise<Map<RelPath, PersistedSymbolLineRanges>> {
    return this.symbolFiles.getSymbolLineRangesBulk(relPaths);
  }

  // ── Field-access edges ──

  async replaceFieldAccessesBulk(entries: readonly FieldAccessReplaceEntry[]): Promise<void> {
    return this.fieldAccesses.replaceFieldAccessesBulk(entries);
  }

  async readFieldAccessesBySymbols(symbolIds: readonly SymbolId[]): Promise<StoredFieldAccessRow[]> {
    return this.fieldAccesses.readFieldAccessesBySymbols(symbolIds);
  }

  async readFieldAccessesByFiles(relPaths: readonly RelPath[]): Promise<StoredFieldAccessRow[]> {
    return this.fieldAccesses.readFieldAccessesByFiles(relPaths);
  }

  // ── Identifier declarations (naming lexicon) ──

  async replaceIdentifiersBulk(entries: readonly IdentifierReplaceEntry[]): Promise<void> {
    return this.identifiers.replaceIdentifiersBulk(entries);
  }

  async replaceTypeDeclarationsBulk(entries: readonly TypeDeclarationReplaceEntry[]): Promise<void> {
    return this.typeNames.replaceTypeDeclarationsBulk(entries);
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

  async identifierNameTypes(
    names: readonly string[],
    excludePaths?: readonly string[],
    languages?: readonly string[],
  ): Promise<IdentifierNameTypeRow[]> {
    return this.identifiers.identifierNameTypes(names, excludePaths, languages);
  }

  async existingSymbolShortNames(
    names: readonly string[],
    excludePaths?: readonly string[],
    languages?: readonly string[],
  ): Promise<string[]> {
    return this.identifiers.existingSymbolShortNames(names, excludePaths, languages);
  }

  async readMethodHeadWords(q: MethodHeadWordQuery): Promise<MethodHeadWordRow[]> {
    return this.identifiers.readMethodHeadWords(q);
  }

  async readMethodTailVerbs(q: MethodTailVerbQuery): Promise<MethodTailVerbRow[]> {
    return this.identifiers.readMethodTailVerbs(q);
  }

  async readMethodNamesMatching(q: MethodNamePatternQuery): Promise<MethodNameRow[]> {
    return this.identifiers.readMethodNamesMatching(q);
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

  async readTypeNameRows(q: TypeNameQuery): Promise<TypeNameRow[]> {
    return this.typeNames.readTypeNameRows(q);
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

  /** Re-export edges for naming's twin suppression (bd tea-rags-mcp-lnor0); daemon op of the same name. */
  async readFileReexportEdges(): Promise<FileReexportEdge[]> {
    return this.analytics.readFileReexportEdges();
  }

  /** Convention-privacy candidates (bd tea-rags-mcp-r8hme.1); daemon op of the same name. */
  async readNonPublicMemberEdges(languages: readonly string[]): Promise<NonPublicMemberEdge[]> {
    return this.analytics.readNonPublicMemberEdges(languages);
  }

  // ── Temporal co-change sub-graph (bd tea-rags-mcp-x4rpp) ──

  async replaceTemporalCochange(snapshot: TemporalCochangeSnapshot): Promise<void> {
    return this.temporal.replaceTemporalCochange(snapshot);
  }

  async readTemporalCochangeMeta(): Promise<TemporalCochangeBuildMeta | null> {
    return this.temporal.readTemporalCochangeMeta();
  }

  async readTemporalCochangeGraph(): Promise<TemporalCochangeGraph> {
    return this.temporal.readTemporalCochangeGraph();
  }

  async readTemporalBundleFiles(): Promise<ReadonlyMap<number, readonly RelPath[]>> {
    return this.temporal.readTemporalBundleFiles();
  }

  // ── Temporal symbol-commit store (bd tea-rags-mcp-3gz4f) ──

  async replaceTemporalSymbolCommits(files: TemporalSymbolCommitFileSnapshot[]): Promise<void> {
    return this.temporal.replaceTemporalSymbolCommits(files);
  }

  async storedTemporalSymbolCommitFilePaths(): Promise<string[]> {
    return this.temporal.storedTemporalSymbolCommitFilePaths();
  }

  async deleteTemporalSymbolCommitFiles(relPaths: string[]): Promise<void> {
    return this.temporal.deleteTemporalSymbolCommitFiles(relPaths);
  }

  async readTemporalSymbolCommits(relPath: RelPath): Promise<TemporalSymbolCommitFileSnapshot> {
    return this.temporal.readTemporalSymbolCommits(relPath);
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
    return this.maintenance.recordRunStats(rows);
  }

  async recordFileResolveStats(write: FileResolveStatsWrite): Promise<void> {
    return this.maintenance.recordFileResolveStats(write);
  }

  async getRunStats(): Promise<ResolveRunStatsRow[]> {
    return this.maintenance.getRunStats();
  }

  async getEdgeKindDistribution(): Promise<EdgeKindCount[]> {
    return this.maintenance.getEdgeKindDistribution();
  }
}
