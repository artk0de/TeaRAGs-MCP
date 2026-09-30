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
  ReviewFileEdge,
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
import {
  DaemonConnectionLifecycle,
  type DaemonClientOptions,
  type LegacyToleratedDaemonOp,
  type StaleClientBuilds,
} from "./connection-lifecycle.js";
import type { DaemonHandshakeResult, DaemonOp } from "./protocol.js";

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

/**
 * Thrown when a daemon-internal op is invoked on the daemon client. In daemon
 * mode the `DaemonGraphDbClient` is the SOLE accessor of the DuckDB file, so it
 * proxies the ENTIRE `GraphDbClient` surface — every write AND every read — over
 * the socket. The lone exception is `streamAdjacency`: the heavy graph analysis
 * runs daemon-side via `computeAndPersistCyclesAndSignals`, so the adjacency
 * stream must NOT cross IPC and still throws this error if called on the client.
 */
export class UnsupportedDaemonReadError extends Error {
  constructor(op: string) {
    super(`DaemonGraphDbClient is write-only; read op "${op}" must use the in-process RO handle`);
    this.name = "UnsupportedDaemonReadError";
  }
}

/**
 * `GraphDbClient` that proxies the entire codegraph surface — every mutation
 * and every read — to the codegraph daemon over a unix socket using
 * newline-JSON framing. Each call gets a monotonic id; responses are matched
 * back by id through the `pending` map. Only `streamAdjacency` is NOT proxied:
 * it stays daemon-internal (consumed by the daemon-side
 * `computeAndPersistCyclesAndSignals`) and throws `UnsupportedDaemonReadError`.
 *
 * The connection itself — connect/retry, pending-call settlement, the liveness
 * watch, reconnect-and-replay — is owned by the `DaemonConnectionLifecycle`
 * this class constructs and delegates to; the methods below are the unchanged
 * public surface plus the one-op-per-call wrappers.
 */
export class DaemonGraphDbClient implements GraphDbClient {
  private readonly lifecycle: DaemonConnectionLifecycle;

  constructor(socketPath: string, physicalCollectionName: PhysicalCollectionName, opts?: DaemonClientOptions) {
    this.lifecycle = new DaemonConnectionLifecycle(socketPath, physicalCollectionName, opts);
  }

  /** Connect to the daemon socket with bounded retry — see `DaemonConnectionLifecycle#init`. */
  async init(): Promise<void> {
    return this.lifecycle.init();
  }

  async close(): Promise<void> {
    return this.lifecycle.close();
  }

  /**
   * Whether this client still holds a live socket. The pool reads it before
   * handing a cached client back: a client whose daemon exited is spent, and
   * reusing it would only produce "call after close" for the rest of the
   * process's life.
   */
  isConnected(): boolean {
    return this.lifecycle.isConnected();
  }

  /**
   * Make this client READ-ONLY for the rest of its life (bd
   * tea-rags-mcp-1wr7p): it proceeds against a daemon of the on-disk build its
   * own code predates. The graph reads keep working; every write-class op
   * throws `CodegraphClientStaleBuildError` before it reaches the socket. The
   * pool's handshake calls it; the replay path applies it to itself.
   */
  restrictToReads(builds: StaleClientBuilds): void {
    this.lifecycle.restrictToReads(builds);
  }

  /** Send one request and await its response — see `DaemonConnectionLifecycle#call`. */
  private async call(
    op: DaemonOp,
    params: Record<string, unknown>,
    options: { replayable?: boolean } = {},
  ): Promise<unknown> {
    return this.lifecycle.call(op, params, options);
  }

  /** `call` for a tolerated legacy op — see `DaemonConnectionLifecycle#callTolerated`. */
  private async callTolerated<T>(
    op: LegacyToleratedDaemonOp,
    params: Record<string, unknown>,
    decode: (result: unknown) => T,
    fallback: () => T | Promise<T>,
  ): Promise<T> {
    return this.lifecycle.callTolerated(op, params, decode, fallback);
  }

