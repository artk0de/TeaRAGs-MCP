// The storage surface (`GraphDbClient` and its call shapes) is imported from
// its OWNER, not the codegraph barrel — the barrel's own contract: "import a
// sibling directly when you want the narrow surface". Declares the coupling
// the daemon's dispatch table has with codegraph-storage.ts
// (bd tea-rags-mcp-89k7k.25).
import type { GraphDbClient } from "../../../contracts/types/codegraph-storage.js";
import { physicalCollectionNameFromDaemonRequest } from "../../../primitives/ids/index.js";
import type { GraphDbClientPool } from "../pool.js";
import { computeAndPersistCyclesAndSignals } from "./graph-analysis.js";
import type { DaemonHandshakeResult, DaemonOp, DaemonRequestParams } from "./protocol.js";

/**
 * A request's params as they come off the wire, untyped. The loose
 * `DaemonOpCommandTable` (tests, stand-in servers, the dispatcher) sees them
 * this way; the production table is DEFINED over each op's typed
 * `DaemonRequestParams<Op>` (`DaemonOpCommandDefinitions`).
 */
type DaemonOpParams = Record<string, unknown>;

/**
 * Everything a command needs that is NOT a pooled `graphDb`: the pool itself
 * (collection lifecycle) and the daemon's build identity (handshake).
 */
export interface DaemonOpContext {
  readonly pool: GraphDbClientPool;
  readonly buildFingerprint: string;
  /**
   * The ops the serving daemon's dispatch table holds, advertised in the
   * handshake (bd tea-rags-mcp-39xca.4). Supplied by the server from the table
   * it dispatches on — never re-derived here — so a trimmed table advertises a
   * trimmed list.
   */
  readonly supportedOps: readonly DaemonOp[];
}

/**
 * One entry of the daemon's protocol surface. `access` is data, not control
 * flow, so the dispatcher — not each op — decides how the handle is acquired:
 *
 * - `write` — pooled handle + memory-governor notification (write-burst scoped)
 * - `read`  — pooled handle, no governor (the daemon owns the sole connection,
 *             so reads route through its own RW connection too)
 * - `daemon` — no handle at all; the op acts on the daemon itself
 */
export type DaemonOpCommand = DaemonOpCommandOf<DaemonOpParams>;

/**
 * The command shape for params type `P`: loose (`DaemonOpParams`) for the
 * dispatcher and stand-in tables, one op's `DaemonRequestParams<Op>` for a
 * definition.
 */
export type DaemonOpCommandOf<P> =
  | {
      readonly access: "read" | "write";
      /**
       * `signal` aborts once the requesting connection closes (bd
       * tea-rags-mcp-f924y). Only an op long enough to be worth stopping
       * midway reads it; the server itself drops a write that has not started.
       */
      readonly run: (graphDb: GraphDbClient, p: P, signal?: AbortSignal) => Promise<unknown>;
    }
  | {
      readonly access: "daemon";
      /**
       * Whether the op changes what the daemon holds on the caller's behalf —
       * a collection's files, or the daemon's own lifecycle. `read`/`write`
       * say it for the graph ops; a daemon op states it here, so
       * `isDaemonWriteOp` covers every op from this one table.
       */
      readonly mutates: boolean;
      readonly run: (ctx: DaemonOpContext, p: P) => Promise<unknown>;
    };

/** One op's command, its `run` receiving that op's typed request params. */
export type DaemonOpCommandFor<Op extends DaemonOp> = DaemonOpCommandOf<DaemonRequestParams<Op>>;

/**
 * A dispatch table a `CodegraphDaemonServer` serves. Partial because a daemon
 * standing in for an older build (tests) serves a subset; production passes the
 * complete `DAEMON_OP_COMMANDS`.
 */
export type DaemonOpCommandTable = Readonly<Partial<Record<DaemonOp, DaemonOpCommand>>>;

