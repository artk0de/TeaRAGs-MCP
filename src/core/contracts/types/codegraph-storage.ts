/**
 * Codegraph storage contracts — the driver-agnostic persistence surface.
 * `GraphDbClient` is the whole of it: node / edge / symbol writes (single and
 * batched), the metric and hierarchy reads, cycle and PageRank persistence, and
 * the run-stats surface. `BulkFileUpsertEntry` / `BulkSymbolUpsertEntry` are
 * the batched call shapes; `SymbolChunkResolver` is the narrow read seam
 * `domains/explore` depends on so it never has to see the client itself.
 *
 * The top layer of the codegraph contract set — it names types from every file
 * below it and nothing names it back. Re-exported verbatim by the
 * `codegraph.ts` barrel.
 */

import type {
  AmbiguousCallerSite,
  CalleeEdge,
  CallerEdge,
  ChunkGraphSignals,
  CycleEntry,
  CycleScope,
  EdgeKindCount,
  FileGraphMetrics,
  FileResolveStatsWrite,
  GraphEdges,
  GraphFileNode,
  ResolveRunStatsRow,
} from "./codegraph-graph.js";
import type { HierarchySnapshot, InheritanceEdge } from "./codegraph-hierarchy.js";
import type { CodegraphPass1FileAggregates } from "./codegraph-pass1.js";
import type {
  FileScopedSymbolId,
  FileScopedSymbolRef,
  RelPath,
  SymbolDefinition,
  SymbolId,
} from "./codegraph-symbols.js";

/**
 * One file's worth of symbol definitions, as consumed by
 * `GraphDbClient.upsertSymbolsBulk` — the batched form of
 * `upsertSymbols(relPath, definitions)` that folds many files' worth of
 * reconciliation into a single transaction.
 */
export interface BulkSymbolUpsertEntry {
  relPath: RelPath;
  definitions: SymbolDefinition[];
}

/**
 * One file's worth of node + outgoing edges, as consumed by
 * `GraphDbClient.upsertFilesBulk` — the batched form of `upsertFile(node, edges)`
 * that folds many files' per-source-file DELETE+INSERT into a single transaction.
 */
export interface BulkFileUpsertEntry {
  node: GraphFileNode;
  edges: GraphEdges;
}

/**
 * One file's symbol → covering-chunk join, as consumed by
 * `GraphDbClient.updateSymbolChunkIdsBulk` — the batched form of
 * `updateSymbolChunkIds(relPath, chunkIds)` that folds a whole deferred chunk
 * pass into a single transaction (and, on the daemon path, a single round-trip).
 */
export interface SymbolChunkIdJoinEntry {
  relPath: RelPath;
  chunkIds: ReadonlyMap<SymbolId, string>;
}

/**
 * Resolved location of a symbol's covering Qdrant chunk. Returned by
 * `GraphDbClient.findSymbolChunk` — null when no chunk_id has been
 * backfilled for the symbol yet.
 */
export interface SymbolChunkLocation {
  relPath: RelPath;
  chunkId: string;
}

/**
 * Narrow read seam for the find_symbol codegraph fallback (0rskm). Lives in
 * contracts so domains/explore can depend on it without importing api/internal
 * or adapters. Implemented by GraphFacade (adapted to a bare collectionName in
 * bootstrap). Undefined injection = codegraph disabled = fallback no-op.
 */
export interface SymbolChunkResolver {
  resolveSymbolChunk: (collectionName: string, symbolId: SymbolId) => Promise<SymbolChunkLocation | null>;
}

/**
 * One symbol whose derived codegraph signals moved since the previous run's
 * baseline (bd tea-rags-mcp-a2ddb). Carries the FILE as well as the symbol
 * because the payload is addressed per file's Qdrant points — a bare
 * `symbolId` is unique per file, not per repository, so it cannot name the
 * points to rewrite on its own.
 */
export interface ChangedSymbolSignal {
  relPath: RelPath;
  symbolId: SymbolId;
}

/** One file whose derived file-level codegraph signals moved since the baseline. */
export interface ChangedFileSignal {
  relPath: RelPath;
}

/**
 * What {@link GraphDbClient.diffSymbolSignals} found: the symbols and the files
 * whose derived signals differ from the baseline the last successful payload
 * heal recorded. Both halves are plain arrays rather than Maps or Sets so the
 * shape survives the daemon's JSON round trip.
 */
