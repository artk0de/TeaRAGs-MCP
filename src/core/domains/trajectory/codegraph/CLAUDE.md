# domains/trajectory/codegraph — call/import graph extracted into DuckDB, read back as fan/PageRank signals

## Invariants

- **Chunk signals cannot be computed per batch — the graph only exists after the
  run sink finishes.** Chunk `fanIn` / `fanOut` / `pageRank` are read back out
  of DuckDB, so the provider declares `defersChunkEnrichment = true`
  (`CodegraphEnrichmentProvider`, `symbols/provider.ts`; git never sets it — a
  docblock in `GitEnrichmentProvider` says so explicitly).
  `ChunkPhase#onBatchProvider` then skips per-batch chunk dispatch and only
  accumulates the batch's chunkMap
  (`ingest/pipeline/enrichment/chunk-phase.ts`), and `CompletionRunner#run`
  performs ONE `buildChunkSignals` pass as **step 7**,
  `CompletionRunner#runDeferredChunkPass` — after the file finalize (step 2) and
  the git streaming chunk drain (step 6), before `markChunkFinal` (step 8). Why:
  the step indices moved once already (an out-of-window backfill now overlaps
  the finalize), so citing "step 6" points at git's drain; and reading the graph
  any earlier reads an unfinished graph.
- **`cg_symbols.chunk_id` belongs to the deferred chunk pass alone, and that
  pass REPLACES it per file it names.** Every `cg_*` table including
  `cg_symbols` is now written as a row diff (`applyScopedRowDiff`), so a
  re-walked symbol whose definition did not change is not rewritten and keeps
  whatever `chunk_id` it had — the walker no longer resets it.
  `updateSymbolChunkIdsBulk` therefore clears `chunk_id` for every named
  `rel_path` before applying the fresh mapping, both set-based inside one
  transaction. The consequence for `CodegraphChunkSignalPass#build`
  (symbols/chunk-signal-pass.ts, behind `buildChunkSignals`): a file it
  re-derived must be pushed onto `chunkIdJoins` even when the join came back
  EMPTY — that entry is the only thing that retires the stale ids. Dropping the
  empty-map entry as an optimisation is the bug this shape exists to prevent.
  Why: the failure is silent and read-side — `find_symbol` answers with a chunk
  that no longer contains the symbol, and nothing in the write path errors.
- **One rule decides which symbol owns a stored chunk, and ONE settlement is how
  every producer of `codegraph.symbols.chunk.*` reaches it** —
  `settleCodegraphChunkSignals` (symbols/chunk-signal-settlement.ts) over
  `resolveChunkOwnerSymbol` (symbols/chunk-owner-symbol.ts): anchor on the
  chunk's payload symbolId with `#partN` stripped, narrow to the tightest symbol
  nested under it whose range contains the chunk's start line, else keep the
  anchor; with no anchor, the innermost containing symbol, else the chunk is
  unowned. The range source is a typed argument. The deferred pass, the
  backfiller and recovery's in-place heal all reach
  `CodegraphEnrichmentProvider#buildChunkSignals`, which passes the walk's
  ranges, or `none` for a file the graph can never hold. The payload heal
  (`api/internal/infra/codegraph-payload-heal-runner.ts`) passes
  `cg_symbols.start_line/end_line` (migration 024) and groups points by the
  resolved owner, which is how a moved nested symbol reaches its points. "No
  ranges" is never a result. A walked file with no line index, a file with any
  NULL-range row, and a file with no rows are UNSETTLED: left unwritten and
  logged once per pass. Only `none` settles a whole file without signal values.
  The provider declares `settlesChunksExplicitly`, so an empty overlay is its
  bare stamp and a chunk it omits is never stamped (`bareStampableChunkIds`).
  Why: the writers used to pick differently, so a stored value depended on which
  ran last (bd tea-rags-mcp-9i2ow), and "no ranges" degraded silently into bare
  stamps over 52k taxdome chunks (fxio5) and persisted anchor owners (71n0p). A
  producer that calls the rule without the settlement reintroduces both.