  // ── build-version handshake (bd tea-rags-mcp-ji56r) ──

  /**
   * Exchange build fingerprints with the daemon. Sends the CLIENT's
   * fingerprint; resolves the daemon's (a legacy daemon returns null — no
   * fingerprint, treated by the pool as "proceed, no restart"). On a match or
   * legacy peer the daemon also opens + migrates + hydrates the collection.
   */
  async handshake(buildFingerprint?: string): Promise<DaemonHandshakeResult | null> {
    if (buildFingerprint !== undefined) this.lifecycle.rememberHandshakeFingerprint(buildFingerprint);
    // `undefined` vanishes in JSON serialisation — a legacy-shaped request.
    return (await this.call("handshake", { buildFingerprint })) as DaemonHandshakeResult | null;
  }

  /**
   * Ask the daemon to drain in-flight ops and exit gracefully (release the RW
   * DuckDB lock + remove its lifecycle files). The daemon ACKS first, then
   * tears down via its idle-watcher drain/exit path — the caller must close
   * its socket and poll the lifecycle files for the actual exit.
   */
  async requestShutdown(): Promise<void> {
    await this.call("shutdown", {});
  }

  // ── writes (proxied over the socket) ──

  async upsertFile(node: GraphFileNode, edges: GraphEdges): Promise<void> {
    await this.call("upsertFile", { node, edges });
  }

  async removeFile(relPath: RelPath): Promise<void> {
    await this.call("removeFile", { relPath });
  }

  async removeSymbolsForFile(relPath: RelPath): Promise<void> {
    await this.call("removeSymbolsForFile", { relPath });
  }

  async pruneDerivedForDeletedFiles(relPaths: readonly RelPath[]): Promise<void> {
    await this.call("pruneDerivedForDeletedFiles", { relPaths: [...relPaths] });
  }

  async hasStaleDerivedTables(): Promise<boolean> {
    return (await this.call("hasStaleDerivedTables", {})) as boolean;
  }

  async upsertSymbols(relPath: RelPath, definitions: SymbolDefinition[]): Promise<void> {
    await this.call("upsertSymbols", { relPath, definitions });
  }

  async upsertSymbolsBulk(entries: BulkSymbolUpsertEntry[]): Promise<void> {
    await this.call("upsertSymbolsBulk", { entries });
  }

  async upsertFilesBulk(entries: readonly BulkFileUpsertEntry[]): Promise<void> {
    await this.call("upsertFilesBulk", { entries });
  }

  async updateSymbolChunkIds(relPath: RelPath, chunkIds: ReadonlyMap<SymbolId, string>): Promise<void> {
    await this.call("updateSymbolChunkIds", { relPath, chunkIds: [...chunkIds.entries()] });
  }

  async updateSymbolChunkIdsBulk(entries: readonly SymbolChunkIdJoinEntry[]): Promise<void> {
    // Each file's join travels as Map entries — a Map does not survive JSON.
    await this.call("updateSymbolChunkIdsBulk", {
      entries: entries.map((e) => ({ relPath: e.relPath, chunkIds: [...e.chunkIds.entries()] })),
    });
  }

  async findSymbolChunk(symbolId: SymbolId): Promise<SymbolChunkLocation | null> {
    return (await this.call("findSymbolChunk", { symbolId })) as SymbolChunkLocation | null;
  }

  async getSymbolVisibilities(symbolIds: readonly SymbolId[]): Promise<SymbolVisibilityRow[]> {
    return (await this.call("getSymbolVisibilities", { symbolIds: [...symbolIds] })) as SymbolVisibilityRow[];
  }

  // ── Identifier declarations (naming lexicon, bd tea-rags-mcp-4p3sb.8) ──

  async replaceIdentifiersBulk(entries: readonly IdentifierReplaceEntry[]): Promise<void> {
    await this.call("replaceIdentifiersBulk", { entries: [...entries] });
  }

  async replaceTypeDeclarationsBulk(entries: readonly TypeDeclarationReplaceEntry[]): Promise<void> {
    await this.call("replaceTypeDeclarationsBulk", { entries: [...entries] });
  }