export interface CodegraphSignalDrift {
  symbols: ChangedSymbolSignal[];
  files: ChangedFileSignal[];
}

/**
 * Driver-agnostic graph DB client.
 *
 * Slice 1 ships `DuckDbGraphClient`; slice 4 ships `PostgresGraphClient`.
 * The interface is the contract — driver-specific concerns (transaction
 * style, prepared statement caching) are implementation details.
 */
export interface GraphDbClient {
  init: () => Promise<void>;
  close: () => Promise<void>;

  /** Atomic upsert of file row + all outgoing edges. Used by the streaming
   *  write path. */
  upsertFile: (node: GraphFileNode, edges: GraphEdges) => Promise<void>;

  /** Batched `upsertFile`: fold M files' node + edge writes into ONE
   *  transaction (and, on the daemon, one IPC round-trip). Each file keeps its
   *  own per-`source_rel_path` DELETE+INSERT (last-wins), so the persisted rows
   *  are identical to calling `upsertFile` per file. Empty batch is a no-op. */
  upsertFilesBulk: (entries: readonly BulkFileUpsertEntry[]) => Promise<void>;

  /** Used by incremental reindex when a file is removed from disk. */
  removeFile: (relPath: RelPath) => Promise<void>;

  /** Reads for metric computation (Tier 1) and MCP tools. */
  getFanIn: (relPath: RelPath) => Promise<number>;
  getFanOut: (relPath: RelPath) => Promise<number>;

  /**
   * Collection-wide p95 of per-file fanIn over the FULL file universe
   * (every row in `cg_symbols_files`, including files with zero incoming
   * edges). Used at index time to finalise `codegraph.file.isHub`
   * (`fanIn > p95`). Computed against the whole graph — not the
   * incremental-reindex subset — so hub classification stays correct when
   * only a few files changed. Returns 0 on an empty/single-file graph so
   * the `fanIn > p95` comparison degenerates sanely.
   */
  getFanInP95: () => Promise<number>;
  getCallers: (symbolId: SymbolId) => Promise<CallerEdge[]>;
  getCallees: (symbolId: SymbolId) => Promise<CalleeEdge[]>;
  /**
   * Lazy ambiguous-group expansion (bd tea-rags-mcp-f2jsb A4). Reads the
   * `cg_ambiguous_fanout` aggregates whose `member` matches the target's
   * member segment — call sites whose over-cap candidate set plausibly
   * contained the target — WITHOUT materializing the suppressed edges.
   * Ordered by (sourceSymbolId, callExpression); `limit` defaults to 50.
   * Empty `member` always returns [] (aggregates never record one).
   */
  getAmbiguousCallersByMember: (member: string, limit?: number) => Promise<AmbiguousCallerSite[]>;
  /**
   * Batch adjacency: for each input source symbolId, the list of resolved
   * callee target symbolIds. Method edges whose callee could not be resolved
   * to a known symbol (null `target_symbol_id`) are excluded. Used by
   * trace_path to expand the call frontier level-by-level without
   * materialising the whole method graph. Sources with no resolved callees
   * are simply absent from the returned map.
   */
  getCalleeEdges: (symbolIds: SymbolId[]) => Promise<Map<SymbolId, SymbolId[]>>;
  /**
   * File-scoped batch adjacency (bd tea-rags-mcp-oxnvl) — same frontier
   * expansion as {@link getCalleeEdges}, but node identity is
   * `(relPath, symbolId)` instead of the bare symbolId. Top-level declarations
   * carry unqualified ids, so the bare form merges every namesake into one node
   * and lets a traced path cross between unrelated files; this form keeps them
   * apart. Targets are DISTINCT — one entry per edge, not per call site.
   * Sources with no visible callees are absent from the map.
   */
  getCalleeEdgesScoped: (refs: FileScopedSymbolRef[]) => Promise<Map<FileScopedSymbolId, FileScopedSymbolRef[]>>;
  /**
   * Files each symbol appears in, as call source or call target (bd
   * tea-rags-mcp-oxnvl). Resolves a bare symbolId to the concrete graph nodes
   * it could denote — several entries mean namesakes. Symbols absent from the
   * method-edge table are absent from the map.
   */
  getSymbolRelPaths: (symbolIds: SymbolId[]) => Promise<Map<SymbolId, RelPath[]>>;
  /**
   * Confidence-weighted chunk fanIn (bd tea-rags-mcp-s5ato):
   * SUM(confidence) over incoming method edges — an m-way dynamic/cone
   * fan-out at confidence 1/m contributes ~1 in total, not m. May be
   * FRACTIONAL (e.g. 1.25); rounded to 2 decimals at the adapter boundary.
   */
  getCalledByCount: (symbolId: SymbolId) => Promise<number>;
  /**
   * Confidence-weighted chunk fanOut — SUM(confidence) over outgoing
   * method edges (a whole m-way fan-out counts as ONE outgoing call).
   * Same fractional/rounding semantics as `getCalledByCount`.
   */
  getCallSiteCount: (symbolId: SymbolId) => Promise<number>;
  /**
   * Bulk read-back of `{ fanIn, fanOut, pageRank }` for EVERY symbol in the
   * graph — the set-based replacement for the per-chunk
   * `getCalledByCount` + `getCallSiteCount` + `getPageRank` loop in
   * `buildChunkSignals` (the deferred-chunk tail). Three GROUP-BY / scan queries
   * instead of `3 × chunkCount` point queries. Values are byte-identical to the
   * per-symbol getters — same confidence-weighted `SUM(COALESCE(confidence,1.0))`
   * with 2-decimal `roundEdgeWeightSum`, same `Number()`/0 pageRank default — and
   * a symbol absent from the map reads as `{ 0, 0, 0 }` (matching the getters,
   * which each return 0 on no rows).
   */
  getChunkSignalsBulk: () => Promise<Map<SymbolId, ChunkGraphSignals>>;

