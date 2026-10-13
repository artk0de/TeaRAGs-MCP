import type {
  GraphDbClient,
  IdentifierCalleeScopeQuery,
  IdentifierLanguageCountQuery,
  IdentifierNameScopeQuery,
  IdentifierShapeSampleQuery,
  IdentifierTypeAggregateQuery,
  IdentifierTypeScopeQuery,
  Pass1AggregateReadScope,
} from "../../../contracts/types/codegraph-storage.js";
import type {
  BulkFileUpsertEntry,
  BulkSymbolUpsertEntry,
  CycleScope,
  FieldAccessReplaceEntry,
  FileResolveStatsWrite,
  FileScopedSymbolRef,
  GraphEdges,
  GraphFileNode,
  IdentifierReplaceEntry,
  MethodHeadWordQuery,
  MethodNamePatternQuery,
  MethodTailVerbQuery,
  OntologyReportQuery,
  RelPath,
  ResolveRunStatsRow,
  SymbolDefinition,
  SymbolId,
  TemporalCochangeSnapshot,
  TemporalSymbolCommitFileSnapshot,
  TypeDeclarationReplaceEntry,
  TypeNameQuery,
} from "../../../contracts/types/codegraph.js";

/**
 * In daemon mode the `DaemonGraphDbClient` is the SOLE accessor of the DuckDB
 * file (the daemon owns the single RW connection), so it must proxy the ENTIRE
 * `GraphDbClient` surface the codegraph layer touches — every write AND every
 * read — over the socket. The only exception is `streamAdjacency`: the heavy
 * graph analysis runs daemon-side via `computeAndPersistCyclesAndSignals`, so
 * the adjacency stream stays daemon-internal and is never proxied over IPC.
 *
 * `DAEMON_OPS` is the protocol's op list at runtime (bd tea-rags-mcp-39xca.4).
 * `DaemonOp` is derived from it and the daemon's dispatch table
 * (`DAEMON_OP_COMMANDS`) is keyed by `DaemonOp`, so an op cannot exist in one
 * without the other; the client derives its REQUIRED ops from the same list.
 */
