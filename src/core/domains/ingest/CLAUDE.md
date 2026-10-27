# domains/ingest — the write path: scan → chunk → embed → store → enrich, plus quarantine of poison files

Quarantine knowledge (`sync/`) lives here rather than in its own navigator; the
pipeline, operations and enrichment halves each carry their own.

## Mechanics

- **`quarantine.json` is a SIBLING of the collection's snapshot dir and is
  written the instant a file fails.** `QuarantineStore` builds
  ``join(snapshotDir, `${collectionName}.quarantine.json`)``
  (`QuarantineStore#constructor`) — deliberately NOT inside `<collection>/`,
  because `ShardedSnapshotManager` (`sync/snapshot/sharded-snapshot.ts`)
  atomically swaps that whole directory on every save and would wipe a file
  written mid-pass. Two more deliberate properties: `QuarantineStore#markFailed`
  persists on EVERY failure via tmp+rename (`QuarantineStore#persist`), never
  batched to end-of-pass — which is also why it is not folded into `meta.json`,
  written only on successful completion; and because it sits outside the
  snapshot dir, deleting the collection does NOT reap it —
  `StatusModule#clearIndex` drops it explicitly alongside the stats cache.
  `forceReindex` and schema-drift rebuilds call `clearAll()`
  (`IndexPipeline#openRunQuarantineStore`). Mutations serialize per
  `QuarantineStore` instance through a write chain with UUID-suffixed tmp files;
  concurrent PROCESSES are last-rename-wins by accepted design. Why: move it
  inside the snapshot dir and a mid-pass failure list vanishes on the next save;
  drop the explicit `clearAll` on the assumption that snapshot deletion reaps
  it, and quarantine state leaks across a collection delete, hiding files from
  the next index.
- **`skipped.json` sits beside `quarantine.json` for the same reason, and its
  deterministic entries are NEVER a retry list.** `SkippedFileStore`
  (`sync/skipped-file-store.ts`) records the deliberate no-points verdicts —
  secrets gate, compiled bundle, blank content (`DeterministicSkipReason`) —
  written from `SourceFileIngestor#ingest` with the content hash, cleared there
  when the path next ingests with chunks, pruned by
  `ReindexPipeline#detectChangesAndRetries` for deleted / newly ignored paths,
  and wiped on a forced rebuild (`IndexPipeline#openRunSkippedFileStore`) and by
  `StatusModule#clearIndex`. `SkippedFileStore#paths` is the set a
  snapshot-vs-points consistency check subtracts before calling a file lost (bd
  muj77). Why: folding these into the quarantine would retry every secrets-gated
  file on every pass for a verdict that is a pure function of its content;
  leaving them unrecorded made a deliberate skip indistinguishable from a lost
  file (bd 6xdwe). An index built before the store existed has no entries for
  its old skips until those files change or a `--force` re-judges them.
- **A non-quarantinable failure never enters the snapshot as indexed.**
  `SourceFileIngestor#recordFailure` records an `IngestError` / `InfraError`
  drop as a retryable `runtimeError` (`SkippedFileStore#recordRuntimeError`);
  both seals pass `SkippedFileStore#retryablePaths` as `retainPrevious`
  (`IndexPipeline#saveSnapshot`, `ReindexPipeline#executeChangesLeg`), so the
  saved entry stays as the previous run had it — absent on a first or forced
  index, whose synchronizer loads no previous snapshot. The next pass sees the
  path as added/modified and re-ingests it; success clears the entry. The
  snapshot stays the single source of truth for the work set — no side list like
  the quarantine retry. Why: stamping the scanned hash made every skip a
  permanent hole (bd muj77: nav93 lost 63/2018 files, incl. a benchmark gold
  file). `StatusModule#probeIndexHoles` reports the pre-fix holes still in old
  snapshots.

## Boundaries

- **Quarantining is decided by two classifiers with OPPOSITE polarity, and
  Qdrant upserts are not quarantinable at all.** EMBED path
  (`sync/quarantine-classifier.ts#classifyEmbeddingQuarantinable`): only a
  token-level context overflow (`INFRA_OLLAMA_CONTEXT_OVERFLOW`) or an embedding
  400/413/422 quarantines — 429, 401, 5xx, network and everything else return
  `null` and keep their retry/abort behaviour. READ/PARSE path
  (`classifyQuarantinable`, same file): a catch-all — anything that is NOT an
  `InfraError` (transient infra) or an `IngestError` (pipeline invariant)
  becomes a `FileReadError` (FS codes) or `FileParseError`. UPSERT:
  `QdrantPayloadTooLargeError` is declared
  (`domains/ingest/errors/ingest-errors.ts`) but constructed nowhere in `src/`;
  `ChunkPipeline` rethrows every upsert error after notifying
  `AdaptiveBatchSizer` (`ChunkPipeline#createBatchHandler`). The intentional
  `secrets` / `chunk-limit` / `compiled` skips (`PreParseSkipReason`,
  `SourceFileIngestor#ingest`, `SourceFileIngestor#preParseSkipReason`) are not
  failures and never reach either classifier. Why: the read/parse side
  quarantines by DEFAULT — its only guard is the `InfraError` / `IngestError`
  exclusion, so widening that catch (or narrowing the exclusion) starts
  permanently quarantining files a transient FS or infra hiccup touched. And
  treating "Qdrant 413 on upsert" as a live quarantine path sends an agent
  hunting for a classifier that does not exist.

## See also

- `.claude/rules/domain-boundaries.md`, `.claude/rules/barrel-files.md`,
  `.claude/rules/typed-errors.md`, `.claude/rules/migrations.md`,
  `.claude/rules/deep-path-navigation.md`
- `pipeline/CLAUDE.md`, `pipeline/enrichment/CLAUDE.md`, `operations/CLAUDE.md`