  // ── Class hierarchy (bd tea-rags-mcp-f10y) ──
  /** Direct ancestors of a type (forward), ordered by declaration ordinal. */
  getSupertypes: (fqName: string) => Promise<InheritanceEdge[]>;
  /** Direct subtypes / implementers of a type (reverse index). */
  getSubtypes: (fqName: string) => Promise<InheritanceEdge[]>;
  /** Transitive subtypes via recursive CTE; `depth` reflects traversal level. */
  getTransitiveSubtypes: (fqName: string) => Promise<InheritanceEdge[]>;
  /** Bulk load both directions for the resolver snapshot. */
  loadHierarchySnapshot: () => Promise<HierarchySnapshot>;

  /** Returns true if at least one row exists in `cg_symbols_files`. Used
   *  by drift detection. */
  hasData: () => Promise<boolean>;

  /**
   * Drop and recreate `cg_symbols_edges_file`'s `target_rel_path` secondary
   * index in place (tea-rags-mcp-wgt19). That index earns its cost on read
   * (`getFanIn`, once per file during enrichment) but is exposed to the same
   * ART-drift class 019 removed from other tables: a run dying mid-write
   * (killed daemon, invalidated database, aborted pass — all recurring here)
   * can leave it answering a scoped `DELETE ... WHERE target_rel_path`-style
   * filter pushdown with stale results, so a later per-file DELETE silently
   * matches nothing while the row it was meant to clear is still present, and
   * the following INSERT collides with it — live-reproduced as a daemon-
   * killing native FatalException against taxdome. 019 kept this index rather
   * than dropping it outright because removing it costs every `getFanIn` call
   * a full scan; rebuilding it periodically during a long write-heavy pass
   * keeps that read-time win while bounding how long drift has to accumulate
   * before it is corrected. Call cadence is the caller's choice — the graph
   * finalizer's own `checkpoint()` is a natural one, since a run short enough
   * to never checkpoint is also too short to have meaningfully drifted.
   */
  rebuildEdgeFileTargetIndex: () => Promise<void>;

