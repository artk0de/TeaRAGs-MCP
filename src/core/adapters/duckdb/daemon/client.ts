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
} from "../../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type { DaemonClientOptions, StaleClientBuilds } from "./connection-lifecycle.js";
import { DaemonOpChannel } from "./op-channel.js";
import type { DaemonHandshakeResult } from "./protocol.js";
import {
  DaemonFieldAccessStoreProxy,
  DaemonGraphAnalyticsStoreProxy,
  DaemonGraphReadStoreProxy,
  DaemonIdentifierStoreProxy,
  DaemonOntologyReportStoreProxy,
  DaemonStorageMaintenanceProxy,
  DaemonSymbolFileStoreProxy,
  DaemonTemporalStoreProxy,
} from "./store-proxies/index.js";

// The connection lifecycle (connect/retry, pending-call settlement, liveness
// watch, reconnect-and-replay) moved to `connection-lifecycle.ts` (bd
// tea-rags-mcp-0qaht.3); these re-exports keep `daemon/client.js` the import
// site the pool, the bootstrap factory and the tests already use.
export {
  assessDaemonCapability,
  isClientStale,
  isDaemonRefusedWithoutRespawn,
  LEGACY_TOLERATED_OPS,
  REQUIRED_DAEMON_OPS,
} from "./connection-lifecycle.js";
export type { DaemonCapabilityVerdict, DaemonClientOptions, StaleClientBuilds } from "./connection-lifecycle.js";
// Lives with the analytics proxy that throws it (bd tea-rags-mcp-0qaht.38).
export { UnsupportedDaemonReadError } from "./store-proxies/index.js";

/**
 * `GraphDbClient` that proxies the entire codegraph surface — every mutation
 * and every read — to the codegraph daemon over a unix socket using
 * newline-JSON framing. Only `streamAdjacency` is NOT proxied: it stays
 * daemon-internal (consumed by the daemon-side
 * `computeAndPersistCyclesAndSignals`) and throws `UnsupportedDaemonReadError`.
 *
 * Composition (bd tea-rags-mcp-0qaht.38): the op transport — typed `call`,
 * tolerated legacy ops, handshake, shutdown, the read-only switch — is the
 * `DaemonOpChannel`; each `GraphDbClient` sub-interface is one per-store proxy
 * sending its ops through that channel. The members below are the unchanged
 * public surface, each a one-line delegation, so callers and the tests that
 * spy on this class's prototype see exactly the shape they always did.
 */
export class DaemonGraphDbClient implements GraphDbClient {
  private readonly channel: DaemonOpChannel;
  private readonly maintenance: DaemonStorageMaintenanceProxy;
  private readonly symbolFiles: DaemonSymbolFileStoreProxy;
  private readonly graphReads: DaemonGraphReadStoreProxy;
  private readonly analytics: DaemonGraphAnalyticsStoreProxy;
  private readonly identifiers: DaemonIdentifierStoreProxy;
  private readonly fieldAccesses: DaemonFieldAccessStoreProxy;
  private readonly ontology: DaemonOntologyReportStoreProxy;
  private readonly temporal: DaemonTemporalStoreProxy;

  constructor(socketPath: string, physicalCollectionName: PhysicalCollectionName, opts?: DaemonClientOptions) {
    this.channel = new DaemonOpChannel(socketPath, physicalCollectionName, opts);
    this.maintenance = new DaemonStorageMaintenanceProxy(this.channel, physicalCollectionName);
    this.symbolFiles = new DaemonSymbolFileStoreProxy(this.channel);
    this.graphReads = new DaemonGraphReadStoreProxy(this.channel);
    this.analytics = new DaemonGraphAnalyticsStoreProxy(this.channel);
    this.identifiers = new DaemonIdentifierStoreProxy(this.channel);
    this.fieldAccesses = new DaemonFieldAccessStoreProxy(this.channel);
    this.ontology = new DaemonOntologyReportStoreProxy(this.channel);
    this.temporal = new DaemonTemporalStoreProxy(this.channel);
  }