- **A chunk signal is addressed by `(relPath, symbolId)`; the bare symbolId
  names every namesake at once.** `DuckDbMethodEdgeReader#getChunkSignalsBulk`
  groups the method edge table by `target_rel_path, target_symbol_id` /
  `source_rel_path, source_symbol_id` and keys its map with
  `fileScopedSymbolKey`, and `settleCodegraphChunkSignals` takes the `relPath`
  as its first argument for the sole purpose of composing that key — the same
  scoping `getCalleeEdgesScoped` carries for `trace_path` (bd
  tea-rags-mcp-oxnvl). `DuckDbSignalDriftStore`'s `CURRENT_SYMBOL_SIGNALS` CTE
  groups the same way, because the diff has to compare the expression the
  PAYLOAD is built from; grouping there on the bare id while the payload carries
  the per-file number leaves every namesake permanently "moved". Why: a
  `SymbolId` is unique per FILE, so the bare grouping merged every top-level
  declaration sharing a name into ONE node and wrote the UNION of their edges
  onto each — measured on this index, `src/index.ts#main`,
  `src/cli/index-progress/worker.ts#main` and `daemon/entry.ts#main` all carried
  `codegraph.chunk.fanOut = 543` against a `god-method` threshold of 67, and the
  `decomposition` preset spent result slots on it (bd tea-rags-mcp-xtdkq). The
  derived tables follow the same identity (bd tea-rags-mcp-4g9ga, migration
  028): `streamAdjacency("method")` yields `fileScopedSymbolKey` vertices, so
  Tarjan and PageRank never see a bare id, `cg_symbols_metrics` is keyed
  `(rel_path, symbol_id)`, and `cg_symbols_cycles` stores each method member's
  own `member_rel_path` — which `find_cycles` renders as `memberLocations` and
  matches `pathPattern` against, never a name-to-file resolution. A row with
  `rel_path = ''` is one 028 carried over from the merged era; readers fan that
  rank out to every namesake until the next recompute rewrites it.

- **The graph DB is addressed by the PHYSICAL versioned collection name, and
  heals only per re-extracted file.** Every `GraphDbClientPool` and
  `CodegraphDbFiles` method that derives a DuckDB path takes a
  `PhysicalCollectionName`, so an alias there does not compile.
  `CodegraphDbFiles#writablePathFor` is the runtime backstop for a name that
  reached the pool by other means: it refuses to CREATE `<base>.duckdb` beside
  `<base>_v<N>` generations (`CodegraphShadowDatabaseRefusedError`) and still
  opens a file that exists. It cannot recognise an alias whose generations have
  no graph file yet — only the brand catches that one. Which artifact keys on
  the alias and which on the versioned name is
  `../../maintenance/footprint/CLAUDE.md`; where the brand is minted and the
  measured incident are `../../ingest/operations/CLAUDE.md`. Edges are
  reconciled per source file — `DuckDbFileGraphStore#writeFileRowsGroup` diffs
  each file's `source_rel_path` slice of `cg_symbols_edges_file|_method`,
  `cg_symbols_inheritance` and `cg_ambiguous_fanout` (plus its `rel_path` slice
  of `cg_pass1_aggregates`) against the rows the walk produced, so only
  genuinely obsolete rows are deleted; derived tables (cycles, metrics) are
  wholesale recomputes and do self-correct — except after a deletion, which only
  prunes them (`pruneDerivedForDeletedFiles`, called by `handleDeletedPaths`
  before the base rows go) and marks them stale in `cg_derived_stale` (migration
  029); the next finalize with no run sink recomputes, and a no-change reindex
  drives one through `runFinalizeOnly` (bd tea-rags-mcp-dy852). Why: no amount
  of incremental reindexing heals a partial graph, because the files carrying
  the stale edges have not changed — meanwhile every `fanIn` / `instability` /
  `pageRank` written comes off that graph, and `find_cycles` keeps reporting
  cycles the source dropped weeks ago.

