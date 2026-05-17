# Integration Test Suite Rewrite (post-SOLID + post-ingest-restructure)

**Goal:** Restore `tests/integration/*.mjs` suites to run against current SOLID
architecture (IngestFacade + ExploreFacade) and post-ingest-restructure paths
(`build/core/...`, `sync/{snapshot,deletion,infra}/`).

**Approach:** Mechanical. Keep custom `.mjs` runner. Centralize facade
construction via `createTestFacades()` helper in `helpers.mjs`. Faithful 1:1
scenario preservation. Update only where SOLID refactor changed return-shape
semantics.

**Out of scope:** New scenarios, vitest migration, smoke run against live
Qdrant+Ollama (gated on infra availability — deferred if not reachable).

## Path remap rules

| Old import | New import |
|---|---|
| `build/code/indexer.js` (CodeIndexer) | DELETED — use `createTestFacades()` |
| `build/code/qdrant/client.js` | `build/core/adapters/qdrant/client.js` |
| `build/code/qdrant/accumulator.js` | `build/core/adapters/qdrant/accumulator.js` |
| `build/code/embeddings/ollama.js` | `build/core/adapters/embeddings/ollama/index.js` |
| `build/code/pipeline/index.js` | `build/core/domains/ingest/pipeline/index.js` |
| `build/code/sync/consistent-hash.js` | `build/core/domains/ingest/sync/infra/consistent-hash.js` |
| `build/code/sync/parallel-synchronizer.js` | `build/core/domains/ingest/sync/parallel-synchronizer.js` |
| `build/code/sync/snapshot/sharded-snapshot.js` | `build/core/domains/ingest/sync/snapshot/sharded-snapshot.js` |
| `build/code/sync/migration.js` (SnapshotMigrator) | `build/core/infra/migration/snapshot-migrator.js` |
| `build/code/schema-migration.js` (SchemaManager, CURRENT_SCHEMA_VERSION) | `build/core/adapters/qdrant/schema-manager.js` + derive version from `schemaMigrator.latestVersion` (import from `build/core/infra/migration/`) |

## Method remap (CodeIndexer → facades)

| CodeIndexer | facade.method |
|---|---|
| `indexCodebase` | `ingest.indexCodebase` |
| `reindexChanges` | `ingest.reindexChanges` |
| `getIndexStatus` | `ingest.getIndexStatus` |
| `clearIndex` | `ingest.clearIndex` |
| `searchCode` | `explore.searchCode` |

## Suite categories

**Easy (6 — path remap only, no API rewrite):**
01-embeddings, 02-qdrant-operations, 03-points-accumulator, 14-parallel-sync, 15-pipeline-workerpool, 16-schema-delete-optimization

**Hard (12 — paths + CodeIndexer → facades):**
04-file-indexing, 05-hash-consistency, 06-ignore-patterns, 07-chunk-boundaries, 08-multi-language, 09-ruby-ast-chunking, 10-search-accuracy, 11-edge-cases, 12-batch-pipeline, 13-concurrent-safety, 17-force-reindex, 18-git-metadata

## Tasks

### Task 1 — Infrastructure
- Verify all path-remap entries by `node -e "import('./build/core/...')"` or simple file existence
- Add `createTestFacades(qdrant, embeddings, opts) → { ingest, explore }` to `helpers.mjs`
- Fix imports in `config.mjs`, `index.mjs`
- Replace `new CodeIndexer(...)` in `index.mjs cleanup()` with `createTestFacades(...).ingest.clearIndex(...)`
- `npm run build` clean
- Commit

### Task 2 — Easy suites (6 files, path-only)
- Apply path remap rules to 01, 02, 03, 14, 15, 16
- Suite 16 has signature change: `new SchemaManager(qdrant, schemaMigrator.latestVersion, sparseMigrator.latestVersion)` + replace `CURRENT_SCHEMA_VERSION` with `schemaMigrator.latestVersion`
- `npm run build` clean, `node -c <suite>.mjs` parses
- Commit

### Task 3 — Hard chunk A: indexing lifecycle (04, 05, 06, 17)
- Replace `new CodeIndexer(...)` with `const { ingest, explore } = createTestFacades(qdrant, embeddings, ...)`
- Remap method calls per table
- Commit

### Task 4 — Hard chunk B: chunker (07, 08, 09)
- Same pattern as Task 3
- Commit

### Task 5 — Hard chunk C: search (10, 11, 18)
- Same pattern
- Commit

### Task 6 — Hard chunk D: pipeline + concurrent (12, 13)
- Same pattern
- Commit

### Task 7 — Smoke run (deferred if infra absent)
- `npm run test-integration` against real Qdrant + Ollama
- Fix any semantic drift (renamed fields, removed methods)
- Commit

### Task 8 — Finishing branch
- Merge to main via `dinopowers:finishing-a-development-branch`

## Constraints

- Business-logic test assertions immutable unless return-shape genuinely changed
- `npm run build` must stay clean after every Task
- No vitest migration; runner stays as custom `.mjs`
- No new scenarios; faithful preservation only