export const DAEMON_OPS = [
  "handshake",
  // Graceful drain+exit requested by a client whose build fingerprint differs
  // from the daemon's (bd tea-rags-mcp-ji56r). Handled by the TRANSPORT layer
  // (daemon/entry.ts) — acked first, then the daemon reuses the idle-watcher
  // drain/exit path — so it never reaches the request dispatcher. A drain that
  // would cut another connection's in-flight write is REFUSED instead with a
  // typed `CodegraphDaemonDrainRefusedError` response (bd tea-rags-mcp-zgcmo);
  // retrying belongs to the draining side.
  "shutdown",
  // Liveness probe (bd tea-rags-mcp-f924y): a client with calls pending sends it
  // when the daemon has gone quiet. Any answer proves the daemon alive — even the
  // "unknown daemon op" of a daemon from before the op existed, which is why it
  // is a tolerated legacy op (`LEGACY_TOLERATED_OPS`).
  "ping",
  "finalizeReindex",
  // Path replacers run where the clients are (bd tea-rags-mcp-r4veq): the app
  // process's clear / delete / orphan sweep / purge and footprint clone ask the
  // daemon's pool to do the unlink or publish under its path lease, which
  // drains the ops running on the old client first. Tolerated legacy ops: an
  // older daemon's "unknown op" sends the caller back to its own file path.
  "removeCollectionDatabase",
  "cloneCollectionDatabase",
  // ── writes ──
  "upsertFile",
  "removeFile",
  // Set-based removeFile for a deletion batch (bd tea-rags-mcp-b4drg).
  "removeFiles",
  "removeSymbolsForFile",
  // Derived-table prune on deletion (bd tea-rags-mcp-dy852).
  "pruneDerivedForDeletedFiles",
  // Cone dependents of deleted files (bd tea-rags-mcp-7t2ee).
  "invalidateHierarchyDependentsOfDeletedFiles",
  "upsertSymbols",
  "upsertSymbolsBulk",
  "upsertFilesBulk",
  "updateSymbolChunkIds",
  "updateSymbolChunkIdsBulk",
  "replaceCycles",
  "replacePageRanks",
  // Wholesale rewrite of the temporal co-change sub-graph (bd tea-rags-mcp-x4rpp).
  "replaceTemporalCochange",
  // Per-file symbol-commit rows of the temporal sub-graph (bd tea-rags-mcp-3gz4f).
  "replaceTemporalSymbolCommits",
  "deleteTemporalSymbolCommitFiles",
  "checkpoint",
  "rebuildEdgeFileTargetIndex",
  "recordRunStats",
  // Per-file resolve tallies + language coverage (bd tea-rags-mcp-xpmwg). Its
  // own op rather than a wider `recordRunStats` payload, so a daemon from an
  // older build never receives a params shape it predates.
  "recordFileResolveStats",
  "computeAndPersistCyclesAndSignals",
  // Baseline refresh for the derived-signal drift diff (bd tea-rags-mcp-a2ddb).
  // A WRITE: it replaces both `cg_*_signals_prev` tables in one transaction.
  "refreshSymbolSignalsPrev",
  // Rewrite the collection's graph file without its dead row versions, when
  // enough of it is dead (bd tea-rags-mcp-dvzdm). A WRITE: admitted in write
  // order, and the swap happens inside the daemon, which owns the file.
  "compactStorage",
  // Per-file replace of the naming lexicon's identifier rows (bd
  // tea-rags-mcp-4p3sb.8). REQUIRED: an older daemon is restarted at handshake.
  "replaceIdentifiersBulk",
  // Per-file replace of the naming lexicon's type-declaration rows (bd
  // tea-rags-mcp-vi0wx). REQUIRED: an older daemon is restarted at handshake.
  "replaceTypeDeclarationsBulk",
  // Per-file replace of the field-access edges (bd tea-rags-mcp-zy6hx).
  // REQUIRED: an older daemon is restarted at handshake.
  "replaceFieldAccessesBulk",
  // ── reads (the daemon owns the sole DuckDB connection, so all reads route
  //    through its own RW connection instead of a conflicting cross-process
  //    READ_ONLY attach) ──
  // A consistent copy of the collection's graph at a caller-chosen path (bd
  // tea-rags-mcp-xi2r9): only the daemon can read the rows its WAL holds. A READ
  // of the collection — the live file is untouched. Tolerated legacy op: an
  // older daemon's "unknown op" becomes a typed refusal, not a drain.
  "exportSnapshot",
  "getFanIn",
  "getFanInP95",
  "getFanOut",
  "getCallers",
  "getCallees",
  "getAmbiguousCallersByMember",
  "getCalleeEdges",
  "getCalleeEdgesScoped",
  "getSymbolRelPaths",
  "getCalledByCount",
  "getCallSiteCount",
  "getChunkSignalsBulk",
  "hasData",
  "getRunStats",
  "getEdgeKindDistribution",
  "listAllSymbols",
  "listPass1Aggregates",
  // Hierarchy dependencies read at the barrier (bd tea-rags-mcp-7t2ee). REQUIRED:
  // an empty answer would read as "no caller depends on any cone".
  "listHierarchyDependencies",
  "listFileContentHashes",
  "getTransitiveImpact",
  "getFileMetricsBulk",
  "findCycles",
  "listAdjacency",
  // Whole file dependency graph for the architecture report (bd tea-rags-mcp-94hd9).
  // REQUIRED, not legacy-tolerated: an empty graph would read as "no violations".
  "readFileDependencyGraph",
  // Method edges into non-public members for the convention-privacy check
  // (bd tea-rags-mcp-r8hme.1). REQUIRED, not legacy-tolerated: an empty answer
  // would read as "no convention-privacy leaks".
  "readNonPublicMemberEdges",
  // Temporal co-change sub-graph (bd tea-rags-mcp-x4rpp): the provenance row the
  // builder compares against HEAD, and the pair set the silent-coupling detector
  // judges (bd tea-rags-mcp-b4dcz). REQUIRED, not legacy-tolerated: an empty
  // graph would read as "no silent coupling".
  "readTemporalCochangeMeta",
  "readTemporalCochangeGraph",
  // The admitted bundles' file memberships (bd tea-rags-mcp-c3v6o) — the
  // split/merge verdicts' component-level counts. REQUIRED likewise: an older
  // daemon's empty map would read as "nothing changes together".
  "readTemporalBundleFiles",
  // Symbol-commit rows of the temporal sub-graph (bd tea-rags-mcp-3gz4f): the
  // stored-file universe the flush hook prunes gone files against, and one
  // file's slice. REQUIRED, not legacy-tolerated: an empty answer would read
  // as "no symbol co-change data".
  "storedTemporalSymbolCommitFilePaths",
  "readTemporalSymbolCommits",
  // One file's importers / imports for file-scope get_callers / get_callees
  // (bd tea-rags-mcp-gfvr8). REQUIRED, not legacy-tolerated: an empty answer
  // would read as "nothing imports this file".
  "getFileImporters",
  "getFileImports",
  "hasStaleDerivedTables",
  "getPageRank",
  "findSymbolChunk",
  // Declared visibility of a batch of symbols for the graph tools and the
  // find_symbol outline (bd tea-rags-mcp-sqqkz). REQUIRED like getFileImporters:
  // a daemon from an older build is restarted at handshake, not asked blindly.
  "getSymbolVisibilities",
  // Per-file symbol line ranges for the payload healer's chunk-owner rule
  // (bd tea-rags-mcp-9i2ow). Its own op, so a daemon from an older build answers
  // "unknown daemon op" — a tolerated legacy op, see `LEGACY_TOLERATED_OPS`.
  "getSymbolLineRangesBulk",
  // Read half of the drift pair (bd tea-rags-mcp-a2ddb). Plain arrays on the
  // wire — no Map, so no entries() dance on either side.
  "diffSymbolSignals",
  // Naming-lexicon reads over cg_identifiers (bd tea-rags-mcp-4p3sb.8). REQUIRED
  // like getSymbolVisibilities: an empty answer would read as "no such names".
  "aggregateIdentifiersByType",
  "aggregateIdentifiersByCallee",
  "anchorIdentifierTypes",
  "identifierNameTypes",
  "existingSymbolShortNames",
  // Method-name reads over cg_symbols (naming coverage for untyped methods).
  // REQUIRED: an older daemon's empty answer would read as a project with no methods.
  "readMethodHeadWords",
  "readMethodTailVerbs",
  "readMethodNamesMatching",
  "countIdentifiers",
  "aggregateIdentifiersByName",
  "identifierLanguageCounts",
  "sampleIdentifierShapes",
  // Ontology audit over cg_identifiers (bd tea-rags-mcp-4p3sb.20). REQUIRED for
  // the same reason: an older daemon's empty answer would read as a clean project.
  // Two phases: the summary's generic candidates, judged by the caller, become
  // the sections read's `excludedGenericNames`.
  "readOntologyReportSummary",
  "readOntologyReportSections",
  // Type-level cg_symbols rows + ancestors for type roles (bd tea-rags-mcp-vi0wx).
  // REQUIRED: an older daemon's empty answer would read as a project with no roles.
  "readTypeNameRows",
  // Field-access edges per method / per file (bd tea-rags-mcp-zy6hx). REQUIRED:
  // an older daemon's empty answer would read as methods touching no field.
  "readFieldAccessesBySymbols",
  "readFieldAccessesByFiles",
  // ── class hierarchy (bd tea-rags-mcp-f10y) ──
  "getSupertypes",
  "getSubtypes",
  "getTransitiveSubtypes",
  "loadHierarchySnapshot",
] as const;