- **No row outlives its source — dead symbols included, not just dead files.**
  Once a method, class or file is gone from the tree, no `cg_*` row names it:
  not `cg_symbols`, not the method edge table as source OR target, not
  `cg_identifiers` (the params / locals / `return` row the method owned), not
  cycles or ranks. Each shape of "gone" has exactly one owner: a re-walked
  file's own rows are row-diffed (`DuckDbSymbolStore#upsertSymbolsBulk`,
  `DuckDbFileGraphStore#writeFileRowsGroup`,
  `DuckDbIdentifierStore#replaceIdentifiersBulk` — the flush queue passes `[]`,
  never omits the list, for a file that declares nothing); a symbol that left a
  still-present file takes its INCOMING method edges with it, because
  `upsertSymbolsBulk` follows every key its diff deleted into the edge table; a
  deleted, renamed-away or newly ignored file goes through
  `CodegraphEnrichmentProvider#handleDeletedPaths` →
  `DuckDbFileGraphStore#removeFile`; a file the codegraph exclusion starts
  declining is orphaned by `EnrichmentCoordinator#runRepairPass`. A full
  `--force` inherits nothing because a new `_vN` is a new DuckDB file. Why:
  edges are reconciled per SOURCE file, so a caller in an unchanged file is
  never revisited — before the incoming-edge rule its call into a removed method
  stayed, `get_callees` served it, and PageRank ranked the dead symbol (epic
  tea-rags-mcp-4p3sb, found by the matrix). The case matrix is
  `tests/core/domains/trajectory/codegraph/symbols/provider-dead-symbols.test.ts`;
  routing of deletions is
  `tests/core/domains/ingest/operations/reindexing-dead-symbols.test.ts`; the
  storage face (dead row versions, bd tea-rags-mcp-dvzdm) is
  `tests/core/adapters/duckdb/identifier-dead-row-reclaim.test.ts`; the full
  rebuild is `tests/core/adapters/duckdb/force-rebuild-fresh-graph.test.ts`. A
  new table that names a file joins the matrix by itself — its deleted-file
  check discovers every `*rel_path` column from the catalog.

  **Live check** after an incremental run that removes a method `M` from a file
  `F` which another, UNCHANGED file still calls (pick one with `get_callers`).
  The daemon holds the database's write lock, so query a COPY: copy
  `~/.tea-rags/codegraph/<physical>_v<N>.duckdb` and its `.wal` to a scratch
  dir, then open the copy with `@duckdb/node-api` (`node -e`). Run before and
  after the reindex:

  ```sql
  SELECT 'symbols' AS t, count(*) FROM cg_symbols WHERE rel_path = $F AND symbol_id = $M
  UNION ALL SELECT 'edges_out', count(*) FROM cg_symbols_edges_method
    WHERE source_rel_path = $F AND source_symbol_id = $M
  UNION ALL SELECT 'edges_in', count(*) FROM cg_symbols_edges_method
    WHERE target_rel_path = $F AND target_symbol_id = $M
  UNION ALL SELECT 'identifiers', count(*) FROM cg_identifiers
    WHERE rel_path = $F AND owner_symbol_id = $M
  UNION ALL SELECT 'rank', count(*) FROM cg_symbols_metrics WHERE rel_path = $F AND symbol_id = $M
  UNION ALL SELECT 'cycles', count(*) FROM cg_symbols_cycles
    WHERE scope = 'method' AND member_rel_path = $F AND member = $M
  UNION ALL SELECT 'dangling_edges', count(*) FROM cg_symbols_edges_method e
    WHERE e.target_symbol_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cg_symbols s
      WHERE s.rel_path = e.target_rel_path AND s.symbol_id = e.target_symbol_id);
  ```

  Pass: every per-`M` count is non-zero before and 0 after; `dangling_edges`
  does not grow (it is not 0 on a real corpus — DSL-synthesised targets carry no
  symbol row); the caller file's own row counts are unchanged; and `get_callees`
  on the caller no longer lists `M`. For a deleted file, the same zero holds for
  every `*rel_path` column naming it, including `cg_symbols_cycles.member` for
  `scope = 'file'`.