  async aggregateIdentifiersByType(q: IdentifierTypeAggregateQuery): Promise<IdentifierTypeAggregateRow[]> {
    return (await this.call("aggregateIdentifiersByType", {
      types: [...q.types],
      pathPrefixes: q.pathPrefixes === undefined ? undefined : [...q.pathPrefixes],
      excludePaths: q.excludePaths === undefined ? undefined : [...q.excludePaths],
      languages: q.languages === undefined ? undefined : [...q.languages],
      groupByLanguage: q.groupByLanguage,
      groupByMultiplicity: q.groupByMultiplicity,
      countSameTypeSiblings: q.countSameTypeSiblings,
      countHolders: q.countHolders,
    })) as IdentifierTypeAggregateRow[];
  }

  async aggregateIdentifiersByCallee(q: IdentifierCalleeScopeQuery): Promise<IdentifierCalleeAggregateRow[]> {
    return (await this.call("aggregateIdentifiersByCallee", {
      callees: [...q.callees],
      pathPrefixes: q.pathPrefixes === undefined ? undefined : [...q.pathPrefixes],
      excludePaths: q.excludePaths === undefined ? undefined : [...q.excludePaths],
      languages: q.languages === undefined ? undefined : [...q.languages],
      groupByLanguage: q.groupByLanguage,
      countHolders: q.countHolders,
    })) as IdentifierCalleeAggregateRow[];
  }

  async anchorIdentifierTypes(symbolIds: readonly SymbolId[]): Promise<AnchorIdentifierTypeRow[]> {
    return (await this.call("anchorIdentifierTypes", { symbolIds: [...symbolIds] })) as AnchorIdentifierTypeRow[];
  }

  async identifierNameTypes(
    names: readonly string[],
    excludePaths?: readonly string[],
    languages?: readonly string[],
  ): Promise<IdentifierNameTypeRow[]> {
    return (await this.call("identifierNameTypes", {
      names: [...names],
      excludePaths: excludePaths === undefined ? undefined : [...excludePaths],
      languages: languages === undefined ? undefined : [...languages],
    })) as IdentifierNameTypeRow[];
  }

  async existingSymbolShortNames(
    names: readonly string[],
    excludePaths?: readonly string[],
    languages?: readonly string[],
  ): Promise<string[]> {
    return (await this.call("existingSymbolShortNames", {
      names: [...names],
      excludePaths: excludePaths === undefined ? undefined : [...excludePaths],
      languages: languages === undefined ? undefined : [...languages],
    })) as string[];
  }

  async readMethodHeadWords(q: MethodHeadWordQuery): Promise<MethodHeadWordRow[]> {
    return (await this.call("readMethodHeadWords", { query: q })) as MethodHeadWordRow[];
  }

  async readMethodTailVerbs(q: MethodTailVerbQuery): Promise<MethodTailVerbRow[]> {
    return (await this.call("readMethodTailVerbs", { query: q })) as MethodTailVerbRow[];
  }

  async readMethodNamesMatching(q: MethodNamePatternQuery): Promise<MethodNameRow[]> {
    return (await this.call("readMethodNamesMatching", { query: q })) as MethodNameRow[];
  }

  async countIdentifiers(q: IdentifierTypeScopeQuery): Promise<number> {
    return (await this.call("countIdentifiers", {
      types: [...q.types],
      pathPrefixes: q.pathPrefixes === undefined ? undefined : [...q.pathPrefixes],
      excludePaths: q.excludePaths === undefined ? undefined : [...q.excludePaths],
      languages: q.languages === undefined ? undefined : [...q.languages],
    })) as number;
  }

