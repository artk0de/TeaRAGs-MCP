---
title: "Recovery & Reindexing"
sidebar_position: 3
---

# Recovery & Reindexing

Procedures for recovering from bad state and choosing the right reindex strategy. The guiding principle: **zero-downtime whenever possible, destructive only when necessary**.

## Three Reindex Modes

| Mode | Tool call | Downtime | When to use |
|------|-----------|----------|-------------|
| **Incremental** | `reindex_changes` | None | Default after code changes. Processes only added/modified/deleted files via snapshot diff. |
| **Force (zero-downtime)** | `index_codebase` with `forceReindex: true` | None | Model change, schema drift, suspected index corruption. New collection built alongside the old one; alias swaps on success. |
| **Destructive** | `clear_index` then `index_codebase` | **Yes** — search unavailable during rebuild | Only when force reindex isn't enough (e.g. embedding provider unreachable and you want to start clean). **Requires explicit user confirmation**. |

For the plugin-first workflow, the equivalents are:

- `/tea-rags:index` — handles both not-indexed and incremental cases
- `/tea-rags:force-reindex` — zero-downtime rebuild (search stays up)

## Decision Tree

```
Symptom: stale results / missing new files
  → reindex_changes

Symptom: wrong embedding model / schema drift detected
  → index_codebase forceReindex=true
  (zero-downtime; old alias stays live during rebuild)

Symptom: indexing itself is stuck / corrupted marker
  → check get_index_status — is indexingInProgress=true?
    YES → wait OR restart MCP server (marker clears on restart)
    NO  → index_codebase forceReindex=true

Symptom: INGEST_SNAPSHOT_CORRUPTED
  → rm ~/.tea-rags/snapshots/{collection}.json
  → index_codebase forceReindex=true

Symptom: INFRA_QDRANT_UNAVAILABLE persistent
  → fix Qdrant first (see Failure Model)
  → index not touched; retry index_codebase after

Symptom: everything broken, want fresh start
  → clear_index (ASK USER FIRST — irreversible)
  → index_codebase
```

## Zero-Downtime Force Reindex — How It Works

When you run `index_codebase` with `forceReindex: true`:

1. A **new versioned collection** is created with the target embedding model + current schema version (`{name}_{model}_{schemaV}`).
2. Indexing populates the new collection while the **alias still points at the old one** — search traffic is unaffected.
3. On successful completion, the alias atomically switches to the new collection.
4. The old collection is kept for a grace period (cleanup via `alias-cleanup.ts`), then deleted.
5. A fresh snapshot is written for future incremental runs.

If the rebuild fails, the alias stays on the old collection and the new one is cleaned up. Your search never saw a broken index.

## Resuming Interrupted Indexing

Indexing is **checkpoint-based**. If the process dies mid-run:

1. **Do nothing at first** — when you run `index_codebase` again, `ReindexPipeline#checkForCheckpoint` (at `src/core/domains/ingest/reindexing.ts`) detects the partial marker and resumes from the last committed batch.
2. Chunks already embedded and upserted are not re-processed. Embedding cost = what's left, not the whole codebase.
3. If resume fails (corrupted marker, older version mismatch), the error code will direct you to `forceReindex: true`.

The same mechanism handles "I accidentally cancelled" scenarios — the CLI returning doesn't mean indexing stopped. Check `get_index_status` to confirm background progress.

## Schema Drift Recovery

Schema drift happens when a new TeaRAGs version introduces payload fields that didn't exist when the collection was indexed. Two flavours:

- **Additive drift** (new fields, no new indexes) — detected by `SchemaDriftMonitor`. The agent is notified: "New fields X, Y — run `index_codebase` with `forceReindex=true` to populate them." Existing search still works; only the new features need reindexing.
- **Breaking drift** (new Qdrant indexes required) — detected by `SchemaManager` on startup. Migration runs automatically during the next indexing call; no data loss.

Neither triggers an immediate reindex — you pick when to pay the cost.

## Snapshot Hygiene

Snapshots live at `~/.tea-rags/snapshots/` (sharded for large repos). They store file-content hashes used for incremental diff. Safe operations:

- **Delete a snapshot** — forces the next run to behave as full index (no incremental diff). Use after `INGEST_SNAPSHOT_CORRUPTED`.
- **Move to new machine** — copy the matching snapshot alongside the Qdrant data to skip reindexing on the new host.

Unsafe operations:

- Do **not** edit snapshot JSON manually — the next run will mis-diff and miss real changes.
- Do **not** mix snapshots across different embedding models — the dimensions won't match; force reindex first.

## Destructive Operations — Explicit Confirmation Required

Three tools **irreversibly delete data**. Agents must always ask before calling them:

| Tool | What it kills |
|------|---------------|
| `clear_index` | All chunks, git enrichment, snapshots for this codebase |
| `delete_collection` | A named Qdrant collection and all its points |
| `delete_documents` | Specific points from a collection |

The system enforces the protocol via the resource `tea-rags://schema/overview`, which carries the warning. Agents should:

1. Surface the exact operation and scope to the user ("This will delete the `code_a3f82b91` collection — 82k chunks, irreversible.")
2. Wait for explicit confirmation.
3. Only then execute.

Re-indexing a million-LOC codebase takes 10–60 minutes depending on provider. Don't destroy without a reason.

## Cross-Session Safety

When multiple sessions work on the same repo (e.g. two Claude Code windows), the indexing marker prevents races:

- First session starts indexing → writes marker.
- Second session calls `index_codebase` → reads marker, returns early saying another indexer is running.
- First session finishes → marker cleared → second session's next call proceeds as incremental.

**Never `clear_index` to "break through" a conflict**. That's the scenario the marker exists to prevent. Instead, `get_index_status` to see who's indexing, wait, or restart the MCP server if you believe the marker is stale (e.g. the first session crashed).

## Cache & Storage Layout

All TeaRAGs state lives under `~/.tea-rags/`:

```
~/.tea-rags/
├── qdrant/                    # Embedded Qdrant data (if used)
│   ├── storage/               # Vector data
│   ├── daemon.pid             # Current daemon PID
│   ├── daemon.port            # HTTP port
│   └── daemon.refs            # Active reference count
├── snapshots/                 # File-hash snapshots per collection
│   └── {collection}.json
├── git-cache/                 # L2 disk cache for git enrichment (HEAD-keyed)
├── onnx-calibration.json      # GPU batch-size calibration for ONNX
└── logs/                      # DEBUG=1 logs
```

**When in doubt**, deleting `~/.tea-rags/` and re-running `index_codebase` is always safe — you'll lose the index and start from scratch, but nothing in this directory is irrecoverable.

## Related

- [Failure Model](/operations/failure-model) — philosophy behind error surfaces
- [Performance Diagnostics](/operations/performance-diagnostics) — is the index healthy?
- [Indexing Pipeline](/architecture/indexing-pipeline) — what `reindex_changes` does under the hood