  // ── Resolve-stats surface (bd tea-rags-mcp-j431) ──
  /**
   * Replace the legacy `cg_run_stats` rows of every language the supplied
   * breakdown names. Overwrite (not merge) per language: stale kinds from a
   * prior run must not survive, and a language absent from `rows` is untouched.
   * A whole-corpus measurement — the codegraph provider calls it only for runs
   * that resolved a language's whole corpus (bd tea-rags-mcp-xpmwg); it is read
   * only for languages {@link recordFileResolveStats} has not yet covered.
   */
  recordRunStats: (rows: ResolveRunStatsRow[]) => Promise<void>;
  /**
   * Persist one run's per-file resolve tallies (bd tea-rags-mcp-xpmwg) in ONE
   * transaction: each named file's `cg_file_resolve_stats` rows become exactly
   * the rows its entry carries (an empty entry clears them), every other file's
   * rows are untouched, and `completeLanguages` is recorded as covered. Deleting
   * a file (`removeFile`) drops its rows. A write naming no file and no language
   * is a no-op.
   */
  recordFileResolveStats: (write: FileResolveStatsWrite) => Promise<void>;
  /**
   * Read the persisted per-(language, receiver-kind) resolve breakdown, ordered
   * by language then receiver kind. A language a whole-corpus run has covered is
   * the SUM of its per-file tallies; every other language reads its legacy
   * `cg_run_stats` rows. Empty array before any run is recorded. Routed through
   * the daemon proxy so MCP clients can read it without holding the DuckDB lock.
   */
  getRunStats: () => Promise<ResolveRunStatsRow[]>;
  /**
   * Count emitted method edges grouped by `edge_kind` (exact / cone / poly-base
   * / dynamic / registry). The exact-vs-fan-out split is a precision-confidence
   * signal: `exact` edges are pinned to a single target, the rest are
   * over-approximations with confidence < 1. Routed through the daemon proxy.
   */
  getEdgeKindDistribution: () => Promise<EdgeKindCount[]>;

  // ── Symbol-table persistence (Slice 2 / A4c) ──
  // The in-memory GlobalSymbolTable needs a disk-backed copy so cold
  // starts and partial reindexes can hydrate without re-walking every
  // file in the repo. Persistence is keyed by `(relPath, symbolId)`
  // exactly like the in-memory map.

  /** Atomic replacement of all symbols for a file, reconciled as a row diff
   *  inside one transaction. Idempotent: empty `definitions` clears the file,
   *  and a re-walk producing the rows already on disk touches nothing. */
  upsertSymbols: (relPath: RelPath, definitions: SymbolDefinition[]) => Promise<void>;

  /** Batched form of {@link upsertSymbols}: one transaction reconciling every
   *  relPath the batch names against the rows it carries. Same per-file
   *  semantics; empty entries is a no-op. If `entries` carries more than one
   *  entry for the same `relPath`, the last one wins — == calling
   *  `upsertSymbols` sequentially for that path.
   *
   *  A symbol's `chunk_id` is NOT part of the reconciliation: an unchanged row
   *  keeps the join {@link updateSymbolChunkIdsBulk} wrote, and retiring a stale
   *  one is that call's job. */
  upsertSymbolsBulk: (entries: BulkSymbolUpsertEntry[]) => Promise<void>;

  /** Drop all persisted symbols for a file. Called by `handleDeletedPaths`. */
  removeSymbolsForFile: (relPath: RelPath) => Promise<void>;

  /** Bulk read for bootstrap hydration. Returns every persisted symbol
   *  definition; consumer is expected to feed them through
   *  `GlobalSymbolTable.hydrate`. */
  listAllSymbols: () => Promise<SymbolDefinition[]>;

  /**
   * Every persisted per-file pass-1 aggregate row (bd tea-rags-mcp-znxg8).
   *
   * Read ONCE per run, at the pass-1→pass-2 barrier, so `CodegraphRunState` can
   * absorb the ancestry and self-dispatch facts of files this run did NOT walk.
   * Without it an incremental run resolves against a complete symbol table and a
   * batch-sized registry, which does not merely under-resolve — it mis-resolves,
   * degrading concrete service entry calls onto the shared template they
   * inherit from.
   *
   * Sibling of {@link listAllSymbols} in every respect that matters: whole-table
   * read, array rather than Map so it survives the daemon's JSON round trip, and
   * the consumer decides what to do with the rows.
   */
  listAllPass1Aggregates: () => Promise<CodegraphPass1FileAggregates[]>;

  /**
   * Every file row with the content hash persisted alongside it, `null` where
   * the row predates the column (bd tea-rags-mcp-6goqa). The repair check diffs
   * this against the run's current hashes to decide what must be re-extracted.
   *
   * Returns an array rather than a Map because the daemon proxies this over
   * JSON, where a Map does not survive the round trip.
   */
  listFileContentHashes: () => Promise<{ relPath: RelPath; contentHash: string | null }[]>;