  async aggregateIdentifiersByName(q: IdentifierNameScopeQuery): Promise<IdentifierNameKindTypeRow[]> {
    return (await this.call("aggregateIdentifiersByName", {
      names: [...q.names],
      pathPrefixes: q.pathPrefixes === undefined ? undefined : [...q.pathPrefixes],
      excludePaths: q.excludePaths === undefined ? undefined : [...q.excludePaths],
      languages: q.languages === undefined ? undefined : [...q.languages],
      groupByLanguage: q.groupByLanguage,
      countHolders: q.countHolders,
    })) as IdentifierNameKindTypeRow[];
  }

  async identifierLanguageCounts(q: IdentifierLanguageCountQuery): Promise<IdentifierLanguageCountRow[]> {
    return (await this.call("identifierLanguageCounts", {
      pathPrefixes: q.pathPrefixes === undefined ? undefined : [...q.pathPrefixes],
      pathSuffixes: q.pathSuffixes === undefined ? undefined : [...q.pathSuffixes],
      excludePaths: q.excludePaths === undefined ? undefined : [...q.excludePaths],
      languages: q.languages === undefined ? undefined : [...q.languages],
    })) as IdentifierLanguageCountRow[];
  }

  async sampleIdentifierShapes(q: IdentifierShapeSampleQuery): Promise<IdentifierShapeSampleRow[]> {
    return (await this.call("sampleIdentifierShapes", {
      limit: q.limit,
      pathPrefixes: q.pathPrefixes === undefined ? undefined : [...q.pathPrefixes],
      excludePaths: q.excludePaths === undefined ? undefined : [...q.excludePaths],
      languages: q.languages === undefined ? undefined : [...q.languages],
      groupByLanguage: q.groupByLanguage,
    })) as IdentifierShapeSampleRow[];
  }

  async readOntologyReportSummary(q: OntologyReportQuery): Promise<OntologyReportSummaryRows> {
    return (await this.call("readOntologyReportSummary", { query: q })) as OntologyReportSummaryRows;
  }

  async readOntologyReportSections(
    q: OntologyReportQuery,
    excludedGenericNames: readonly string[],
  ): Promise<OntologyReportSectionRows> {
    return (await this.call("readOntologyReportSections", {
      query: q,
      excludedGenericNames: [...excludedGenericNames],
    })) as OntologyReportSectionRows;
  }

  async readTypeNameRows(q: TypeNameQuery): Promise<TypeNameRow[]> {
    return (await this.call("readTypeNameRows", { query: q })) as TypeNameRow[];
  }

  async replaceCycles(scope: CycleScope, sccs: readonly (readonly string[])[]): Promise<void> {
    await this.call("replaceCycles", { scope, sccs });
  }

  async replacePageRanks(ranks: ReadonlyMap<string, number>): Promise<void> {
    // A Map cannot JSON-serialise — send entries; the server rebuilds the Map.
    await this.call("replacePageRanks", { ranks: [...ranks.entries()] });
  }

  async checkpoint(): Promise<void> {
    await this.call("checkpoint", {});
  }

  /**
   * Compact the collection's graph file daemon-side (bd tea-rags-mcp-dvzdm). A
   * tolerated legacy op: a daemon that predates it leaves the file as it is.
   */
  async compactStorage(): Promise<CodegraphStorageCompactionOutcome> {
    return this.callTolerated<CodegraphStorageCompactionOutcome>(
      "compactStorage",
      {},
      (result) => result as CodegraphStorageCompactionOutcome,
      () => ({ kind: "skipped", reason: "unsupported" }),
    );
  }

  async rebuildEdgeFileTargetIndex(): Promise<void> {
    await this.call("rebuildEdgeFileTargetIndex", {});
  }

  async recordRunStats(rows: ResolveRunStatsRow[]): Promise<void> {
    await this.call("recordRunStats", { rows });
  }

  async recordFileResolveStats(write: FileResolveStatsWrite): Promise<void> {
    await this.call("recordFileResolveStats", { write });
  }

  /**
   * Delete the superseded version's DuckDB file after the Qdrant alias swap.
   * Concrete daemon method (NOT on the `GraphDbClient` interface) — driven by
   * the force-reindex path once the alias flips readers onto `newVersion`.
   */
  async finalizeReindex(oldVersion: string, newVersion: string): Promise<void> {
    await this.call("finalizeReindex", { oldVersion, newVersion });
  }