  /** Connect to the daemon socket with bounded retry — see `DaemonConnectionLifecycle#init`. */
  async init(): Promise<void> {
    return this.channel.init();
  }

  async close(): Promise<void> {
    return this.channel.close();
  }

  /**
   * Whether this client still holds a live socket. The pool reads it before
   * handing a cached client back: a client whose daemon exited is spent, and
   * reusing it would only produce "call after close" for the rest of the
   * process's life.
   */
  isConnected(): boolean {
    return this.channel.isConnected();
  }

  /**
   * Make this client READ-ONLY for the rest of its life (bd
   * tea-rags-mcp-1wr7p): it proceeds against a daemon of the on-disk build its
   * own code predates. The graph reads keep working; every write-class op
   * throws `CodegraphClientStaleBuildError` before it reaches the socket. The
   * pool's handshake calls it; the replay path applies it to itself.
   */
  restrictToReads(builds: StaleClientBuilds): void {
    this.channel.restrictToReads(builds);
  }

  /** Exchange build fingerprints with the daemon — see `DaemonOpChannel#handshake`. */
  async handshake(buildFingerprint?: string): Promise<DaemonHandshakeResult | null> {
    return this.channel.handshake(buildFingerprint);
  }

  /** Ask the daemon to drain and exit — see `DaemonOpChannel#requestShutdown`. */
  async requestShutdown(): Promise<void> {
    return this.channel.requestShutdown();
  }

  async upsertFile(node: GraphFileNode, edges: GraphEdges): Promise<void> {
    return this.symbolFiles.upsertFile(node, edges);
  }

  async removeFile(relPath: RelPath): Promise<void> {
    return this.symbolFiles.removeFile(relPath);
  }

  async removeFiles(relPaths: readonly RelPath[]): Promise<void> {
    return this.symbolFiles.removeFiles(relPaths);
  }

  async removeSymbolsForFile(relPath: RelPath): Promise<void> {
    return this.symbolFiles.removeSymbolsForFile(relPath);
  }

  async pruneDerivedForDeletedFiles(relPaths: readonly RelPath[]): Promise<void> {
    return this.analytics.pruneDerivedForDeletedFiles(relPaths);
  }

  async hasStaleDerivedTables(): Promise<boolean> {
    return this.analytics.hasStaleDerivedTables();
  }

  async upsertSymbols(relPath: RelPath, definitions: SymbolDefinition[]): Promise<void> {
    return this.symbolFiles.upsertSymbols(relPath, definitions);
  }

  async upsertSymbolsBulk(entries: BulkSymbolUpsertEntry[]): Promise<void> {
    return this.symbolFiles.upsertSymbolsBulk(entries);
  }