  /**
   * REPLACE the covering-chunk reference for the symbols of one file. UPDATE-
   * only — never rewrites identity columns. Keyed by symbolId; a symbol of that
   * file absent from the map ends with chunk_id NULL, so a stale join cannot
   * outlive the chunk it pointed at. Written in the codegraph deferred chunk
   * pass once chunk ids exist.
   */
  updateSymbolChunkIds: (relPath: RelPath, chunkIds: ReadonlyMap<SymbolId, string>) => Promise<void>;

  /**
   * Batched form of {@link updateSymbolChunkIds}: the whole deferred chunk
   * pass in ONE transaction of chunked set-based statements, instead of one
   * transaction (and one daemon round-trip) per file.
   *
   * Replace semantics apply per file the entries NAME: those files' chunk_id is
   * cleared, then the collected mapping applied, both inside the one
   * transaction. A file no entry names is untouched. Naming a file with an
   * empty map therefore means "re-derived, nothing covers it" and clears it.
   * Empty entries is a no-op; when one call carries the same (relPath,
   * symbolId) twice the LAST value wins.
   */
  updateSymbolChunkIdsBulk: (entries: readonly SymbolChunkIdJoinEntry[]) => Promise<void>;

  /**
   * Resolve a symbol to its covering Qdrant chunk. Indexed lookup by
   * symbol_id. Returns null when no row matches OR the row's chunk_id is NULL
   * (symbol exists but no covering chunk was recorded). Used by the
   * find_symbol codegraph fallback (0rskm) and promotable to primary (q383b).
   */
  findSymbolChunk: (symbolId: SymbolId) => Promise<SymbolChunkLocation | null>;

  // ── Tier 2 graph metrics (Slice 2 / B1) ──

  /**
   * Count of distinct files that transitively depend on `relPath` via
   * import edges (reverse BFS). Bounded by `maxDepth` to keep cost
   * predictable on large repos — depth 1 = direct fanIn, depth 5
   * (default) captures most realistic blast radii.
   */
  getTransitiveImpact: (relPath: RelPath, maxDepth?: number) => Promise<number>;

  /**
   * Setwise read of `{ fanIn, fanOut, transitiveImpact }` for a SET of roots —
   * the batched replacement for the `3 × fileCount` per-file getter loop in the
   * finalize overlay read-back (bd tea-rags-mcp-6aytq). Three statements per
   * call regardless of set size: two GROUP-BYs and ONE recursive CTE that seeds
   * every root at once and carries the root through the recursion, so each
   * root's count is its own — never shared with an overlapping blast radius.
   *
   * Values are identical to the per-file getters at the same `maxDepth`, and a
   * root with no rows in either direction is ABSENT from the map (the caller's
   * `?? 0` matches the getters, which return 0 on no rows). Empty input is a
   * no-op returning an empty map.
   *
   * Callers bound the set themselves — one call becomes one IPC frame and one
   * live CTE intermediate, both of which grow with the request.
   */
  getFileMetricsBulk: (relPaths: readonly RelPath[], maxDepth?: number) => Promise<Map<RelPath, FileGraphMetrics>>;

  // ── Cycle detection (Slice 2 / B2) ──

  /**
   * Read the persisted cycles table. Each `CycleEntry` is one
   * strongly-connected component of length >= 2 (single-node "cycles"
   * are excluded — they're either harmless or surfaced by other
   * signals). Sub-millisecond read for the MCP `find_cycles` tool.
   *
   * When `pathPattern` (a picomatch glob) is given, a cycle is kept iff
   * AT LEAST ONE member resolves to a matching file path. Cross-boundary
   * cycles (one member inside the scope, one outside) are retained.
   */
  findCycles: (scope: CycleScope, pathPattern?: string) => Promise<CycleEntry[]>;

  /**
   * Read the adjacency (source -> target[]) for `scope` from the
   * appropriate edge table. Domain orchestrators (codegraph provider,
   * metrics service) consume this to run Tarjan / PageRank without
   * the adapter knowing about either algorithm — keeps the adapter
   * layer pure CRUD.
   *
   * Prefer `streamAdjacency` for new callers — it lets the consumer
   * build a compact id-keyed representation without the adapter
   * pre-bucketing into `Map<string, string[]>`.
   */
  listAdjacency: (scope: CycleScope) => Promise<Map<string, string[]>>;