- **An unchanged caller is re-resolved when a hierarchy answer its resolution
  read has moved — full and incremental runs hold the same edges.** A CHA cone
  is a function of the whole hierarchy, so a caller whose file did not change
  kept the cone of the run that last walked it (bd tea-rags-mcp-7t2ee).
  `CallEdgeResolutionRunner#resolve` threads a `HierarchyDependencyRecorder`
  (symbols/hierarchy-dependencies.ts) as the call sites' `CallContext.hierarchy`
  and persists each `getDescendants(T)` it saw with the transitive descendant
  names (`cg_hierarchy_dependencies`, migration 039). Two owners act on it:
  after `seal`, `selectHierarchyDependents` names the unwalked files whose
  recorded answer differs from the sealed view, or whose descendants a walked
  file declares (member-set change), and the sink appends them to the spill for
  pass-2 only — counted, never re-absorbed, since `seal` already hydrated their
  slices; a deletion, which opens no barrier, goes through
  `DuckDbFileGraphStore#invalidateHierarchyDependentsOfDeletedFiles` from
  `handleDeletedPaths`, clearing those callers' content hashes so
  `EnrichmentCoordinator#runRepairPass` — which re-reads the drift after pruning
  orphans — walks them in the same run. Two things an edit must keep: a
  hierarchy read that bypasses `CallContext.hierarchy` records nothing, and
  ancestor reads are not recorded (a different dependency, not the cone's). Case
  matrix: `provider-incremental-cone-invalidation.test.ts`.

- **A pooled graph client is valid only while its path still names the file it
  holds open, and closing one never checkpoints.** `GraphDbClientPool#acquire` —
  the daemon's per-op path through `CodegraphDaemonServer#handle` — and
  `GraphDbClientPool#peek` compare the path's `dev`/`ino` with
  `DuckDbGraphClient#openedDatabaseFile`, which the session sets on every open
  and on a storage compaction's swap (see the next invariant). A missing or
  replaced file retires the client in order: close awaited,
  `onCollectionClientClosed` announced (the daemon wires
  `DaemonMemoryGovernor#forgetCollection`), then
  `CodegraphDbFiles#discardOrphanedWal` and a fresh open through
  `writablePathFor`. `peek` reports such a client absent and leaves it to the
  next `acquire`. `DuckDbGraphSession#close` waits for running native calls and
  issues `PRAGMA disable_checkpoint_on_shutdown` before `closeSync`. Why: DuckDB
  writes the WAL by path, so a client whose file another process unlinked
  (clear, purge, orphan sweep) recreates `<name>.duckdb.wal` beside no database
  and the rebuilt graph leaves with the process (bd tea-rags-mcp-amh78,
  reproduced live). A checkpointing close deletes whatever WAL sits at the path,
  which measured as a clone's WAL and every row in it. And `closeSync` under a
  running query leaves that query unsettled forever.

- **An in-process replacer of a graph DB path holds the path's lease and drains
  the old client before it touches the file; database files land at a path by
  rename only.** `GraphDbClientPool#removeCollection` and
  `GraphDbClientPool#cloneDatabase` (source AND target) run under
  `GraphDbClientPool#withPathLeases`: `GraphDbClientPool#retireForReplacement`
  drops the cached client, waits for every op
  `GraphDbClientPool#runCollectionOp` pinned to it
  (`GraphDbClientPool#pinClient` — a per-client refcount, the only hot-path
  cost), closes it, and only then does `CodegraphDbFiles` unlink or publish.
  `GraphDbClientPool#acquire` waits out a held lease, so an op issued meanwhile
  opens the successor. A new unlink/rename/copy of a codegraph DB path goes
  through the pool the same way — a raw `CodegraphDbFiles` call in a process
  holding a pool skips the drain. `CodegraphDbFiles#cloneDatabase` copies with
  `COPYFILE_EXCL` into staging and renames into place;
  `tests/core/adapters/duckdb/codegraph-db-rename-only.test.ts` fails on any
  non-exclusive copy in a module that can name a DB path. Why: DuckDB addresses
  the WAL by path, so an op in flight on the old client when the file was
  replaced wrote into the successor's WAL (a ghost row in a clone, bd
  tea-rags-mcp-r4veq); and a copy OVER an existing path keeps its inode, which
  the dev/ino check cannot see. In daemon mode the clients are the daemon's, so
  `GraphDbClientPool#replaceInDaemon` sends the replacement there
  (`DaemonDatabaseFileReplacer`, ops `removeCollectionDatabase` /
  `cloneCollectionDatabase`) and the daemon's pool takes the lease; the purge's
  store (`createPurgeCodegraphStore`) routes the same way. The caller touches
  the files itself only when no daemon of its build is up (nothing to drain),
  the pid is alive but the socket refuses, or the daemon predates the ops —
  legacy-tolerated, so the fallback is the pre-r4veq behaviour and never a
  daemon drain. Not covered: a replacement another build's daemon makes, and any
  of those fallbacks — there the dev/ino check on the next acquire is all that
  catches the replacement. Another build's daemon merely HOLDING the file is
  settled at open instead (bd tea-rags-mcp-hw27k): the daemon pool's
  `ForeignBuildDaemonLockArbiter` drains such a holder when no client is
  connected to it, and once the open window runs out on one still in use the
  open fails with `CodegraphDatabaseHeldByForeignDaemonError` naming its pid and
  build — never drained then, or two builds' daemons would drain each other
  between writes.