export type DaemonOp = (typeof DAEMON_OPS)[number];

/**
 * Ops that act on the daemon or a collection's files, not on the graph store:
 * the only ops that are NOT a `GraphDbClient` member (bd
 * tea-rags-mcp-89k7k.35.6).
 */
export const DAEMON_LIFECYCLE_OPS = [
  "handshake",
  "shutdown",
  "ping",
  "finalizeReindex",
  "removeCollectionDatabase",
  "cloneCollectionDatabase",
] as const satisfies readonly DaemonOp[];

export type DaemonLifecycleOp = (typeof DAEMON_LIFECYCLE_OPS)[number];

/**
 * `GraphDbClient` members that deliberately have no daemon op, each with the
 * reason. Every other member must be a `DaemonOp` of the same name — see
 * {@link DaemonOpSurfaceCoversGraphDbClient}.
 */
export const DAEMON_UNPROXIED_GRAPH_DB_CLIENT_MEMBERS = {
  init: "connection lifecycle: the daemon client opens its own socket (DaemonConnectionLifecycle#init)",
  close: "connection lifecycle: the daemon client closes its own socket; the daemon owns the store's lifetime",
  streamAdjacency:
    "daemon-internal: graph analysis runs daemon-side (computeAndPersistCyclesAndSignals), so the stream never crosses IPC",
} as const satisfies Partial<Record<keyof GraphDbClient, string>>;

