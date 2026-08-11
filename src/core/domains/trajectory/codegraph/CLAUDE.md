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
- **The graph DB is addressed by the PHYSICAL versioned collection name, and
  heals only per re-extracted file.** `GraphDbClientPool#pathFor`
  (adapters/duckdb/pool.ts:222) resolves whatever string it is handed,
  literally, so passing the alias opens a second shadow database — which
  artifact keys on the alias and which on the versioned name is
  `../../maintenance/footprint/CLAUDE.md`, the caller-side rule and the measured
  incident are `../../ingest/operations/CLAUDE.md`. Edges are replaced per file
  (`DELETE FROM cg_symbols_edges_file|_method|cg_symbols_inheritance WHERE source_rel_path = ?`,
  adapters/duckdb/file-graph-store.ts:34-35,90); derived tables (cycles,
  metrics) are wholesale recomputes and do self-correct. Why: no amount of
  incremental reindexing heals a partial graph, because the files carrying the
  stale edges have not changed — meanwhile every `fanIn` / `instability` /
  `pageRank` written comes off that graph, and `find_cycles` keeps reporting
  cycles the source dropped weeks ago.

## Gotchas

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
