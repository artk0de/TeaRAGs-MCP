# domains/trajectory/codegraph — call/import graph extracted into DuckDB, read back as fan/PageRank signals

## Invariants

- **Chunk signals cannot be computed per batch — the graph only exists after the
  run sink finishes.** Chunk `fanIn` / `fanOut` / `pageRank` are read back out
  of DuckDB, so the provider declares `defersChunkEnrichment = true`
  (symbols/provider.ts:365; git never sets it — git/provider.ts:300-301 says so
  explicitly). `ChunkPhase#onBatchProvider` then skips per-batch chunk dispatch
  and only accumulates the batch's chunkMap
  (ingest/pipeline/enrichment/chunk-phase.ts:246-251), and
  `CompletionRunner#run` performs ONE `buildChunkSignals` pass as **step 7**,
  `runDeferredChunkPass` (completion-runner.ts:121) — after the file finalize
  (step 2) and the git streaming chunk drain (step 6), before `markChunkFinal`
  (step 8). Why: the step indices moved once already (an out-of-window backfill
  now overlaps the finalize), so citing "step 6" points at git's drain; and
  reading the graph any earlier reads an unfinished graph.
- **`cg_symbols.chunk_id` belongs to the deferred chunk pass alone, and that
  pass REPLACES it per file it names.** Every `cg_*` table including
  `cg_symbols` is now written as a row diff (`applyScopedRowDiff`), so a
  re-walked symbol whose definition did not change is not rewritten and keeps
  whatever `chunk_id` it had — the walker no longer resets it.
  `updateSymbolChunkIdsBulk` therefore clears `chunk_id` for every named
  `rel_path` before applying the fresh mapping, both set-based inside one
  transaction. The consequence for `buildChunkSignals` (symbols/provider.ts): a
  file it re-derived must be pushed onto `chunkIdJoins` even when the join came
  back EMPTY — that entry is the only thing that retires the stale ids. Dropping
  the empty-map entry as an optimisation is the bug this shape exists to
  prevent. Why: the failure is silent and read-side — `find_symbol` answers with
  a chunk that no longer contains the symbol, and nothing in the write path
  errors.
- **The graph DB is addressed by the PHYSICAL versioned collection name, and
  heals only per re-extracted file.** `GraphDbClientPool#pathFor`
  (adapters/duckdb/pool.ts:222) resolves whatever string it is handed,
  literally, so passing the alias opens a second shadow database — which
  artifact keys on the alias and which on the versioned name is
  `../../maintenance/footprint/CLAUDE.md`, the caller-side rule and the measured
  incident are `../../ingest/operations/CLAUDE.md`. Edges are reconciled per
  source file — `DuckDbFileGraphStore#writeFileRowsGroup` diffs each file's
  `source_rel_path` slice of `cg_symbols_edges_file|_method`,
  `cg_symbols_inheritance` and `cg_ambiguous_fanout` (plus its `rel_path` slice
  of `cg_pass1_aggregates`) against the rows the walk produced, so only
  genuinely obsolete rows are deleted; derived tables (cycles, metrics) are
  wholesale recomputes and do self-correct. Why: no amount of incremental
  reindexing heals a partial graph, because the files carrying the stale edges
  have not changed — meanwhile every `fanIn` / `instability` / `pageRank`
  written comes off that graph, and `find_cycles` keeps reporting cycles the
  source dropped weeks ago.

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
  scrolls and 9.8 s on taxdome). Two further things an edit must keep: the diff
  compares the expressions the PAYLOAD is built from (confidence-weighted symbol
  fan, per-path edge counts), not raw edge counts, so a dispatch-confidence
  change that moves fanIn from 1 to 0.25 is still caught; and `transitiveImpact`
  / `isHub` are deliberately outside the comparison — the first needs a
  whole-corpus reverse BFS to diff, the second moves for every file at once when
  the collection p95 does, so both are healed only for the files the diff
  already names and otherwise wait for the next `--force-enrichments codegraph`.
  Why: the tables are empty after the migration, so the FIRST run heals every
  point once and every later run is bounded by what actually changed — an
  ordering bug here does not fail, it silently restores the original staleness.

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
  Why: the fix only takes effect once the table is populated, so an index
  predating migration 021 keeps the old behaviour until a
  `--force-enrichments codegraph` run writes the rows — and until then
  `callsUnnarrowedTemplate` is the only number that says so, because every rate
  on `cg_run_stats` counts these calls as successes.

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

## Gotchas

- **A flat `## Codegraph resolve` block in prime is the one-language case, not a
  lost breakdown.** `summarizeCodegraphResolve`
  (`../../ingest/pipeline/status-module.ts:245-268`) drops any language under
  `MIN_LANGUAGE_SHARE` of the call sites, omits `byLanguage` entirely when ≤1
  survives, and hangs that language's kinds off the top-level `byReceiverKind`
  (DEBUG builds; without it no kind tally exists to place), which
  `src/cli/prime/format.ts` then renders without language headers. Why: a
  whole-corpus `--force-enrichments codegraph` on a corpus one language
  dominates makes the per-language headers vanish from a digest that had them,
  which reads as a regression in the tally and is the display rule working (bd
  tea-rags-mcp-7m5xz).
- **Keys are logical (`codegraph.file.X`) but the payload is physical
  (`codegraph.symbols.file.X`).** Descriptors
  (symbols/payload-signals.ts:27-140), overlay masks, filter conditions and
  collection stats all key LOGICALLY; the stored payload nests one level deeper.
  `toPhysicalPayloadKey` (contracts/signal-utils.ts:95-98) bridges them —
  percentile lookups use the logical key (filter-presets/compiler.ts:28-31),
  Qdrant conditions the physical path (:36). git and static keys are already
  physical, so codegraph is the only asymmetric namespace. The mirror hazard is
  prefixing an already level-qualified key (`chunk.` +
  `codegraph.chunk.pageRank`), which is what `isLevelQualifiedPayloadKey`
  (signal-utils.ts:100-117) exists to prevent. Why: a hand-written Qdrant filter
  or payload read using the logical key matches nothing, and every payload read
  in this codebase answers `undefined` rather than raising — the signal vanishes
  without a trace.

## Boundaries

- **Tests and generated files are unconditionally out of the graph while staying
  in the index — and say so in the payload.** `buildCodegraphExclusionFilter`
  (exclusion.ts:74-95) adds `GENERATED_PATTERNS` + `TEST_PATTERNS` after the
  FileScanner ignore filter with no env opt-out (bd tea-rags-mcp-6xxh5), then
  each language's `codegraphExclusionGlobs` and `CODEGRAPH_CUSTOM_EXCLUDE`.
  Qdrant ingest is untouched: those files stay chunked, embedded and searchable.
  The declined file is STAMPED `codegraph.symbols.{file,chunk}.skippedAs`, and
  the value comes from the CLASSIFICATION, not from which list matched
  (`enrichmentSkipReason`, enrichment/policy.ts:63-78): the two pattern families
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