export type DaemonUnproxiedGraphDbClientMember = keyof typeof DAEMON_UNPROXIED_GRAPH_DB_CLIENT_MEMBERS;

/** Members of `Client` that neither ride a daemon op nor are a named exclusion; `never` = covered. */
export type GraphDbClientMembersWithoutDaemonOp<Client> = Exclude<
  keyof Client,
  DaemonOp | DaemonUnproxiedGraphDbClientMember
>;

/** Graph ops with no `Client` member of the same name; `never` = every graph op proxies a member. */
export type DaemonOpsWithoutGraphDbClientMember<Client> = Exclude<DaemonOp, keyof Client | DaemonLifecycleOp>;

/** Instantiating it with any element but `never` is a compile error naming the offending keys. */
type AssertNoDaemonOpSurfaceGaps<Gaps extends readonly never[]> = Gaps;

/**
 * Compile-time guard: adding a `GraphDbClient` member without its `DAEMON_OPS`
 * entry (or an exclusion above), or an op without a member, fails `tsc` here.
 */
export type DaemonOpSurfaceCoversGraphDbClient = AssertNoDaemonOpSurfaceGaps<
  [GraphDbClientMembersWithoutDaemonOp<GraphDbClient>, DaemonOpsWithoutGraphDbClientMember<GraphDbClient>]
>;

/** An op that sends nothing but the collection. */
type NoDaemonOpParams = Record<never, never>;

/**
 * The wire params of every op, minus the `collection` every request carries
 * (the client adds it). The client's `call` and the request type read it, so
 * the op→params mapping is a type, not a comment.
 */