  async upsertFilesBulk(entries: readonly BulkFileUpsertEntry[]): Promise<void> {
    return this.symbolFiles.upsertFilesBulk(entries);
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

  async replaceFieldAccessesBulk(entries: readonly FieldAccessReplaceEntry[]): Promise<void> {
    return this.fieldAccesses.replaceFieldAccessesBulk(entries);
  }

  async readFieldAccessesBySymbols(symbolIds: readonly SymbolId[]): Promise<StoredFieldAccessRow[]> {
    return this.fieldAccesses.readFieldAccessesBySymbols(symbolIds);
  }

  async readFieldAccessesByFiles(relPaths: readonly RelPath[]): Promise<StoredFieldAccessRow[]> {
    return this.fieldAccesses.readFieldAccessesByFiles(relPaths);
  }

  async replaceIdentifiersBulk(entries: readonly IdentifierReplaceEntry[]): Promise<void> {
    return this.identifiers.replaceIdentifiersBulk(entries);
  }

  async replaceTypeDeclarationsBulk(entries: readonly TypeDeclarationReplaceEntry[]): Promise<void> {
    return this.identifiers.replaceTypeDeclarationsBulk(entries);
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
    return this.identifiers.readTypeNameRows(q);
  }

  async replaceCycles(scope: CycleScope, sccs: readonly (readonly string[])[]): Promise<void> {
    return this.analytics.replaceCycles(scope, sccs);
  }

  async replacePageRanks(ranks: ReadonlyMap<string, number>): Promise<void> {
    return this.analytics.replacePageRanks(ranks);
  }

  async checkpoint(): Promise<void> {
    return this.maintenance.checkpoint();
  }

  async compactStorage(): Promise<CodegraphStorageCompactionOutcome> {
    return this.maintenance.compactStorage();
  }

  async exportSnapshot(targetPath: string): Promise<void> {
    return this.maintenance.exportSnapshot(targetPath);
  }

  async rebuildEdgeFileTargetIndex(): Promise<void> {
    return this.maintenance.rebuildEdgeFileTargetIndex();
  }

  async recordRunStats(rows: ResolveRunStatsRow[]): Promise<void> {
    return this.maintenance.recordRunStats(rows);
  }

  async recordFileResolveStats(write: FileResolveStatsWrite): Promise<void> {
    return this.maintenance.recordFileResolveStats(write);
  }

  async finalizeReindex(oldVersion: string, newVersion: string): Promise<void> {
    return this.maintenance.finalizeReindex(oldVersion, newVersion);
  }

  async removeCollectionDatabase(target: PhysicalCollectionName): Promise<boolean | undefined> {
    return this.maintenance.removeCollectionDatabase(target);
  }

  async cloneCollectionDatabase(source: PhysicalCollectionName, target: PhysicalCollectionName): Promise<boolean> {
    return this.maintenance.cloneCollectionDatabase(source, target);
  }

  /** Ask another build's holder daemon to release this collection — see the proxy (bd tea-rags-mcp-8noie). */
  async releaseIdleCollection(): Promise<boolean> {
    return this.maintenance.releaseIdleCollection();
  }

  async computeAndPersistCyclesAndSignals(): Promise<void> {
    return this.analytics.computeAndPersistCyclesAndSignals();
  }

  async refreshSymbolSignalsPrev(): Promise<void> {
    return this.analytics.refreshSymbolSignalsPrev();
  }

  async diffSymbolSignals(): Promise<CodegraphSignalDrift> {
    return this.analytics.diffSymbolSignals();
  }

  async getFanIn(relPath: RelPath): Promise<number> {
    return this.graphReads.getFanIn(relPath);
  }

  async getFanInP95(): Promise<number> {
    return this.graphReads.getFanInP95();
  }

  async getFanOut(relPath: RelPath): Promise<number> {
    return this.graphReads.getFanOut(relPath);
  }

  async getCallers(symbolId: SymbolId): Promise<CallerEdge[]> {
    return this.graphReads.getCallers(symbolId);
  }

  async getCallees(symbolId: SymbolId): Promise<CalleeEdge[]> {
    return this.graphReads.getCallees(symbolId);
  }

  async getAmbiguousCallersByMember(member: string, limit?: number): Promise<AmbiguousCallerSite[]> {
    return this.graphReads.getAmbiguousCallersByMember(member, limit);
  }

  async getCalleeEdges(symbolIds: SymbolId[]): Promise<Map<SymbolId, SymbolId[]>> {
    return this.graphReads.getCalleeEdges(symbolIds);
  }

  async getCalleeEdgesScoped(refs: FileScopedSymbolRef[]): Promise<Map<FileScopedSymbolId, FileScopedSymbolRef[]>> {
    return this.graphReads.getCalleeEdgesScoped(refs);
  }

  async getSymbolRelPaths(symbolIds: SymbolId[]): Promise<Map<SymbolId, RelPath[]>> {
    return this.graphReads.getSymbolRelPaths(symbolIds);
  }

  async getCalledByCount(symbolId: SymbolId): Promise<number> {
    return this.graphReads.getCalledByCount(symbolId);
  }

  async getCallSiteCount(symbolId: SymbolId): Promise<number> {
    return this.graphReads.getCallSiteCount(symbolId);
  }

  async getChunkSignalsBulk(): Promise<Map<FileScopedSymbolId, ChunkGraphSignals>> {
    return this.graphReads.getChunkSignalsBulk();
  }

  async getSymbolLineRangesBulk(relPaths: readonly RelPath[]): Promise<Map<RelPath, PersistedSymbolLineRanges>> {
    return this.symbolFiles.getSymbolLineRangesBulk(relPaths);
  }

  async hasData(): Promise<boolean> {
    return this.maintenance.hasData();
  }

  async getRunStats(): Promise<ResolveRunStatsRow[]> {
    return this.maintenance.getRunStats();
  }

  async getEdgeKindDistribution(): Promise<EdgeKindCount[]> {
    return this.maintenance.getEdgeKindDistribution();
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

  async listFileContentHashes(): Promise<{ relPath: RelPath; contentHash: string | null }[]> {
    return this.symbolFiles.listFileContentHashes();
  }

  async getTransitiveImpact(relPath: RelPath, maxDepth?: number): Promise<number> {
    return this.graphReads.getTransitiveImpact(relPath, maxDepth);
  }

  async getFileMetricsBulk(relPaths: readonly RelPath[], maxDepth?: number): Promise<Map<RelPath, FileGraphMetrics>> {
    return this.graphReads.getFileMetricsBulk(relPaths, maxDepth);
  }

  async findCycles(scope: CycleScope, pathPattern?: string): Promise<CycleEntry[]> {
    return this.analytics.findCycles(scope, pathPattern);
  }

  async listAdjacency(scope: CycleScope): Promise<Map<string, string[]>> {
    return this.analytics.listAdjacency(scope);
  }

  async readFileDependencyGraph(): Promise<FileDependencyGraph> {
    return this.analytics.readFileDependencyGraph();
  }

  async readFileReexportEdges(): Promise<FileReexportEdge[]> {
    return this.analytics.readFileReexportEdges();
  }

  async readNonPublicMemberEdges(languages: readonly string[]): Promise<NonPublicMemberEdge[]> {
    return this.analytics.readNonPublicMemberEdges(languages);
  }

  async replaceTemporalCochange(snapshot: TemporalCochangeSnapshot): Promise<void> {
    return this.temporal.replaceTemporalCochange(snapshot);
  }

  async replaceTemporalSymbolCommits(files: TemporalSymbolCommitFileSnapshot[]): Promise<void> {
    return this.temporal.replaceTemporalSymbolCommits(files);
  }

  async deleteTemporalSymbolCommitFiles(relPaths: string[]): Promise<void> {
    return this.temporal.deleteTemporalSymbolCommitFiles(relPaths);
  }

  async storedTemporalSymbolCommitFilePaths(): Promise<string[]> {
    return this.temporal.storedTemporalSymbolCommitFilePaths();
  }

  async readTemporalSymbolCommits(relPath: string): Promise<TemporalSymbolCommitFileSnapshot> {
    return this.temporal.readTemporalSymbolCommits(relPath);
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

  async getFileImporters(relPath: RelPath): Promise<FileImportLookup> {
    return this.analytics.getFileImporters(relPath);
  }

  async getFileImports(relPath: RelPath): Promise<FileImportLookup> {
    return this.analytics.getFileImports(relPath);
  }

  async getPageRank(symbolId: SymbolId, relPath?: RelPath): Promise<number> {
    return this.analytics.getPageRank(symbolId, relPath);
  }

  async getSupertypes(fqName: string): Promise<InheritanceEdge[]> {
    return this.graphReads.getSupertypes(fqName);
  }

  async getSubtypes(fqName: string): Promise<InheritanceEdge[]> {
    return this.graphReads.getSubtypes(fqName);
  }

  async getTransitiveSubtypes(fqName: string): Promise<InheritanceEdge[]> {
    return this.graphReads.getTransitiveSubtypes(fqName);
  }

  async loadHierarchySnapshot(): Promise<HierarchySnapshot> {
    return this.graphReads.loadHierarchySnapshot();
  }

  streamAdjacency(scope: CycleScope): AsyncIterableIterator<[source: string, target: string, weight?: number]> {
    return this.analytics.streamAdjacency(scope);
  }
}