/**
 * The production dispatch table's type: one command for EVERY `DaemonOp`, no
 * `Partial` — an op without a command is a compile error (bd
 * tea-rags-mcp-89k7k.35.6). `DaemonOp` itself is held to `GraphDbClient` by
 * `DaemonOpSurfaceCoversGraphDbClient` (protocol.ts).
 */
export type DaemonOpCommandsByOp = Readonly<Record<DaemonOp, DaemonOpCommand>>;

/**
 * The table as it is AUTHORED: one command per `DaemonOp`, each `run`
 * receiving THAT op's `DaemonRequestParams<Op>` - an entry reading a param its
 * op does not declare is a compile error (bd tea-rags-mcp-89k7k.35.9). The
 * mapped key is what correlates a command with its op; the dispatcher cannot
 * (it looks the op up at runtime), which is why `DAEMON_OP_COMMANDS` widens
 * this type once, below.
 */
export type DaemonOpCommandDefinitions = { readonly [Op in DaemonOp]: DaemonOpCommandFor<Op> };

/** A write op: governed handle, and the wire result is always a `null` ack. */
function write<Op extends DaemonOp>(
  run: (graphDb: GraphDbClient, p: DaemonRequestParams<Op>, signal?: AbortSignal) => Promise<void>,
): DaemonOpCommandFor<Op> {
  return {
    access: "write",
    run: async (graphDb, p, signal) => {
      await run(graphDb, p, signal);
      return null;
    },
  };
}

/** A read op: pooled handle, result forwarded to the client as-is. */
function read<Op extends DaemonOp>(
  run: (graphDb: GraphDbClient, p: DaemonRequestParams<Op>) => Promise<unknown>,
): DaemonOpCommandFor<Op> {
  return { access: "read", run };
}

/**
 * The daemon's protocol surface, one entry per `DaemonOp`. Keyed by
 * `Record<DaemonOp, …>` on purpose: adding an op to the protocol union without
 * a command here is a compile error, and the table is greppable/enumerable in
 * a way the 200-line switch it replaced was not.
 */