  /**
   * Stream the adjacency for `scope` one `[source, target]` pair at a
   * time. Slice 2 hot-path replacement for `listAdjacency` — gives the
   * domain layer freedom to bucket into a compact id-keyed structure
   * (e.g. `Map<number, number[]>` with a separate id-table) instead of
   * paying the string-keyed `Map<string, string[]>` overhead twice.
   *
   * Method scope also yields the per-edge dispatch confidence as an
   * optional third element (bd tea-rags-mcp-s5ato; legacy NULL rows
   * coalesce to 1.0) so PageRank can weight dynamic/cone fan-out edges.
   * File edges carry no confidence — consumers default a missing weight
   * to 1.
   */
  streamAdjacency: (scope: CycleScope) => AsyncIterableIterator<[source: string, target: string, weight?: number]>;

  /**
   * Flush the WAL to the main database file. Slice 2 streaming
   * pass-2 issues this every N files so the WAL does not grow
   * unbounded during a long indexing pass. Idempotent — a no-op
   * checkpoint when the WAL is empty is cheap.
   */
  checkpoint: () => Promise<void>;

  /**
   * Atomically replace the cycles table for `scope` with the supplied
   * SCC list. Domain runs Tarjan; adapter persists the result.
   * Each inner array is one SCC's members in walk order; cycle_id is
   * assigned by the adapter using the array index. Single-node SCCs
   * are caller-filtered.
   */
  replaceCycles: (scope: CycleScope, sccs: readonly (readonly string[])[]) => Promise<void>;

  // ── Tier 3 graph metric (Slice 2 / B3) ──

  /**
   * Atomically replace the per-symbol PageRank table with the supplied
   * ranks. Domain runs the iterative algorithm; adapter persists.
   * Empty input wipes the table — useful after a force-reindex when
   * the method graph is fully rebuilt.
   */
  replacePageRanks: (ranks: ReadonlyMap<string, number>) => Promise<void>;

  /**
   * Look up the PageRank of a single symbol. Returns 0 when the symbol
   * is unknown or the metrics table hasn't been populated yet — both
   * cases are treated as "rank-irrelevant".
   */
  getPageRank: (symbolId: SymbolId) => Promise<number>;

  /**
   * Symbols and files whose derived signals (`fanIn` / `fanOut` / `pageRank`,
   * and per-file `fanIn` / `fanOut`) differ from the baseline recorded by the
   * last successful payload heal — bd tea-rags-mcp-a2ddb.
   *
   * Read AFTER the metrics recompute and BEFORE {@link refreshSymbolSignalsPrev},
   * which is the only ordering in which it means anything. A row absent from the
   * baseline counts as moved, so the first run after migration 023 names every
   * symbol and every file exactly once.
   *
   * The signals it compares are the ones the payload is actually built from —
   * the confidence-weighted symbol fan of {@link getChunkSignalsBulk} and the
   * per-path edge counts of {@link getFileMetricsBulk} — NOT raw edge counts.
   * `transitiveImpact` and `isHub` are outside the comparison: the first would
   * need a whole-corpus reverse BFS to diff, the second moves for every file at
   * once whenever the collection p95 does.
   */
  diffSymbolSignals: () => Promise<CodegraphSignalDrift>;

  /**
   * Replace the previous-run signal baseline with the current graph, both
   * tables in one transaction.
   *
   * Called by the coordinator AFTER the heal succeeded, never by the finalizer.
   * Refreshing it before the payload is rewritten would erase the very diff a
   * failed heal must retry, and the drift would then stay invisible until the
   * file changed again — which is the defect this whole mechanism exists to fix.
   */
  refreshSymbolSignalsPrev: () => Promise<void>;

  /**
   * Run Tarjan SCC over both scopes + PageRank over the method graph and
   * persist the results, all in one round-trip. Optional because only the
   * daemon-routed client (`DaemonGraphDbClient`) implements it — the
   * in-process `DuckDbGraphClient` leaves it undefined so the provider's
   * direct-mode path runs the analysis inline (one streamAdjacency pass per
   * scope). When present, the provider delegates the whole 30 GB graph build
   * to the single daemon process instead of every MCP client.
   */
  computeAndPersistCyclesAndSignals?: () => Promise<void>;
}
