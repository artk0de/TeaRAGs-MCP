# domains/ingest — the write path: scan → chunk → embed → store → enrich, plus quarantine of poison files

Quarantine knowledge (`sync/`) lives here rather than in its own navigator; the
pipeline, operations and enrichment halves each carry their own.

## Mechanics

- **`quarantine.json` is a SIBLING of the collection's snapshot dir and is
  written the instant a file fails.** `QuarantineStore` builds
  ``join(snapshotDir, `${collectionName}.quarantine.json`)``
  (sync/quarantine-store.ts:51) — deliberately NOT inside `<collection>/`,
  because `ShardedSnapshotManager` (sync/snapshot/sharded-snapshot.ts:81)
  atomically swaps that whole directory on every save and would wipe a file
  written mid-pass. Two more deliberate properties: `#markFailed` (:83-89)
  persists on EVERY failure via tmp+rename (:149-160), never batched to
  end-of-pass — which is also why it is not folded into `meta.json`, written
  only on successful completion; and because it sits outside the snapshot dir,
  deleting the collection does NOT reap it — `StatusModule`
  (pipeline/status-module.ts:404-408) drops it explicitly alongside the stats
  cache. `forceReindex` and schema-drift rebuilds call `clearAll()`
  (operations/indexing.ts:104). Mutations serialize per `QuarantineStore`
  instance through a write chain with UUID-suffixed tmp files; concurrent
  PROCESSES are last-rename-wins by accepted design. Why: move it inside the
  snapshot dir and a mid-pass failure list vanishes on the next save; drop the
  explicit `clearAll` on the assumption that snapshot deletion reaps it, and
  quarantine state leaks across a collection delete, hiding files from the next
  index.

## Boundaries

- **Quarantining is decided by two classifiers with OPPOSITE polarity, and
  Qdrant upserts are not quarantinable at all.** EMBED path
  (`sync/quarantine-classifier.ts#classifyEmbeddingQuarantinable`, :80-95): only
  a token-level context overflow (`INFRA_OLLAMA_CONTEXT_OVERFLOW`) or an
  embedding 400/413/422 quarantines — 429, 401, 5xx, network and everything else
  return `null` and keep their retry/abort behaviour. READ/PARSE path
  (`#classifyQuarantinable`, :50-70): a catch-all — anything that is NOT an
  `InfraError` (transient infra) or an `IngestError` (pipeline invariant)
  becomes a `FileReadError` (FS codes) or `FileParseError`. UPSERT:
  `QdrantPayloadTooLargeError` is declared (errors.ts:199) but constructed
  nowhere in `src/`; `ChunkPipeline` rethrows every upsert error after notifying
  `AdaptiveBatchSizer` (pipeline/chunk-pipeline.ts:382-402). The intentional
  `secrets` / `chunk-limit` / `compiled` skips (pipeline/file-ingestor.ts:33,
  118, 157-158) are not failures and never reach either classifier. Why: the
  read/parse side quarantines by DEFAULT — its only guard is the `InfraError` /
  `IngestError` exclusion, so widening that catch (or narrowing the exclusion)
  starts permanently quarantining files a transient FS or infra hiccup touched.
  And treating "Qdrant 413 on upsert" as a live quarantine path sends an agent
  hunting for a classifier that does not exist.

## See also

- `.claude/rules/domain-boundaries.md`, `.claude/rules/barrel-files.md`,
  `.claude/rules/typed-errors.md`, `.claude/rules/migrations.md`,
  `.claude/rules/deep-path-navigation.md`
- `pipeline/CLAUDE.md`, `pipeline/enrichment/CLAUDE.md`, `operations/CLAUDE.md`