  /**
   * Have the daemon's pool remove `target`'s database under its path lease (bd
   * tea-rags-mcp-r4veq): the ops running on its client finish first. Resolves
   * whether the daemon evicted a cached client, or `undefined` when the daemon
   * predates the op and the caller must remove the files itself.
   */
  async removeCollectionDatabase(target: PhysicalCollectionName): Promise<boolean | undefined> {
    return this.callTolerated(
      "removeCollectionDatabase",
      { target },
      (result) => result === true,
      () => undefined,
    );
  }

  /**
   * Have the daemon's pool clone `source` over `target` under both paths'
   * leases (bd tea-rags-mcp-r4veq). Resolves `false` when the daemon predates
   * the op and the caller must copy the files itself.
   */
  async cloneCollectionDatabase(source: PhysicalCollectionName, target: PhysicalCollectionName): Promise<boolean> {
    return this.callTolerated(
      "cloneCollectionDatabase",
      { source, target },
      () => true,
      () => false,
    );
  }

  /**
   * Concrete daemon method (NOT yet on the `GraphDbClient` interface — added in
   * Task 7). Runs SCC + PageRank daemon-side so the heavy graph build stays in
   * the single daemon process.
   */
  async computeAndPersistCyclesAndSignals(): Promise<void> {
    await this.call("computeAndPersistCyclesAndSignals", {});
  }