export interface DaemonOpParamsMap {
  // ── daemon lifecycle ──
  handshake: { buildFingerprint?: string }; // absent on legacy peers
  shutdown: NoDaemonOpParams;
  ping: NoDaemonOpParams;
  finalizeReindex: { oldVersion: string; newVersion: string };
  removeCollectionDatabase: { target: string };
  cloneCollectionDatabase: { source: string; target: string };
  // ── writes ──
  upsertFile: { node: GraphFileNode; edges: GraphEdges };
  removeFile: { relPath: RelPath };
  removeFiles: { relPaths: RelPath[] };
  removeSymbolsForFile: { relPath: RelPath };
  pruneDerivedForDeletedFiles: { relPaths: RelPath[] };
  invalidateHierarchyDependentsOfDeletedFiles: { relPaths: RelPath[] };
  upsertSymbols: { relPath: RelPath; definitions: SymbolDefinition[] };
  upsertSymbolsBulk: { entries: BulkSymbolUpsertEntry[] };
  upsertFilesBulk: { entries: readonly BulkFileUpsertEntry[] };
  updateSymbolChunkIds: { relPath: RelPath; chunkIds: [string, string][] };
  updateSymbolChunkIdsBulk: { entries: { relPath: RelPath; chunkIds: [string, string][] }[] };
  replaceCycles: { scope: CycleScope; sccs: readonly (readonly string[])[] };
  replacePageRanks: { ranks: [string, number][] };
  replaceTemporalCochange: { snapshot: TemporalCochangeSnapshot };
  replaceTemporalSymbolCommits: { files: TemporalSymbolCommitFileSnapshot[] };
  deleteTemporalSymbolCommitFiles: { relPaths: RelPath[] };
  checkpoint: NoDaemonOpParams;
  rebuildEdgeFileTargetIndex: NoDaemonOpParams;
  recordRunStats: { rows: ResolveRunStatsRow[] };
  recordFileResolveStats: { write: FileResolveStatsWrite };
  computeAndPersistCyclesAndSignals: NoDaemonOpParams;
  refreshSymbolSignalsPrev: NoDaemonOpParams;
  compactStorage: NoDaemonOpParams;
  replaceIdentifiersBulk: { entries: IdentifierReplaceEntry[] };
  replaceTypeDeclarationsBulk: { entries: TypeDeclarationReplaceEntry[] };
  replaceFieldAccessesBulk: { entries: FieldAccessReplaceEntry[] };
  // ── reads ──
  exportSnapshot: { targetPath: string };
  getFanIn: { relPath: RelPath };
  getFanInP95: NoDaemonOpParams;
  getFanOut: { relPath: RelPath };
  getCallers: { symbolId: SymbolId };
  getCallees: { symbolId: SymbolId };
  getAmbiguousCallersByMember: { member: string; limit?: number };
  getCalleeEdges: { symbolIds: SymbolId[] };
  getCalleeEdgesScoped: { refs: FileScopedSymbolRef[] };
  getSymbolRelPaths: { symbolIds: SymbolId[] };
  getCalledByCount: { symbolId: SymbolId };
  getCallSiteCount: { symbolId: SymbolId };
  getChunkSignalsBulk: NoDaemonOpParams;
  hasData: NoDaemonOpParams;
  getRunStats: NoDaemonOpParams;
  getEdgeKindDistribution: NoDaemonOpParams;
  listAllSymbols: NoDaemonOpParams;
  listPass1Aggregates: { scope: Pass1AggregateReadScope };
  listHierarchyDependencies: { scope: Pass1AggregateReadScope };
  listFileContentHashes: NoDaemonOpParams;
  getTransitiveImpact: { relPath: RelPath; maxDepth?: number };
  getFileMetricsBulk: { relPaths: readonly RelPath[]; maxDepth?: number };
  findCycles: { scope: CycleScope; pathPattern?: string };
  listAdjacency: { scope: CycleScope };
  readFileDependencyGraph: NoDaemonOpParams;
  readNonPublicMemberEdges: { languages: string[] };
  readTemporalCochangeMeta: NoDaemonOpParams;
  readTemporalCochangeGraph: NoDaemonOpParams;
  readTemporalBundleFiles: NoDaemonOpParams;
  storedTemporalSymbolCommitFilePaths: NoDaemonOpParams;
  readTemporalSymbolCommits: { relPath: string };
  getFileImporters: { relPath: RelPath };
  getFileImports: { relPath: RelPath };
  hasStaleDerivedTables: NoDaemonOpParams;
  getPageRank: { symbolId: SymbolId; relPath?: RelPath };
  findSymbolChunk: { symbolId: SymbolId };
  getSymbolVisibilities: { symbolIds: SymbolId[] };
  getSymbolLineRangesBulk: { relPaths: readonly RelPath[] };
  diffSymbolSignals: NoDaemonOpParams;
  aggregateIdentifiersByType: IdentifierTypeAggregateQuery;
  aggregateIdentifiersByCallee: IdentifierCalleeScopeQuery;
  anchorIdentifierTypes: { symbolIds: SymbolId[] };
  identifierNameTypes: { names: string[]; excludePaths?: string[]; languages?: string[] };
  existingSymbolShortNames: { names: string[]; excludePaths?: string[]; languages?: string[] };
  readMethodHeadWords: { query: MethodHeadWordQuery };
  readMethodTailVerbs: { query: MethodTailVerbQuery };
  readMethodNamesMatching: { query: MethodNamePatternQuery };
  countIdentifiers: IdentifierTypeScopeQuery;
  aggregateIdentifiersByName: IdentifierNameScopeQuery;
  identifierLanguageCounts: IdentifierLanguageCountQuery;
  sampleIdentifierShapes: IdentifierShapeSampleQuery;
  readOntologyReportSummary: { query: OntologyReportQuery };
  readOntologyReportSections: { query: OntologyReportQuery; excludedGenericNames: string[] };
  readTypeNameRows: { query: TypeNameQuery };
  readFieldAccessesBySymbols: { symbolIds: SymbolId[] };
  readFieldAccessesByFiles: { relPaths: RelPath[] };
  getSupertypes: { fqName: string };
  getSubtypes: { fqName: string };
  getTransitiveSubtypes: { fqName: string };
  loadHierarchySnapshot: NoDaemonOpParams;
}

