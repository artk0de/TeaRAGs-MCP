---
title: Cache Lifecycle
sidebar_position: 6
---

# Cache Lifecycle

TeaRAGs keeps **six distinct caches** in play during normal operation. They differ in what they store, when they invalidate, and what the cost of a miss is. This page catalogs them so you know what's safe to delete when things look stale.

## Cache Catalog

| Cache | Storage | Key | Invalidation | Cost of a miss |
|-------|---------|-----|--------------|----------------|
| **Qdrant vectors** | `~/.tea-rags/qdrant/storage/` (embedded) or external Qdrant | Point ID | `clear_index` or collection drop | Full reindex (minutes–hours) |
| **Snapshots** | `~/.tea-rags/snapshots/{collection}.json` | Collection name | Mismatching file hash on reindex | Next reindex treated as full |
| **Git enrichment cache** (L2 disk) | `~/.tea-rags/git-cache/` | HEAD SHA + file path | HEAD changes OR explicit invalidate | Re-parse `.git/objects/pack/` (seconds per repo) |
| **Git enrichment cache** (L1 memory) | Process memory | HEAD SHA + chunk ID | Process restart | Re-read from L2 disk (ms) |
| **StatsCache** (percentile thresholds) | Memory + optional disk | Collection + language + scope | New chunks indexed; explicit `refreshStatsByCollection` | Re-scan Qdrant for percentiles (~1s per language) |
| **ONNX calibration** | `~/.tea-rags/onnx-calibration.json` | Hardware fingerprint + model | Different model or device | GPU probe at startup (~3–10s) |
| **Qdrant daemon state** | `~/.tea-rags/qdrant/daemon.{pid,port,refs}` | Process-level | Daemon termination | Respawn daemon (~2s) |

## Qdrant Vectors — The Primary Cache

The Qdrant collection itself is the canonical store for everything searchable. Deleting it means redoing embeddings — the most expensive operation in the system. Safe operations:

- **Collection alias swap** — zero-downtime rebuild. Old collection remains until the new one succeeds.
- **Single-point delete** — via `delete_documents` on specific IDs. Rare; normally the reindex diff handles this.

Unsafe (destroys data):

- Directly removing `~/.tea-rags/qdrant/storage/` — bypasses the daemon and can corrupt state
- `delete_collection` — irreversible; requires explicit user confirmation

## Snapshots — Incremental Reindex State

A snapshot is a JSON (or sharded JSON for large repos) of `{ filePath: contentHash }` for every indexed file. It lives next to the collection, keyed by collection name. See `src/core/domains/ingest/sync/sharded-snapshot.ts`.

**Lifecycle:**

1. Written **after** successful indexing (never before — crashed runs don't poison it).
2. Read on next `reindex_changes` to diff against current working tree → `{added, modified, deleted}`.
3. Re-written at the end of that reindex.

**Safe to delete.** The next run becomes a full reindex instead of incremental — no data loss, just time cost.

**Invalidation triggers:**

- User deletes the file
- Content hashes don't match on diff (no "poisoning" possible — a mismatch means we reindex that file)
- Embedding model changes (tracked separately via collection naming)

## Git Enrichment Cache — HEAD-Keyed

Git enrichment is the second-most expensive operation. The pipeline caches results keyed by `HEAD SHA`:

- **L1 memory** — `GitEnrichmentCache` (`src/core/domains/trajectory/git/infra/cache.ts`) holds per-file metadata + per-chunk churn overlays for the duration of a single indexing run
- **L2 disk** — `~/.tea-rags/git-cache/` persists across runs; keyed by `{repoRoot}/{HEAD SHA}`

**Invalidation:** a new HEAD SHA (commit) invalidates both layers for that repo. The old entries stay on disk until a cleanup sweep, but they're never read once HEAD moves.

**Safe to delete** the entire `git-cache/` directory. The next enrichment re-reads `.git/objects/` (bounded by `TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS`). On a small repo, that's seconds; on a monorepo, up to a minute.

## StatsCache — Percentile Thresholds

`StatsCache` (`src/core/infra/stats-cache.ts`) holds per-collection percentile thresholds used for signal labels (`low`/`typical`/`high`/`extreme`). Scoped by `(language, signal, source|test)`.

**Lifecycle:**

1. Computed lazily on first search that asks for labels
2. Cached in memory for the process lifetime
3. Invalidated by `StatsCache#invalidate()` when:
   - New chunks are added to the collection (indexing / reindex)
   - Schema drift detected
   - `IngestFacade#refreshStatsByCollection` called explicitly

Cost of a miss: a scroll over all points per signal — roughly 1s for a typical codebase, seconds-to-minutes for very large ones.

**Does not persist to disk by default** — it's re-computed on process restart. Acceptable cost because the data already lives in Qdrant.

## ONNX Calibration — Hardware-Specific

The ONNX embedding daemon runs a GPU batch-size probe at first startup to find the optimal batch for *this machine*. Results cache to `~/.tea-rags/onnx-calibration.json`:

```json
{
  "hardware": "Apple M3 Pro",
  "model": "jinaai/jina-embeddings-v2-base-code-fp16",
  "device": "webgpu",
  "optimalBatchSize": 64
}
```

**Invalidation:**

- Different model → new entry
- Different device → new entry
- Hardware change → manual delete (file isn't machine-fingerprinted precisely)

**Safe to delete.** Startup will re-probe in ~3–10 seconds.

## Qdrant Daemon State — Process Refcounting

The embedded Qdrant daemon uses three files for cross-process coordination:

- `~/.tea-rags/qdrant/daemon.pid` — current daemon PID
- `~/.tea-rags/qdrant/daemon.port` — HTTP port it's listening on
- `~/.tea-rags/qdrant/daemon.refs` — ref counter (number of attached MCP servers)

**Lifecycle:**

1. First `tea-rags` process finds no daemon → spawns one, writes all three files, `refs=1`.
2. Second process finds files → attaches to existing daemon, `refs=2`.
3. On shutdown, process decrements `refs`. When `refs=0`, daemon waits 30s then exits (configurable).

**Invalidation (stale files):** if the daemon crashed, `pid` may point to a dead process. Safe to delete all three files and restart TeaRAGs — next startup spawns a fresh daemon.

## When Caches Conflict

Cache consistency is maintained by **embedding-model + schema-version in the collection name** (`{name}_{model}_{schemaVersion}`). Cascading implications:

- Change embedding provider → new collection; old snapshot and old Qdrant data stay around but aren't touched
- Bump schema version → new collection; SchemaManager migrates indexes automatically
- Clear everything: `rm -rf ~/.tea-rags/` and restart. No data outside this directory depends on these caches.

## Related

- [Data Model → Schema Versioning](/architecture/data-model#schema-versioning) — how the version cascades into collection names
- [Recovery & Reindexing](/operations/recovery-reindexing) — procedures when caches misbehave
- [Indexing Pipeline](/architecture/indexing-pipeline) — where caches read and write in the pipeline
- [Git Enrichment Pipeline](/architecture/git-enrichment-pipeline) — L1/L2 git cache detail