  /**
   * Record the current signals as the baseline for the next run's drift diff
   * (bd tea-rags-mcp-a2ddb). A tolerated legacy op: a daemon that predates it
   * has not run migration 023 either, so there is no baseline to refresh.
   */
  async refreshSymbolSignalsPrev(): Promise<void> {
    await this.callTolerated(
      "refreshSymbolSignalsPrev",
      {},
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Symbols and files whose derived signals moved since the baseline
   * (bd tea-rags-mcp-a2ddb). A tolerated legacy op: a daemon that predates it
   * answers "nothing moved" — why that and not "everything moved" is recorded
   * on `LEGACY_TOLERATED_OPS`.
   */
  async diffSymbolSignals(): Promise<CodegraphSignalDrift> {
    return this.callTolerated(
      "diffSymbolSignals",
      {},
      (result) => result as CodegraphSignalDrift,
      () => ({ symbols: [], files: [] }),
    );
  }

  // ── reads (proxied over the socket) ──
  // Every read routes through the daemon's own RW connection: DuckDB's RW lock
  // is process-exclusive, so a cross-process READ_ONLY attach throws
  // "Conflicting lock is held" while the daemon holds RW. The daemon being the
  // sole file opener means zero conflict. `streamAdjacency` is the ONE read
  // that stays daemon-internal (below) — its heavy adjacency stream must not
  // cross IPC and is consumed daemon-side by computeAndPersistCyclesAndSignals.

  async getFanIn(relPath: RelPath): Promise<number> {
    return (await this.call("getFanIn", { relPath })) as number;
  }

  async getFanInP95(): Promise<number> {
    return (await this.call("getFanInP95", {})) as number;
  }

  async getFanOut(relPath: RelPath): Promise<number> {
    return (await this.call("getFanOut", { relPath })) as number;
  }

  async getCallers(symbolId: SymbolId): Promise<CallerEdge[]> {
    return (await this.call("getCallers", { symbolId })) as CallerEdge[];
  }

  async getCallees(symbolId: SymbolId): Promise<CalleeEdge[]> {
    return (await this.call("getCallees", { symbolId })) as CalleeEdge[];
  }

  async getAmbiguousCallersByMember(member: string, limit?: number): Promise<AmbiguousCallerSite[]> {
    return (await this.call("getAmbiguousCallersByMember", { member, limit })) as AmbiguousCallerSite[];
  }

  async getCalleeEdges(symbolIds: SymbolId[]): Promise<Map<SymbolId, SymbolId[]>> {
    // The server serialises the `Map<SymbolId, SymbolId[]>` as `[key, value][]`
    // entries (a Map cannot JSON-serialise) — rebuild the Map here.
    const entries = (await this.call("getCalleeEdges", { symbolIds })) as [SymbolId, SymbolId[]][];
    return new Map(entries);
  }

  async getCalleeEdgesScoped(refs: FileScopedSymbolRef[]): Promise<Map<FileScopedSymbolId, FileScopedSymbolRef[]>> {
    // Own op rather than a widened `getCalleeEdges` payload (bd
    // tea-rags-mcp-oxnvl): a daemon from an older build stays running across a
    // rebuild, and reusing the name would hand it a shape it cannot read.
    // Serialised as `[key, value][]` entries — a Map cannot JSON-serialise.
    const entries = (await this.call("getCalleeEdgesScoped", { refs })) as [
      FileScopedSymbolId,
      FileScopedSymbolRef[],
    ][];
    return new Map(entries);
  }

  async getSymbolRelPaths(symbolIds: SymbolId[]): Promise<Map<SymbolId, RelPath[]>> {
    const entries = (await this.call("getSymbolRelPaths", { symbolIds })) as [SymbolId, RelPath[]][];
    return new Map(entries);
  }

  async getCalledByCount(symbolId: SymbolId): Promise<number> {
    return (await this.call("getCalledByCount", { symbolId })) as number;
  }

  async getCallSiteCount(symbolId: SymbolId): Promise<number> {
    return (await this.call("getCallSiteCount", { symbolId })) as number;
  }

  async getChunkSignalsBulk(): Promise<Map<FileScopedSymbolId, ChunkGraphSignals>> {
    // Server serialises the Map as `[key, value][]` entries — rebuild here
    // (same pattern as getCalleeEdges / listAdjacency). The key is the
    // file-scoped composite (bd tea-rags-mcp-xtdkq), so the wire shape is
    // unchanged — one more string, still one flat entry list.
    const entries = (await this.call("getChunkSignalsBulk", {})) as [FileScopedSymbolId, ChunkGraphSignals][];
    return new Map(entries);
  }

  async getSymbolLineRangesBulk(relPaths: readonly RelPath[]): Promise<Map<RelPath, PersistedSymbolLineRanges>> {
    // Server serialises the Map as `[key, value][]` entries — rebuild here. A
    // tolerated legacy op: a daemon that predates it answers "no rows known",
    // which leaves every chunk the heal would place unsettled — no write, never
    // a guessed owner (bd tea-rags-mcp-39xca.2).
    return this.callTolerated(
      "getSymbolLineRangesBulk",
      { relPaths },
      (result) => new Map(result as [RelPath, PersistedSymbolLineRanges][]),
      () => new Map<RelPath, PersistedSymbolLineRanges>(),
    );
  }

  async hasData(): Promise<boolean> {
    return (await this.call("hasData", {})) as boolean;
  }

  async getRunStats(): Promise<ResolveRunStatsRow[]> {
    return (await this.call("getRunStats", {})) as ResolveRunStatsRow[];
  }

  async getEdgeKindDistribution(): Promise<EdgeKindCount[]> {
    return (await this.call("getEdgeKindDistribution", {})) as EdgeKindCount[];
  }

  async listAllSymbols(): Promise<SymbolDefinition[]> {
    return (await this.call("listAllSymbols", {})) as SymbolDefinition[];
  }

  async listPass1Aggregates(scope: Pass1AggregateReadScope): Promise<CodegraphPass1FileAggregates[]> {
    return (await this.call("listPass1Aggregates", { scope })) as CodegraphPass1FileAggregates[];
  }

  async listHierarchyDependencies(scope: Pass1AggregateReadScope): Promise<PersistedHierarchyDescendantDependency[]> {
    return (await this.call("listHierarchyDependencies", { scope })) as PersistedHierarchyDescendantDependency[];
  }

  async invalidateHierarchyDependentsOfDeletedFiles(relPaths: readonly RelPath[]): Promise<void> {
    await this.call("invalidateHierarchyDependentsOfDeletedFiles", { relPaths: [...relPaths] });
  }

  async listFileContentHashes(): Promise<{ relPath: RelPath; contentHash: string | null }[]> {
    return (await this.call("listFileContentHashes", {})) as { relPath: RelPath; contentHash: string | null }[];
  }

  async getTransitiveImpact(relPath: RelPath, maxDepth?: number): Promise<number> {
    return (await this.call("getTransitiveImpact", { relPath, maxDepth })) as number;
  }

  async getFileMetricsBulk(relPaths: readonly RelPath[], maxDepth?: number): Promise<Map<RelPath, FileGraphMetrics>> {
    // Server serialises the Map as `[key, value][]` entries — rebuild here
    // (same pattern as getChunkSignalsBulk / getCalleeEdges). The caller
    // bounds `relPaths`: this array IS the request frame, and the daemon's
    // reply frame carries one entry per root it knows about.
    return this.callTolerated(
      "getFileMetricsBulk",
      { relPaths, maxDepth },
      (result) => new Map(result as [RelPath, FileGraphMetrics][]),
      async () => this.fileMetricsPerFile(relPaths, maxDepth),
    );
  }

  /**
   * Legacy-daemon fallback for `getFileMetricsBulk`, a tolerated legacy op. A
   * pool tolerates a daemon from another build while it advertises every
   * REQUIRED op (pool.ts), so a client from this build can meet a daemon that
   * never heard of the setwise op. Rather than failing the whole finalize pass,
   * walk the same roots through the three per-file reads the op replaces and
   * assemble the identical map: absent means all-zero, so a root with nothing
   * in either direction is left out.
   *
   * Deliberately serialized and deliberately slow — this is the pre-setwise
   * cost, on a path that only has to stay CORRECT until the daemon is
   * restarted from the matching build.
   */
  private async fileMetricsPerFile(
    relPaths: readonly RelPath[],
    maxDepth?: number,
  ): Promise<Map<RelPath, FileGraphMetrics>> {
    const out = new Map<RelPath, FileGraphMetrics>();
    for (const relPath of relPaths) {
      const fanIn = await this.getFanIn(relPath);
      const fanOut = await this.getFanOut(relPath);
      const transitiveImpact = await this.getTransitiveImpact(relPath, maxDepth);
      if (fanIn !== 0 || fanOut !== 0 || transitiveImpact !== 0) {
        out.set(relPath, { fanIn, fanOut, transitiveImpact });
      }
    }
    return out;
  }

  async findCycles(scope: CycleScope, pathPattern?: string): Promise<CycleEntry[]> {
    return (await this.call("findCycles", { scope, pathPattern })) as CycleEntry[];
  }

  async listAdjacency(scope: CycleScope): Promise<Map<string, string[]>> {
    // The server serialises the `Map<string, string[]>` as `[key, value][]`
    // entries (a Map cannot JSON-serialise) — rebuild the Map here.
    const entries = (await this.call("listAdjacency", { scope })) as [string, string[]][];
    return new Map(entries);
  }

  async readFileDependencyGraph(): Promise<FileDependencyGraph> {
    return (await this.call("readFileDependencyGraph", {})) as FileDependencyGraph;
  }

  async readNonPublicMemberEdges(languages: readonly string[]): Promise<NonPublicMemberEdge[]> {
    return (await this.call("readNonPublicMemberEdges", { languages: [...languages] })) as NonPublicMemberEdge[];
  }

  async replaceTemporalCochange(snapshot: TemporalCochangeSnapshot): Promise<void> {
    await this.call("replaceTemporalCochange", { snapshot });
  }

  async replaceTemporalSymbolCommits(files: TemporalSymbolCommitFileSnapshot[]): Promise<void> {
    await this.call("replaceTemporalSymbolCommits", { files });
  }

  async deleteTemporalSymbolCommitFiles(relPaths: string[]): Promise<void> {
    await this.call("deleteTemporalSymbolCommitFiles", { relPaths: [...relPaths] });
  }

  async storedTemporalSymbolCommitFilePaths(): Promise<string[]> {
    return (await this.call("storedTemporalSymbolCommitFilePaths", {})) as string[];
  }

  async readTemporalSymbolCommits(relPath: string): Promise<TemporalSymbolCommitFileSnapshot> {
    return (await this.call("readTemporalSymbolCommits", { relPath })) as TemporalSymbolCommitFileSnapshot;
  }

  // ── Per-review working-tree file edges (bd tea-rags-mcp-89k7k.1.2) ──
  // REQUIRED ops: an older daemon is restarted at handshake, never asked — a
  // dropped review's edge table must fail loudly, not read as empty.

  async putReviewFileEdges(reviewId: string, edges: readonly ReviewFileEdge[]): Promise<void> {
    await this.call("putReviewFileEdges", { reviewId, edges: [...edges] });
  }

  async dropReviewFileEdges(reviewId: string): Promise<void> {
    await this.call("dropReviewFileEdges", { reviewId });
  }

  async sweepExpiredReviewFileEdges(nowEpochSeconds: number, maxAgeSeconds: number): Promise<string[]> {
    return (await this.call("sweepExpiredReviewFileEdges", {
      nowEpochSeconds,
      maxAgeSeconds,
    })) as string[];
  }

  async readReviewFileEdges(reviewId: string): Promise<ReviewFileEdge[]> {
    return (await this.call("readReviewFileEdges", { reviewId })) as ReviewFileEdge[];
  }

  async readTemporalCochangeMeta(): Promise<TemporalCochangeBuildMeta | null> {
    return (await this.call("readTemporalCochangeMeta", {})) as TemporalCochangeBuildMeta | null;
  }

  async readTemporalCochangeGraph(): Promise<TemporalCochangeGraph> {
    return (await this.call("readTemporalCochangeGraph", {})) as TemporalCochangeGraph;
  }

  async getFileImporters(relPath: RelPath): Promise<FileImportLookup> {
    return (await this.call("getFileImporters", { relPath })) as FileImportLookup;
  }

  async getFileImports(relPath: RelPath): Promise<FileImportLookup> {
    return (await this.call("getFileImports", { relPath })) as FileImportLookup;
  }

  async getPageRank(symbolId: SymbolId, relPath?: RelPath): Promise<number> {
    return (await this.call("getPageRank", relPath === undefined ? { symbolId } : { symbolId, relPath })) as number;
  }

  async getSupertypes(fqName: string): Promise<InheritanceEdge[]> {
    return (await this.call("getSupertypes", { fqName })) as InheritanceEdge[];
  }

  async getSubtypes(fqName: string): Promise<InheritanceEdge[]> {
    return (await this.call("getSubtypes", { fqName })) as InheritanceEdge[];
  }

  async getTransitiveSubtypes(fqName: string): Promise<InheritanceEdge[]> {
    return (await this.call("getTransitiveSubtypes", { fqName })) as InheritanceEdge[];
  }

  async loadHierarchySnapshot(): Promise<HierarchySnapshot> {
    // HierarchySnapshot is plain Records of arrays — JSON-serialisable as-is,
    // no Map rebuild needed (unlike getCalleeEdges / listAdjacency).
    return (await this.call("loadHierarchySnapshot", {})) as HierarchySnapshot;
  }

  // ── daemon-internal (NOT proxied) ──
  // `streamAdjacency` stays daemon-internal: the heavy graph analysis runs
  // inside the daemon (computeAndPersistCyclesAndSignals), so streaming the
  // adjacency over IPC is never correct. Throws on first iteration.

  streamAdjacency(_scope: CycleScope): AsyncIterableIterator<[source: string, target: string, weight?: number]> {
    const error = new UnsupportedDaemonReadError("streamAdjacency");
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next(): Promise<IteratorResult<[source: string, target: string, weight?: number]>> {
        throw error;
      },
    };
  }
}