/** Compile-time guard: `DaemonOpParamsMap` has exactly the `DaemonOp` keys. */
export type DaemonOpParamsMapCoversDaemonOps = AssertNoDaemonOpSurfaceGaps<
  [Exclude<DaemonOp, keyof DaemonOpParamsMap>, Exclude<keyof DaemonOpParamsMap, DaemonOp>]
>;

/** One op's full request params: its wire shape plus the collection. */
export type DaemonRequestParams<Op extends DaemonOp> = { collection: string } & DaemonOpParamsMap[Op];

export interface DaemonRequest {
  id: number;
  op: DaemonOp;
  params: DaemonRequestParams<DaemonOp>;
}

/**
 * `handshake` op result. A legacy daemon (pre-fingerprint build) returns null
 * instead — the client treats a missing fingerprint as "no restart".
 */
export interface DaemonHandshakeResult {
  buildFingerprint?: string;
  /**
   * Every op the daemon's dispatch table serves (bd tea-rags-mcp-39xca.4) — read
   * from the table the server actually dispatches on, so a daemon advertises
   * what it can answer, not what the protocol names. Plain strings: a newer
   * daemon may serve ops this client has never heard of. Absent on a daemon
   * that predates capability advertisement.
   */
  supportedOps?: readonly string[];
}

/**
 * An error as it crosses the socket. `dbPath` and `cause` are set only for a
 * `DuckDbOpenFailedError`, so the client can rebuild that class — code, hint and
 * `lockContention` — instead of a nameless `Error` (bd tea-rags-mcp-zgg62).
 */
export interface DaemonWireError {
  name: string;
  message: string;
  dbPath?: string;
  cause?: string;
  /**
   * Set only for a `CodegraphDatabaseHeldByForeignDaemonError`: the other
   * build's daemon holding the file, so the client rebuilds that class (bd
   * tea-rags-mcp-hw27k).
   */
  holder?: { pid: number; buildDir: string; buildFingerprint: string | undefined };
}

export type DaemonResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: DaemonWireError };

/** One JSON object per line. `\n` is the frame delimiter (JSON.stringify never emits a raw newline). */
export function encodeFrame(msg: DaemonRequest | DaemonResponse): string {
  return `${JSON.stringify(msg)}\n`;
}

/** Split a buffer on newlines; return complete frames and the partial trailing `rest`. */
export function decodeFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { frames: parts.filter((p) => p.length > 0), rest };
}