- **Every `cg_*` table keeps the rows it deletes, so a wholesale rewrite
  RECREATES its table and the file is compacted by copy.** DuckDB 1.5.3 vacuums
  deletes at checkpoint only for tables with no index, and every `cg_*` table
  has a PRIMARY KEY: a `DELETE` + re-INSERT keeps the old generation in the file
  for good (measured on a scratch copy: nine generations after eight rewrites;
  taxdome's graph reached 1.22 GB for 287 MB of live data, bd
  tea-rags-mcp-dvzdm). A writer that replaces a whole table calls
  `DuckDbGraphSession#recreateEmptyTable` inside its transaction — it rebuilds
  the table and its indexes from the catalog's own DDL; `CREATE OR REPLACE … AS`
  would drop the key. The per-file diffed tables cannot do that, so
  `CompletionRunner#runCodegraphStorageCompaction` asks the store, after the
  heal, to compact itself: `DuckDbGraphSession#compactDatabaseFile` measures
  (`shouldCompactCodegraphStorage`: ≥64 MiB and stored row versions ≥2× live),
  then `COPY FROM DATABASE` into `<file>.compact-tmp`, verifies it, and renames
  it over the path under the session's write queue and call gate. The client,
  its pool entry and the daemon's sockets stay; the op is legacy-tolerated, so
  an older daemon is never drained for it. Why: an in-place rebuild frees the
  blocks but never shrinks the file (1.34 GB after rebuilding taxdome's tables),
  and a pool that snapshotted the inode at open would retire the compacted
  client as "replaced".

- **`cg_symbol_signals_prev` / `cg_file_signals_prev` (migration 023) are
  refreshed AFTER a successful payload heal, not by the finalizer.** The pair is
  driven from `api/internal/infra/codegraph-payload-heal-runner.ts`:
  `diffSymbolSignals` names what moved, the healer rewrites those Qdrant points,
  and only then does `refreshSymbolSignalsPrev` record the new baseline.
  Refreshing before the heal would erase the very diff a failed heal has to
  retry, and the drift would then stay invisible until each affected file
  happened to change again — which is the defect the tables exist to fix. The
  diff's universe is what is MATERIALIZED in Qdrant, not the whole graph: a
  symbol row needs its own `chunk_id IS NOT NULL`, and a file needs one such
  symbol OR no symbol rows at all — a barrel has points and file fan but nothing
  to map — while `refreshSymbolSignalsPrev` stays wholesale (bd
  tea-rags-mcp-85xha — 218 graph-known files with no points cost 218 empty
  scrolls and 9.8 s on taxdome). The known residual of that narrowing: a file
  that HAS points but whose `cg_symbols` rows all carry a NULL `chunk_id` — rows
  predating migration 007's backfill, or a containment join that came back empty
  — sits outside the diff until the deferred chunk pass maps it again, and a
  full `--force-enrichments codegraph` clears the class. Two further things an
  edit must keep: the diff compares the expressions the PAYLOAD is built from
  (confidence-weighted symbol fan, per-path edge counts), not raw edge counts,
  so a dispatch-confidence change that moves fanIn from 1 to 0.25 is still
  caught; and `transitiveImpact` / `isHub` are deliberately outside the
  comparison — the first needs a whole-corpus reverse BFS to diff, the second
  moves for every file at once when the collection p95 does, so both are healed
  only for the files the diff already names and otherwise wait for the next
  `--force-enrichments codegraph`. Why: the tables are empty after the
  migration, so the FIRST run heals every point once and every later run is
  bounded by what actually changed — an ordering bug here does not fail, it
  silently restores the original staleness.

- **Pass-2 resolves against a PROJECT-wide symbol table, so its run-global maps
  must be project-wide too — and only `cg_pass1_aggregates` makes them so.** The
  symbol table hydrates from `cg_symbols` when the collection opens
  (`codegraph/factory.ts` `initHook`); `CodegraphRunState`'s ancestry, hierarchy
  view and self-dispatch registry are built in `absorb` from the files the
  CURRENT batch walked. Matching one against the other does not under-resolve,
  it MIS-resolves: with `KindOfService#call` absent from `selfDispatchTemplates`
  the Ruby entry strategy CONTINUEs by design and the constant strategy's
  ancestor walk lands every concrete `SomeService.call(...)` on the shared
  mixin's own method — 200 of 200 sampled caller edges of that hub, from 134
  files, while `inProjectEdgeRecall` read 1.0 (bd tea-rags-mcp-znxg8).
  `RunState#seal` now absorbs the persisted slices FIRST, for files this run did
  not walk, before the hierarchy view / include-by index / discovery that read
  those maps. Two things an edit must keep: walked files are SKIPPED, not merged
  (their row on disk still describes the previous content, so absorbing it
  resurrects renamed-away classes), and hydration never counts as an extraction
  (`extractedFilesByLanguage` drives run stats and the deferred chunk pass).
  WHICH maps hydrate is declared once, in `RUN_GLOBAL_MAP_PERSISTENCE`
  (symbols/run-global-map-registry.ts): the slice type, `buildPass1Aggregates`
  and the seal's hydrators all derive from its `hydrate` entries, a `batchOnly`
  entry states why it is not persisted, and a public run-state field left
  unregistered fails the type check (bd tea-rags-mcp-39xca.6). The same seams
  mint `runScope` — at `seal` and at every reset — and resolver memos key on it
  through `language/kernel/run-scoped-memo.ts`, never on the pooled table's
  identity or on a channel object `absorb` writes into in place. Why: the fix
  only takes effect once the table is populated, so an index predating migration
  021 keeps the old behaviour until a `--force-enrichments codegraph` run writes
  the rows — and until then `callsUnnarrowedTemplate` is the only number that
  says so, because every rate on `cg_run_stats` counts these calls as successes.

- **A run-global map keyed by a bare class or method NAME is partitioned by
  language family, and pass-2 reads the caller's partition, never the view.**
  `CodegraphRunState` stores ancestors, prepends, `classExtends`, the include-by
  index, `returnTypes` and `structuredReturnTypes` in a `LanguageFamilyRecord`
  (`symbols/language-family-record.ts`), and the inheritance rows and hierarchy
  view per family too; `buildResolverInputs` reads `ancestorsFor(language)` and
  its siblings, the call-site context `hierarchyViewFor(language)`, while the
  same-named getters are an all-family view kept for the registry, the
  flag-parity test and diagnostics. Why: a top-level class's name is bare in
  most languages, so one record let a TypeScript `Error` answer `super` and the
  MRO for a Ruby `Error` (bd tea-rags-mcp-nbf8q), and a Go method `get` type a
  Ruby `get` (bd tea-rags-mcp-qea83). A new name-keyed channel read through a
  view reintroduces that. A map only one language writes stays run-wide
  (`schemaTables`, `ivarTypes` — Ruby's) until a second writer appears; a map
  whose key names the declaring file (`classFieldTypesByClassKey`) needs no
  partition.

- **Every `ResolverInputs` channel reaches BOTH `CallContext`s the runner
  builds, and one function is what makes that structural.**
  `resolution-runner.ts` constructs a context twice — once for file edges, once
  per call site — and for two months each literal named the channels by hand.
  `classFieldTypesByClassKey` was added to `ResolverInputs`, populated from run
  state, and copied into NEITHER, so production resolved without an arm both
  offline harnesses built and no test could see it: a present-but-unread channel
  reads exactly like an absent one at every call site.
  `resolverInputChannels(inputs)` is now the run-global slice and both sites
  spread it; `tests/…/resolution-runner-callcontext-channels.test.ts` derives
  its list from `keyof ResolverInputs`, so a NEW channel fails the type check
  until it is mapped and the assertion until it is threaded. A channel a harness
  builds and production does not is not a measurement gap — it invalidates every
  number measured after it appeared.

- **`callsUnnarrowedTemplate` counts CONSTANT receivers only, and its per-kind
  split is how you check that.** Entry narrowing is receiver-anchored, so an
  idiom naming no concrete type — a bare call to an INHERITED hook most of all —
  never had a target to narrow to; `resolution-runner.landedOnSharedTemplate`
  returns false for every other kind, and `cg_run_stats` therefore holds a
  non-zero `unnarrowed_template` under `constant` alone (`prime` renders it as a
  ` · N unnarrowed` suffix per kind). Measured on taxdome before the gate: 2507
  counted call sites, of which 649 (25.9%) were non-constant — 433 bare, 108
  dynamic, 84 chain — and the samples behind them were unrelated short-name
  fan-outs (`result.success` reaching three different `Result.success`), not
  entry calls (bd tea-rags-mcp-4vg1i). Why: the number is read as a defect
  count, so an ungated counter sends the next reader chasing a quarter more
  defects than exist — and the residue it does flag is one idiom, not a
  scattering: 1780 of 1998 hub edges were
  `SomePolicy.authorize!(user, actor, :ability, res)` landing on
  `AbstractPolicy.authorize!`, whose hook is composed by
  `send("can_#{ability}?")` from an ARGUMENT the receiver cannot supply.

- **"Nodes-before-edges" binds the run's END state, not the start of pass-2.**
  `createCodegraphExtractionSink#finish` (symbols/extraction-sink.ts) DISPATCHES
  the node-flush remainder, runs pass-2 against it, and settles the chain before
  `recomputeMetrics` and again in the `finally`. It is allowed to, because
  pass-2 resolves against the in-memory `GlobalSymbolTable` and writes only
  `cg_symbols_files` + the edge / inheritance / fan-out tables — nothing in
  `GraphBuildFinalizer` reads or writes `cg_symbols`, and migration 001 omits
  every FOREIGN KEY on purpose and says so. `CODEGRAPH_NODE_DRAIN_OVERLAP=0`
  restores the blocking form. Two things the overlap relies on and an edit must
  keep: the flush chain admits ONE write at a time, so pass-2's own writes never
  queue behind more than a single node write on the shared daemon session; and
  `DaemonGraphDbClient` multiplexes by request id, so two in-flight calls on one
  client is a supported shape, not a new one. Why: awaiting the drain here reads
  like the correctness barrier its old comment claimed it was. It was a serial
  tail — 24.1s of `CODEGRAPH_NODES_FLUSH` between the last extraction and the
  first `PASS2_PROGRESS` on a taxdome Ruby recompute, which is what turned the
  pass-1 fan-out's 18.8s → 9.1s into a 51.9s → 59.9s window REGRESSION.

- **A language partition's provider resolves only what it OWNS, against state
  built from EVERYTHING — and the mirror is the same merge as the write.** Under
  per-language affinity (the executor side is
  `../../ingest/pipeline/enrichment/CLAUDE.md`) `absorbExtractedFiles` gets
  `absorbRoles`; a `mirror` record goes through
  `CodegraphExtractionSink#mirror`, which shares `absorbPass1State` with `write`
  — symbol-table entry, run-global merge, inheritance rows — and skips the node
  write, the walk ranges, the spill line and every count. `RunState#absorb`
  records a mirror in `mirroredRelPaths`, NOT in `extractedFilesByLanguage`, and
  `seal` treats it as walked. `finalizeSignals` with `finalizeStage: "resolve"`
  finishes the sink with `recomputeMetrics: false`, persists this partition's
  run stats and keeps the owned paths; `"readBack"` recomputes metrics only with
  `ownsCollectionCompletion`, then reads the owned overlays. Three things an
  edit must keep: a mirror that skipped the run-global merge would leave the
  last-write-wins maps different from a single worker's; a mirror counted in
  `extractedFilesByLanguage` would make a Ruby partition prime TypeScript's
  whole-project `ts.Program`; and a mirrored file missing from the hydration
  walked set would resurrect its previous slice. Why: parity with collection
  affinity is exact only because every partition's state equals the single
  worker's (`language-affinity-parity.test.ts`, and end to end
  `lifecycle/language-affinity.integration.test.ts`). Cycles and PageRank are
  the exception by construction: both walk the edge tables in STORAGE order, two
  interleaved writers store the same rows in another order, so Tarjan's
  numbering and the last DOUBLE bits differ — compare them as member sets and
  within the adapter's `PAGE_RANK_EPSILON`.

- **Resolve stats are per caller FILE and aggregated at read; `cg_run_stats` is
  only the legacy fallback.** Finalize writes each resolved file's tally to
  `cg_file_resolve_stats` (migration 025) — replaced per file, dropped by
  `removeFile` — and `getRunStats` sums it per (language, kind) for every
  language in `cg_file_resolve_stats_coverage`, reading `cg_run_stats` for the
  rest. Only a run whose `FileSignalOptions.runCoverage` is `wholeCorpus` (full
  index, `--force-enrichments codegraph`, with or without `--languages`) records
  coverage or writes `cg_run_stats`; an incremental run writes per-file rows
  alone. Why: `cg_run_stats` was replaced per language by whatever the last run
  resolved, so a one-file `.tsx` incremental on taxdome turned typescript
  bareCall 122777/175773 into a handful of calls, `MIN_LANGUAGE_SHARE` dropped
  typescript and prime showed ruby alone — and on an index migrated from that
  table, per-file rows cover only what incrementals touched, so reading them
  before a whole-corpus run reproduces the same bug (bd tea-rags-mcp-xpmwg).

- **A second sub-graph rebuilds through the family's completion hook, not a
  second enrichment provider.** `cg_temporal_*` (migration 031, bd
  tea-rags-mcp-x4rpp) is written by `TemporalCochangeBuilder`
  (temporal/cochange/builder.ts), a `CodegraphCollectionCompletionHook` the
  symbols provider runs ONLY from
  `CodegraphEnrichmentProvider#completeCollection`, on the main-thread instance
  — never from `finalizeSignals` or any partition stage (bd tea-rags-mcp-vtuu4).
  `EnrichmentCoordinator#completeRun` asks it once a run's completion settled
  and the executor released the worker's run state; a reindex that opens no
  enrichment run asks it from its early returns (bd tea-rags-mcp-l1ot.2) — which
  early returns owe it is `../../ingest/operations/CLAUDE.md`'s fact. Why:
  finalize runs inside the enrichment worker while `TSProgramCache` still holds
  the whole-project `ts.Program`; the history load and pair maps on top of it
  ran a 17k-TS-file worker out of `ENRICHMENT_WORKER_MEMORY_LIMIT_MB` right
  after the file finalize, and the run lost every codegraph signal. Hooks are
  best-effort and log, so a repository with no git history still indexes. It
  stores only LIVE paths — tracked by HEAD's tree
  (`VcsGitAdapter#listTreePaths`) and not deleted in the working tree
  (`#listWorktreeDeletions`) — never "exists on disk": an ignored build artifact
  can reuse a once-committed path. The builder is gated on the persisted
  `cg_temporal_meta` row (same HEAD + fingerprint, built under a day ago ⇒
  skipped without reading history); the fingerprint hashes the parameters, the
  project subtree AND the working-tree deletions, because those with HEAD fix
  the live set — keyed on HEAD alone, an uncommitted deletion (or a worktree
  seeded with a sibling's DB) kept pairs whose endpoint is gone. It reads
  history through the git trajectory's discovery store with the git trajectory's
  own window, so the two share one snapshot. Why: a provider with no payload
  would still stamp an `enrichedAt` marker on every point of every index and
  enter the recovery scan, for tables that live in DuckDB only.

## Gotchas

- **`codegraph.file.instability` is sampled over the files the graph actually
  measured, and over its interior only.** The descriptor declares
  `stats.minSupportPercentile: 75` against its existing `connectionCount`
  support and `stats.structuralAtoms: [0, 1]`; both mechanisms and the read half
  belong to `../CLAUDE.md`. The support floor, measured on `code_8b243ffe`
  typescript source: observed variance of the raw ratio against the
  pure-binomial floor `mean_i[p(1-p)/n_i]` is 0.79 over all 738 files — at or
  below 1, so the whole spread is sampling noise around one corpus ratio — then
  1.20 from n≥3 and 2.36 from the floor the declaration resolves to
  (`connectionCount` p75 = 5, admitting 306 files). The floor alone did NOT
  retire the degenerate `unstable ≥1` band, and a higher floor is the wrong
  lever: instability is `fanOut / (fanIn + fanOut)`, so it reads exactly 1 for
  every file nothing imports and exactly 0 for every file that imports nothing —
  facts about a pure source and a pure sink, not thin evidence. 17 of the 306
  admitted files still read 1, one of them on 33 edges, and p95 stays on the
  atom at every floor up to n≥8, where it only comes off by thinning the sample
  to 146. Hence the atoms: on a later measurement (1158 typescript files, 427 at
  0, 53 at 1) the floor-only sample reads p95 1.000 over 306, interior only
  0.889 over 678, interior plus floor p75 0.833 / p90 0.889 / p95 0.909
  over 289. Atoms stay graded, so an entry point still reads `unstable` and a
  leaf `stable`. Live consequence beyond labels: both gates narrow the GLOBAL
  bucket, so they move `unstableCore`'s `instability p90` leg (0.9091 → 0.9117
  from the floor alone; its `connectionCount p50` leg is ungated and stays at
  3).
- **A flat `## Codegraph resolve` block in prime is the one-language case, not a
  lost breakdown.** `summarizeCodegraphResolve`
  (`../../ingest/pipeline/status-module.ts`) drops any language under
  `MIN_LANGUAGE_SHARE` of the call sites, omits `byLanguage` entirely when ≤1
  survives, and hangs that language's kinds off the top-level `byReceiverKind`
  (DEBUG builds; without it no kind tally exists to place), which
  `src/cli/prime/format.ts` then renders without language headers. Why: a
  whole-corpus `--force-enrichments codegraph` on a corpus one language
  dominates makes the per-language headers vanish from a digest that had them,
  which reads as a regression in the tally and is the display rule working (bd
  tea-rags-mcp-7m5xz).
- **Keys are logical (`codegraph.file.X`) but the payload is physical
  (`codegraph.symbols.file.X`).** Descriptors (`symbols/payload-signals.ts`),
  overlay masks, filter conditions and collection stats all key LOGICALLY; the
  stored payload nests one level deeper. `toPhysicalPayloadKey`
  (`contracts/signal-utils.ts`) bridges them — percentile lookups use the
  logical key (`resolveThreshold` in `filter-presets/compiler.ts`), Qdrant
  conditions the physical path (`compileCondition`). git and static keys are
  already physical, so codegraph is the only asymmetric namespace. The mirror
  hazard is prefixing an already level-qualified key (`chunk.` +
  `codegraph.chunk.pageRank`), which is what `isLevelQualifiedPayloadKey`
  (`contracts/signal-utils.ts`) exists to prevent. Why: a hand-written Qdrant
  filter or payload read using the logical key matches nothing, and every
  payload read in this codebase answers `undefined` rather than raising — the
  signal vanishes without a trace.

## Boundaries

- **Tests and generated files are unconditionally out of the graph while staying
  in the index — and say so in the payload.** `buildCodegraphExclusionFilter`
  (`exclusion.ts`) adds `GENERATED_PATTERNS` + the installed test-file
  conventions (owned by `domains/language`, bd tea-rags-mcp-vjz6s) after the
  FileScanner ignore filter with no env opt-out (bd tea-rags-mcp-6xxh5), then
  each language's `codegraphExclusionGlobs` and `CODEGRAPH_CUSTOM_EXCLUDE`.
  Qdrant ingest is untouched: those files stay chunked, embedded and searchable.
  The declined file is STAMPED `codegraph.symbols.{file,chunk}.skippedAs`, and
  the value comes from the CLASSIFICATION, not from which list matched
  (`enrichmentSkipReason`, `enrichment/policy.ts`): the two pattern families
  read back as `"generated"` / `"test"`, but a language glob or
  `CODEGRAPH_CUSTOM_EXCLUDE` hit that no classification flag explains — a
  `db/migrate/*.rb`, say — lands as `"policy"`. The stamp contract and why an
  unstamped decline never leaves the recovery set are
  `../../ingest/pipeline/enrichment/CLAUDE.md`. Why: "a test chunk has no
  `codegraph.*` block" is wrong and sends an investigator hunting a
  missing-enrichment bug. The block is there carrying the skip reason, and that
  marker is how to tell "never measured" from "measured zero".
  Codegraph-weighted presets still score such a chunk as having no graph
  presence — there is no fan number to weigh.

## See also

- `.claude/rules/codegraph-walkers.md`,
  `.claude/rules/resolver-architecture.md`,
  `.claude/rules/symbolid-convention.md`,
  `.claude/rules/imports-field-semantics.md`
- `.claude/rules/payload-signals.md`, `.claude/rules/domains-language.md`,
  `.claude/rules/silo-pairing.md`
- `../CLAUDE.md`, `../git/CLAUDE.md`,
  `../../ingest/pipeline/enrichment/CLAUDE.md`