const DAEMON_OP_COMMAND_DEFINITIONS: DaemonOpCommandDefinitions = {
  handshake: {
    access: "daemon",
    // Opens + migrates only for a client of THIS daemon's build — the daemon's
    // own code at work; the caller supplies a fingerprint, no data. A client
    // from another build leaves the store untouched.
    mutates: false,
    run: async (ctx, p) => {
      const clientFingerprint = p.buildFingerprint;
      // A client from a DIFFERENT build may be about to drain-restart this
      // daemon — do NOT open/migrate the DB with code that may be the stale
      // side. It may equally proceed against this daemon instead: a client
      // that predates the on-disk build this daemon runs (bd
      // tea-rags-mcp-1wr7p), or a pool without a respawn hook. Such a client
      // relies on the lazy `pool.acquire` that `CodegraphDaemonServer#handle`
      // runs for every read/write op, so its first op opens + migrates with
      // THIS daemon's code. Legacy clients (no
      // fingerprint) keep the original open-on-handshake path.
      if (clientFingerprint === undefined || clientFingerprint === ctx.buildFingerprint) {
        await ctx.pool.acquire(physicalCollectionNameFromDaemonRequest(p.collection)); // opens + migrates + hydrates
      }
      // Capabilities ride every handshake, matched or not: a client from another
      // build decides from them whether it may proceed (bd tea-rags-mcp-39xca.4).
      return {
        buildFingerprint: ctx.buildFingerprint,
        supportedOps: ctx.supportedOps,
      } satisfies DaemonHandshakeResult;
    },
  },
  shutdown: {
    access: "daemon",
    // Drains the daemon every session on the machine shares.
    mutates: true,
    // Transport-level op: daemon/entry.ts acks it and reuses the
    // idle-watcher drain/exit path. Reaching the dispatcher means the
    // transport interception is miswired — a caller bug, not a user error.
    run: async () => {
      throw new Error("shutdown is handled by the daemon transport (entry.ts), not the request dispatcher");
    },
  },
  // Liveness probe (bd tea-rags-mcp-f924y). Touches nothing: the answer itself
  // is the proof that the daemon's event loop is running.
  ping: {
    access: "daemon",
    mutates: false,
    run: async () => null,
  },
  finalizeReindex: {
    access: "daemon",
    // Deletes a collection's DuckDB file.
    mutates: true,
    // The Qdrant alias swap (adapters/qdrant/aliases.ts:switchAlias) has
    // already flipped readers onto newVersion; delete the superseded
    // oldVersion DuckDB file (+ WAL sidecar) so it does not outlive the
    // collection it shadowed. `removeCollection` closes any pooled handle
    // first, then unlinks the file — crash-safe: old stays intact until swap.
    run: async (ctx, p) => {
      await ctx.pool.removeCollection(physicalCollectionNameFromDaemonRequest(p.oldVersion));
      return null;
    },
  },
  // In-process path replacement for a caller outside the daemon (bd
  // tea-rags-mcp-r4veq): the daemon's pool holds the clients, so only its path
  // lease can drain the ops running on the old one before the file changes.
  // Never routed through `runCollectionOp` — an op pinned to the client it is
  // about to drain would wait for itself.
  removeCollectionDatabase: {
    access: "daemon",
    // Deletes a collection's DuckDB file.
    mutates: true,
    run: async (ctx, p) => ctx.pool.removeCollection(physicalCollectionNameFromDaemonRequest(p.target)),
  },
  cloneCollectionDatabase: {
    access: "daemon",
    // Publishes a collection's DuckDB file over the target path.
    mutates: true,
    run: async (ctx, p) => {
      await ctx.pool.cloneDatabase(
        physicalCollectionNameFromDaemonRequest(p.source),
        physicalCollectionNameFromDaemonRequest(p.target),
      );
      return null;
    },
  },

  // ── writes ──
  upsertFile: write(async (graphDb, p) => graphDb.upsertFile(p.node, p.edges)),
  removeFile: write(async (graphDb, p) => graphDb.removeFile(p.relPath)),
  removeFiles: write(async (graphDb, p) => graphDb.removeFiles(p.relPaths)),
  removeSymbolsForFile: write(async (graphDb, p) => graphDb.removeSymbolsForFile(p.relPath)),
  invalidateHierarchyDependentsOfDeletedFiles: write(async (graphDb, p) =>
    graphDb.invalidateHierarchyDependentsOfDeletedFiles(p.relPaths),
  ),
  pruneDerivedForDeletedFiles: write(async (graphDb, p) => graphDb.pruneDerivedForDeletedFiles(p.relPaths)),
  upsertSymbols: write(async (graphDb, p) => graphDb.upsertSymbols(p.relPath, p.definitions)),
  upsertSymbolsBulk: write(async (graphDb, p) => graphDb.upsertSymbolsBulk(p.entries)),
  upsertFilesBulk: write(async (graphDb, p) => graphDb.upsertFilesBulk(p.entries)),
  // entries → Map (mirrors replacePageRanks rebuild).
  updateSymbolChunkIds: write(async (graphDb, p) => graphDb.updateSymbolChunkIds(p.relPath, new Map(p.chunkIds))),
  // Same entries → Map rebuild, once per file in the pass.
  updateSymbolChunkIdsBulk: write(async (graphDb, p) =>
    graphDb.updateSymbolChunkIdsBulk(
      p.entries.map((e) => ({
        relPath: e.relPath,
        chunkIds: new Map(e.chunkIds),
      })),
    ),
  ),
  replaceCycles: write(async (graphDb, p) => graphDb.replaceCycles(p.scope, p.sccs)),
  // Ranks ride the wire as `[symbolId, rank][]` entries (a Map cannot
  // JSON-serialise) — rebuild the Map before delegating to the adapter.
  replacePageRanks: write(async (graphDb, p) => graphDb.replacePageRanks(new Map(p.ranks))),
  // Plain arrays on the wire — the snapshot is JSON-shaped already.
  replaceTemporalCochange: write(async (graphDb, p) => graphDb.replaceTemporalCochange(p.snapshot)),
  // Per-file symbol-commit rows (bd tea-rags-mcp-3gz4f); JSON-shaped on the wire.
  replaceTemporalSymbolCommits: write(async (graphDb, p) => graphDb.replaceTemporalSymbolCommits(p.files)),
  deleteTemporalSymbolCommitFiles: write(async (graphDb, p) =>
    graphDb.deleteTemporalSymbolCommitFiles([...p.relPaths]),
  ),
  checkpoint: write(async (graphDb) => graphDb.checkpoint()),
  rebuildEdgeFileTargetIndex: write(async (graphDb) => graphDb.rebuildEdgeFileTargetIndex()),
  recordRunStats: write(async (graphDb, p) => graphDb.recordRunStats(p.rows)),
  recordFileResolveStats: write(async (graphDb, p) => graphDb.recordFileResolveStats(p.write)),
  computeAndPersistCyclesAndSignals: write(async (graphDb, _p, signal) =>
    computeAndPersistCyclesAndSignals(graphDb, signal),
  ),
  // bd tea-rags-mcp-a2ddb — the baseline the next run's drift diff reads. A
  // write, so it goes through the governed handle like every other one.
  refreshSymbolSignalsPrev: write(async (graphDb) => graphDb.refreshSymbolSignalsPrev()),
  // bd tea-rags-mcp-dvzdm — a write (admitted in order, governed) that answers
  // with its outcome instead of the `null` ack, so the run can log what it did.
  // The file swap happens inside the pooled client's session: the pool entry,
  // its symbol table and every socket stay as they are.
  compactStorage: { access: "write", run: async (graphDb) => graphDb.compactStorage() },
  // bd tea-rags-mcp-4p3sb.8 — the naming lexicon's per-file identifier rows.
  replaceIdentifiersBulk: write(async (graphDb, p) => graphDb.replaceIdentifiersBulk(p.entries)),
  // bd tea-rags-mcp-vi0wx — the naming lexicon's per-file type-declaration rows.
  replaceTypeDeclarationsBulk: write(async (graphDb, p) => graphDb.replaceTypeDeclarationsBulk(p.entries)),
  // bd tea-rags-mcp-zy6hx — the per-file field-access edges.
  replaceFieldAccessesBulk: write(async (graphDb, p) => graphDb.replaceFieldAccessesBulk(p.entries)),

  // ── full-proxy reads (the daemon owns the sole DuckDB connection, so
  //    every read routes through its own RW connection) ──
  // bd tea-rags-mcp-xi2r9 — a READ of the collection: the snapshot is copied
  // through the pooled client's session, which leaves the live file as it was,
  // so a client that may only read (1wr7p) may still ask for it.
  exportSnapshot: read(async (graphDb, p) => graphDb.exportSnapshot(p.targetPath)),
  getFanIn: read(async (graphDb, p) => graphDb.getFanIn(p.relPath)),
  getFanInP95: read(async (graphDb) => graphDb.getFanInP95()),
  getFanOut: read(async (graphDb, p) => graphDb.getFanOut(p.relPath)),
  getCallers: read(async (graphDb, p) => graphDb.getCallers(p.symbolId)),
  getAmbiguousCallersByMember: read(async (graphDb, p) => graphDb.getAmbiguousCallersByMember(p.member, p.limit)),
  findSymbolChunk: read(async (graphDb, p) => graphDb.findSymbolChunk(p.symbolId)),
  getSymbolVisibilities: read(async (graphDb, p) => graphDb.getSymbolVisibilities(p.symbolIds)),
  // Naming-lexicon reads over cg_identifiers (bd tea-rags-mcp-4p3sb.8).
  aggregateIdentifiersByType: read(async (graphDb, p) =>
    graphDb.aggregateIdentifiersByType({
      types: p.types,
      pathPrefixes: p.pathPrefixes,
      excludePaths: p.excludePaths,
      languages: p.languages,
      groupByLanguage: p.groupByLanguage,
      groupByMultiplicity: p.groupByMultiplicity,
      countSameTypeSiblings: p.countSameTypeSiblings,
      countHolders: p.countHolders,
      groupByOwnerKind: p.groupByOwnerKind,
    }),
  ),
  aggregateIdentifiersByCallee: read(async (graphDb, p) =>
    graphDb.aggregateIdentifiersByCallee({
      callees: p.callees,
      pathPrefixes: p.pathPrefixes,
      excludePaths: p.excludePaths,
      languages: p.languages,
      groupByLanguage: p.groupByLanguage,
      countHolders: p.countHolders,
    }),
  ),
  anchorIdentifierTypes: read(async (graphDb, p) => graphDb.anchorIdentifierTypes(p.symbolIds)),
  // The language scope travels only when set: an unscoped call keeps its two-argument shape.
  identifierNameTypes: read(async (graphDb, p) =>
    graphDb.identifierNameTypes(p.names, p.excludePaths, ...(p.languages === undefined ? [] : [p.languages])),
  ),
  existingSymbolShortNames: read(async (graphDb, p) =>
    graphDb.existingSymbolShortNames(p.names, p.excludePaths, ...(p.languages === undefined ? [] : [p.languages])),
  ),
  // Method-name reads over cg_symbols: the query carries the non-production masks, so it travels whole.
  readMethodHeadWords: read(async (graphDb, p) => graphDb.readMethodHeadWords(p.query)),
  readMethodTailVerbs: read(async (graphDb, p) => graphDb.readMethodTailVerbs(p.query)),
  readMethodNamesMatching: read(async (graphDb, p) => graphDb.readMethodNamesMatching(p.query)),
  countIdentifiers: read(async (graphDb, p) =>
    graphDb.countIdentifiers({
      types: p.types,
      pathPrefixes: p.pathPrefixes,
      excludePaths: p.excludePaths,
      languages: p.languages,
    }),
  ),
  // Naming-lexicon scope reads (bd tea-rags-mcp-4p3sb.11).
  aggregateIdentifiersByName: read(async (graphDb, p) =>
    graphDb.aggregateIdentifiersByName({
      names: p.names,
      pathPrefixes: p.pathPrefixes,
      excludePaths: p.excludePaths,
      languages: p.languages,
      groupByLanguage: p.groupByLanguage,
      countHolders: p.countHolders,
    }),
  ),
  identifierLanguageCounts: read(async (graphDb, p) =>
    graphDb.identifierLanguageCounts({
      pathPrefixes: p.pathPrefixes,
      pathSuffixes: p.pathSuffixes,
      excludePaths: p.excludePaths,
      languages: p.languages,
    }),
  ),
  sampleIdentifierShapes: read(async (graphDb, p) =>
    graphDb.sampleIdentifierShapes({
      limit: p.limit,
      pathPrefixes: p.pathPrefixes,
      excludePaths: p.excludePaths,
      languages: p.languages,
      groupByLanguage: p.groupByLanguage,
    }),
  ),
  // Ontology audit over cg_identifiers (bd tea-rags-mcp-4p3sb.20).
  readOntologyReportSummary: read(async (graphDb, p) => graphDb.readOntologyReportSummary(p.query)),
  readOntologyReportSections: read(async (graphDb, p) =>
    graphDb.readOntologyReportSections(p.query, p.excludedGenericNames),
  ),
  // Type-level symbols + ancestors for type roles (bd tea-rags-mcp-vi0wx).
  readTypeNameRows: read(async (graphDb, p) => graphDb.readTypeNameRows(p.query)),
  // Field-access edges per method / per file (bd tea-rags-mcp-zy6hx).
  readFieldAccessesBySymbols: read(async (graphDb, p) => graphDb.readFieldAccessesBySymbols(p.symbolIds)),
  readFieldAccessesByFiles: read(async (graphDb, p) => graphDb.readFieldAccessesByFiles(p.relPaths)),
  // Map cannot JSON-serialise — emit entries; the client rebuilds the Map.
  getSymbolLineRangesBulk: read(async (graphDb, p) => [
    ...(await graphDb.getSymbolLineRangesBulk(p.relPaths)).entries(),
  ]),
  getCallees: read(async (graphDb, p) => graphDb.getCallees(p.symbolId)),
  // Map cannot JSON-serialise — emit entries; the client rebuilds the Map.
  getCalleeEdges: read(async (graphDb, p) => [...(await graphDb.getCalleeEdges(p.symbolIds)).entries()]),
  // File-scoped twin (bd tea-rags-mcp-oxnvl) — a SEPARATE op, so a daemon still
  // running from an older build never receives `getCalleeEdges` with a payload
  // shape it predates. Same Map→entries serialisation.
  getCalleeEdgesScoped: read(async (graphDb, p) => [...(await graphDb.getCalleeEdgesScoped(p.refs)).entries()]),
  getSymbolRelPaths: read(async (graphDb, p) => [...(await graphDb.getSymbolRelPaths(p.symbolIds)).entries()]),
  getCalledByCount: read(async (graphDb, p) => graphDb.getCalledByCount(p.symbolId)),
  getCallSiteCount: read(async (graphDb, p) => graphDb.getCallSiteCount(p.symbolId)),
  // Map cannot JSON-serialise — emit entries; the client rebuilds the Map.
  getChunkSignalsBulk: read(async (graphDb) => [...(await graphDb.getChunkSignalsBulk()).entries()]),
  hasData: read(async (graphDb) => graphDb.hasData()),
  getRunStats: read(async (graphDb) => graphDb.getRunStats()),
  getEdgeKindDistribution: read(async (graphDb) => graphDb.getEdgeKindDistribution()),
  listAllSymbols: read(async (graphDb) => graphDb.listAllSymbols()),
  listPass1Aggregates: read(async (graphDb, p) => graphDb.listPass1Aggregates(p.scope)),
  listHierarchyDependencies: read(async (graphDb, p) => graphDb.listHierarchyDependencies(p.scope)),
  listFileContentHashes: read(async (graphDb) => graphDb.listFileContentHashes()),
  getTransitiveImpact: read(async (graphDb, p) => graphDb.getTransitiveImpact(p.relPath, p.maxDepth)),
  // Map cannot JSON-serialise — emit entries; the client rebuilds the Map.
  getFileMetricsBulk: read(async (graphDb, p) => [
    ...(await graphDb.getFileMetricsBulk(p.relPaths, p.maxDepth)).entries(),
  ]),
  findCycles: read(async (graphDb, p) => graphDb.findCycles(p.scope, p.pathPattern)),
  // The adapter returns a `Map<string, string[]>`; serialise as entries
  // so it survives JSON framing (the client rebuilds the Map).
  listAdjacency: read(async (graphDb, p) => [...(await graphDb.listAdjacency(p.scope)).entries()]),
  // Plain arrays on the wire — nothing to rebuild on the client.
  readFileDependencyGraph: read(async (graphDb) => graphDb.readFileDependencyGraph()),
  readNonPublicMemberEdges: read(async (graphDb, p) => graphDb.readNonPublicMemberEdges(p.languages)),
  readTemporalCochangeMeta: read(async (graphDb) => graphDb.readTemporalCochangeMeta()),
  // The graph's bundle membership, commits, bursts, commit times and per-file line counts
  // (a Map of Maps — nested entries) are Maps — entries on
  // the wire, rebuilt by the client. Absent maps (an older daemon's build)
  // travel absent.
  readTemporalCochangeGraph: read(async (graphDb) => {
    const graph = await graphDb.readTemporalCochangeGraph();
    return {
      ...graph,
      ...(graph.bundles ? { bundles: [...graph.bundles.entries()] } : {}),
      ...(graph.bundleCommits ? { bundleCommits: [...graph.bundleCommits.entries()] } : {}),
      ...(graph.bundleBursts ? { bundleBursts: [...graph.bundleBursts.entries()] } : {}),
      ...(graph.bundleTaskIds ? { bundleTaskIds: [...graph.bundleTaskIds.entries()] } : {}),
      ...(graph.bundleFileLines
        ? {
            bundleFileLines: [...graph.bundleFileLines.entries()].map(([bundleId, files]) => [
              bundleId,
              [...files.entries()],
            ]),
          }
        : {}),
      ...(graph.bundleTimestamps ? { bundleTimestamps: [...graph.bundleTimestamps.entries()] } : {}),
    };
  }),
  readTemporalBundleFiles: read(async (graphDb) => [...(await graphDb.readTemporalBundleFiles()).entries()]),
  // Symbol-commit rows of the temporal sub-graph (bd tea-rags-mcp-3gz4f).
  storedTemporalSymbolCommitFilePaths: read(async (graphDb) => graphDb.storedTemporalSymbolCommitFilePaths()),
  readTemporalSymbolCommits: read(async (graphDb, p) => graphDb.readTemporalSymbolCommits(p.relPath)),
  // File-scope get_callers / get_callees (bd tea-rags-mcp-gfvr8). Plain data.
  getFileImporters: read(async (graphDb, p) => graphDb.getFileImporters(p.relPath)),
  getFileImports: read(async (graphDb, p) => graphDb.getFileImports(p.relPath)),
  hasStaleDerivedTables: read(async (graphDb) => graphDb.hasStaleDerivedTables()),
  getPageRank: read(async (graphDb, p) => graphDb.getPageRank(p.symbolId, p.relPath)),

  // ── class hierarchy (bd tea-rags-mcp-f10y) ──
  getSupertypes: read(async (graphDb, p) => graphDb.getSupertypes(p.fqName)),
  getSubtypes: read(async (graphDb, p) => graphDb.getSubtypes(p.fqName)),
  getTransitiveSubtypes: read(async (graphDb, p) => graphDb.getTransitiveSubtypes(p.fqName)),
  // HierarchySnapshot is plain Records — JSON-serialisable, no entries() dance.
  loadHierarchySnapshot: read(async (graphDb) => graphDb.loadHierarchySnapshot()),

  // ── derived-signal drift (bd tea-rags-mcp-a2ddb) ──
  // Plain arrays both ways — the result is JSON-shaped already, unlike the
  // Map-returning reads above.
  diffSymbolSignals: read(async (graphDb) => graphDb.diffSymbolSignals()),
};

/**
 * The dispatch table the server serves. The ONE place the per-op param typing
 * is erased: the dispatcher looks a command up by a runtime `req.op` and hands
 * it the wire params, a correlation the type system cannot express, so it sees
 * the loose `DaemonOpCommand` (the type tests and stand-in servers use).
 * Type-level soundness lives in `DAEMON_OP_COMMAND_DEFINITIONS`; the wire
 * frames are untouched.
 */
export const DAEMON_OP_COMMANDS = DAEMON_OP_COMMAND_DEFINITIONS as unknown as DaemonOpCommandsByOp;

/**
 * Whether `op` changes what the daemon holds — the graph store, a collection's
 * files, or the daemon itself. Read from `DAEMON_OP_COMMANDS`, the table the
 * server dispatches on, so a new op is classified the moment it is added.
 *
 * A client whose build predates the daemon's may only send ops this answers
 * `false` for (bd tea-rags-mcp-1wr7p): the capability table matches op NAMES,
 * and a write whose payload shape moved under an unchanged name would land in
 * the store unnoticed.
 */
export function isDaemonWriteOp(op: DaemonOp): boolean {
  const command = DAEMON_OP_COMMANDS[op];
  return command.access === "daemon" ? command.mutates : command.access === "write";
}
