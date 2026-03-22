# Snapshot Cleanup Design

**Date:** 2026-03-22 **Status:** Draft **Scope:** Auto-cleanup of snapshot
artifacts after indexing

## Problem

`~/.tea-rags/snapshots/` accumulates garbage over time:

- **Stale checkpoints** — `{collection}.checkpoint.json` files left after
  crashed indexing sessions. `deleteCheckpoint()` runs in happy path but not on
  failure. 24h TTL check in `loadCheckpoint()` only marks stale — doesn't delete
  the file unless `load` is actually called.
- **Legacy v1/v2 snapshots** — `{collection}.json` files from before sharded v3
  format. Migration creates v3 but leaves the original and `.backup`.
- **Test artifacts** — `test-collection-*.checkpoint.json` written to prod
  directory when tests run without `TEA_RAGS_DATA_DIR`.

Real-world impact: 131K entries, 1.1 GB on a developer machine.

## Solution

### New module: `SnapshotCleaner`

**Path:** `src/core/domains/ingest/sync/snapshot-cleaner.ts`

Stateless class. No DI — depends only on `snapshotDir`, `collectionName`, and
`node:fs`.

```typescript
class SnapshotCleaner {
  constructor(snapshotDir: string, collectionName: string) {}

  async cleanupAfterIndexing(): Promise<void> {}
}
```

### What `cleanupAfterIndexing()` deletes

| Artifact              | Path pattern                                         | Condition |
| --------------------- | ---------------------------------------------------- | --------- |
| Checkpoint            | `{snapshotDir}/{collectionName}.checkpoint.json`     | Always    |
| Checkpoint temp       | `{snapshotDir}/{collectionName}.checkpoint.json.tmp` | Always    |
| Legacy v1/v2 snapshot | `{snapshotDir}/{collectionName}.json`                | If exists |
| Migration backup      | `{snapshotDir}/{collectionName}.json.backup`         | If exists |

Deletions are silent (errors caught and ignored), with a single debug-level log
summarizing what was removed:

```
[Cleanup] Removed 2 artifacts for code_8b243ffe: checkpoint, legacy snapshot
```

### Call sites

Both in `finally` blocks to guarantee execution on success and failure:

1. **`indexing.ts` → `indexCodebase()`** — cleans up cross-operation artifacts
   (stale checkpoints from previous crashed reindexes, legacy files). Requires
   adding a `finally` block to the existing try/catch. The catch returns `stats`
   with `status: "failed"` — `finally` runs after this return.
2. **`reindexing.ts` → `reindexChanges()`** — safety net in addition to the
   three existing `deleteCheckpoint()` calls (lines 71, 81, 269) which remain as
   part of the normal flow. The `finally` cleanup is intentionally redundant for
   checkpoints — it also handles legacy `.json` and `.backup` artifacts that the
   existing calls do not cover.

### Construction

Created inline at call sites — no factory, no DI registration:

```typescript
// In finally block
const cleaner = new SnapshotCleaner(snapshotDir, collectionName);
await cleaner.cleanupAfterIndexing();
```

### What we do NOT touch

- `migration.ts` — no changes
- `synchronizer.ts` / `parallel-synchronizer.ts` — no changes (existing
  `deleteCheckpoint()` calls stay)
- `ShardedSnapshotManager` — no changes
- `snapshot.ts` (v1/v2 `SnapshotManager`) — still needed by `migration.ts` for
  reading old formats. Dead code cleanup is a separate concern.
- Orphan cleanup (snapshots without Qdrant collections) — future
  `tea-rags doctor` scope

## Testing

Unit test in `tests/core/domains/ingest/sync/snapshot-cleaner.test.ts`:

1. Create temp directory with all artifact types (checkpoint, .tmp, legacy,
   backup) + a v3 snapshot directory
2. Call `cleanupAfterIndexing()`
3. Assert all artifacts deleted
4. Assert v3 snapshot directory untouched
5. Test idempotency — calling on already-clean directory is a no-op
6. Test partial presence — only checkpoint exists, no legacy files

## Future extension

`SnapshotCleaner` is the natural home for `tea-rags doctor` cleanup methods:

```typescript
// Future addition
async cleanupOrphans(activeCollections: string[]): Promise<CleanupReport> {}
async cleanupStaleCheckpoints(maxAgeMs: number): Promise<number> {}
```

These are out of scope for this task.
