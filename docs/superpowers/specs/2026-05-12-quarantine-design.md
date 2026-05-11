# Poison-Pill File Quarantine — Design Spec

## Goal

When a file breaks indexing (oversized chunk, embedding rejection, qdrant
payload-too-large, parse failure, FS read failure, etc.), skip it without
failing the whole indexing run, persist the failure on disk, and automatically
retry that file on every subsequent indexing pass. The full quarantine list with
error codes is read by a future `tea-rags doctor <project> --quarantine` CLI
command (separate effort) — this spec only guarantees the on-disk format that
command will consume.

## Problem

1. **Single bad file kills the whole pass** — current `processFiles` catch-block
   in `src/core/domains/ingest/pipeline/file-processor.ts:262-277` only emits a
   debug log line; the failure is invisible without `DEBUG=1` and the file
   silently disappears from the index forever.
2. **Per-batch embedding/qdrant failures are not attributed to files** —
   `WorkerPool.batchFailed`
   (`src/core/domains/ingest/pipeline/infra/worker-pool.ts:254`) drops chunks
   after exhausted retries; the files those chunks came from never re-enter the
   pipeline on subsequent runs.
3. **No retry mechanism** — even if tea-rags ships a fix (better chunker, bigger
   context model), previously broken files are not automatically picked up by
   `reindex_changes` because they're not in the `added` or `modified` set
   (snapshot doesn't track failed files at all).
4. **No visibility into what got skipped** — `get_index_status` reports total
   chunks but cannot answer "which files failed and why?".

## Design Decisions

### D1: Storage — `quarantine.json` alongside snapshot

A single JSON file per collection, written atomically:

```
$TEA_RAGS_DATA_DIR/snapshots/<collectionName>/
  meta.json              # existing — snapshot metadata
  shard-XX.json          # existing — sharded file hashes
  quarantine.json        # NEW — quarantined files
```

Format:

```json
{
  "version": 1,
  "updatedAt": "2026-05-12T14:30:00Z",
  "files": {
    "src/foo/oversized.ts": {
      "errorCode": "INGEST_CHUNK_OVERSIZED",
      "errorMessage": "Chunk #3: 12480 bytes exceeds model context 8192",
      "phase": "embed",
      "firstFailedAt": "2026-05-10T10:00:00Z",
      "lastFailedAt": "2026-05-12T14:30:00Z",
      "attempts": 3
    }
  }
}
```

Rationale:

- **Atomic writes via tmp+rename** — reuses the proven pattern from
  `ShardedSnapshotManager.atomicSwap`.
- **Lifecycle bound to snapshot dir** — dropping the collection
  (`fs.rm(snapshotDir, { recursive: true })`) deletes the quarantine list as a
  side effect. No separate cleanup path.
- **Immediate persistence on failure** — quarantine.json is written the moment a
  file fails, NOT at the end of an indexing pass. If the pass is interrupted,
  the quarantine info survives.
- **Not embedded in `meta.json`** — meta.json is written only at the end of a
  successful pass; embedding quarantine there would lose the "interrupted pass"
  guarantee.
- **Concurrent writes** — last `rename()` wins. In practice one collection is
  indexed by one process at a time. Compare-and-swap by `updatedAt` is reserved
  for Phase 2 if needed.

### D2: Quarantinable error taxonomy

Extend `src/core/domains/ingest/errors.ts` with an abstract marker class:

```ts
/**
 * Marker base for errors that should quarantine the offending file
 * instead of aborting the pipeline or being silently dropped.
 */
export abstract class QuarantinableIngestError extends IngestError {
  abstract readonly phase: "parse" | "embed" | "upsert" | "enrich" | "fs";
}
```

Initial concrete subclasses:

| Class                        | Code                        | Phase    | Trigger                                                               |
| ---------------------------- | --------------------------- | -------- | --------------------------------------------------------------------- |
| `ChunkOversizedError`        | `INGEST_CHUNK_OVERSIZED`    | `embed`  | Chunk > embedding model context after `enforceMaxChunkSize` split     |
| `EmbeddingRejectedError`     | `INGEST_EMBEDDING_REJECTED` | `embed`  | Embedding adapter returns 4xx (malformed input, content policy, etc.) |
| `QdrantPayloadTooLargeError` | `INGEST_PAYLOAD_TOO_LARGE`  | `upsert` | Qdrant returns 413                                                    |
| `FileParseError`             | `INGEST_FILE_PARSE_FAILED`  | `parse`  | tree-sitter or chunker throws                                         |
| `FileReadError`              | `INGEST_FILE_READ_FAILED`   | `fs`     | `fs.readFile` throws (permissions, broken symlink, etc.)              |

Pipeline integration points convert raw errors into the appropriate subclass
before bubbling them to the quarantine machinery.

**Non-quarantinable errors** (continue with current behavior, no quarantine):

- Transient network failures (handled by adaptive batch retries).
- Qdrant 5xx (retry via existing `AdaptiveBatchSizer`).
- Pipeline invariant violations (`IngestInvariantError`).
- `secrets` and `chunk-limit` skips (intentional, not failures).
- `delete-failed` (transient coordinator state, self-heals).

### D3: `QuarantineStore` — the persistence component

New module: `src/core/domains/ingest/sync/quarantine-store.ts`

```ts
export interface QuarantineEntry {
  errorCode: ErrorCode;
  errorMessage: string;
  phase: "parse" | "embed" | "upsert" | "enrich" | "fs";
  firstFailedAt: string;
  lastFailedAt: string;
  attempts: number;
}

export class QuarantineStore {
  constructor(snapshotDir: string, collectionName: string);

  /** Read full map. Empty map if file does not exist. */
  async load(): Promise<Map<string, QuarantineEntry>>;

  /** Mark single file. Read-modify-write via tmp+rename. */
  async markFailed(path: string, err: QuarantinableIngestError): Promise<void>;

  /** Mark a batch of files in one write (for worker-pool batch failures). */
  async markFailedBatch(
    paths: string[],
    err: QuarantinableIngestError,
  ): Promise<void>;

  /** Remove path on successful re-processing. */
  async clear(path: string): Promise<void>;

  /** Drop all entries (called on forceReindex). */
  async clearAll(): Promise<void>;

  /** Count of quarantined files (for get_index_status). */
  async count(): Promise<number>;
}
```

Wired through DI in `bootstrap/factory.ts` and the ingest facade.

### D4: Integration points

**a) File processor — parse/FS phase.** In
`src/core/domains/ingest/pipeline/file-processor.ts:262-277`:

```ts
} catch (error) {
  const wrapped = classifyQuarantinable(error, "parse"); // or "fs" if read failed
  if (wrapped) {
    await quarantineStore.markFailed(relativePath, wrapped);
    pipelineLog.fileIngested(ctx, { ..., skipped: true, skipReason: "quarantined" });
  } else {
    // existing fallthrough: non-quarantinable, log and continue
  }
}
```

A small helper `classifyQuarantinable(error, phase)` lives in
`src/core/domains/ingest/sync/quarantine-classifier.ts`. It inspects the raw
error shape and returns the matching `QuarantinableIngestError` subclass, or
`null` if the error is non-quarantinable (then the current "error" skipReason
path runs).

**b) Worker pool — embed/upsert phase.** In `WorkerPool.batchFailed` after
exhausted retries:

1. Inspect the underlying error: HTTP 413 → `QdrantPayloadTooLargeError`,
   embedding 422 → `EmbeddingRejectedError`, etc.
2. Extract unique `chunk.metadata.filePath` from the failed batch.
3. Convert absolute paths to relative paths using `basePath` threaded through
   the batch context (added as a field on the batch struct when the batch is
   submitted by `chunk-pipeline.ts`).
4. `quarantineStore.markFailedBatch(paths, wrappedError)`.

If the error is not classifiable as quarantinable (e.g. plain 5xx after retries)
— current behavior preserved, file is silently dropped. Phase 2 may expand this.

**c) Enrichment phase.** Not in scope for v1. `EnrichmentRecovery` already
handles partial state. The `phase: "enrich"` slot is reserved for future use.

### D5: Retry workflow

**Full indexing (`index_codebase` without `forceReindex`).** No special handling
— every file is processed anyway. Successful files clear their quarantine entry;
still-failing files have `attempts++`.

**Full indexing with `forceReindex=true`.** `QuarantineStore.clearAll()` is
called before the pass starts. Clean slate.

**Incremental (`reindex_changes`).** The scanner step is augmented:

```ts
const { added, modified, deleted } = await scanner.diff();
const quarantined = Array.from((await quarantineStore.load()).keys());
const workSet = unique([...added, ...modified, ...quarantined]);
```

Quarantined files are re-attempted on every run regardless of whether their
content changed. Rationale: a fix may have shipped in tea-rags itself (improved
chunker, larger context), so retry is cheap and worth attempting.

**On success during retry:** `await quarantineStore.clear(path)`. On repeated
failure: `attempts++`, `lastFailedAt = now`. No bounded retry count (YAGNI) —
the file stays quarantined until it succeeds or the user removes it manually.

### D6: Surface

**`get_index_status` MCP response** — add a `quarantine` block with COUNT ONLY:

```json
{
  "isIndexed": true,
  "chunksCount": 3831,
  "enrichment": { ... },
  "quarantine": {
    "count": 3
  }
}
```

No file list, no error codes in the MCP response. Rationale: the LLM agent
doesn't need to triage individual broken files — that's a human task. Keeping
the surface narrow avoids token bloat and a second pagination story.

**No new MCP tool** for listing quarantined files. The full list lives in
`quarantine.json` on disk. Human-readable inspection is the job of a future CLI
command:

```
tea-rags doctor <project-path> --quarantine
```

The command (out of scope for this spec) reads `quarantine.json` from the target
project's snapshot directory and renders the full table — relative path, error
code, phase, attempts, last-failed timestamp. This spec only fixes the on-disk
format so that command can rely on a stable contract.

### D7: Compatibility

- **Schema drift.** When `schemaDriftMonitor` triggers a forced full reindex,
  `quarantineStore.clearAll()` is called as part of the cleanup. Existing
  quarantine entries may reference error codes from an older code version and
  could be misleading post-drift.
- **Snapshot v3 unchanged.** `quarantine.json` is a new sibling file; absent
  file means empty map. Old snapshots continue to work without migration.
- **Collection delete.** `fs.rm(snapshotDir, { recursive: true })` removes
  `quarantine.json` along with the rest. No explicit teardown needed.

## Out of Scope (Phase 2 candidates)

- Global error log file independent of DEBUG (`Feature 1` in the original
  brainstorm — deferred).
- `tea-rags doctor <project> --quarantine` CLI command (separate effort; this
  spec only fixes the `quarantine.json` format it will read).
- MCP tool / pagination for full quarantine list.
- Bounded retry / `permanent-fail` promotion.
- Compare-and-swap concurrent-write protection (last-writer-wins is acceptable
  for current usage patterns).
- Enrichment-phase quarantine triggers.

## File-Level Touch List

| File                                                     | Change                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/core/domains/ingest/sync/quarantine-store.ts`       | NEW — `QuarantineStore` class.                                                           |
| `src/core/domains/ingest/errors.ts`                      | EXTEND — `QuarantinableIngestError` base + 5 concrete subclasses.                        |
| `src/core/contracts/errors.ts`                           | EXTEND — new `ErrorCode` constants.                                                      |
| `src/core/domains/ingest/pipeline/file-processor.ts`     | MODIFY — classify caught error, call `markFailed`, skipReason update.                    |
| `src/core/domains/ingest/pipeline/infra/debug-logger.ts` | MODIFY — extend `FileIngestRecord.skipReason` union with `"quarantined"`.                |
| `src/core/domains/ingest/pipeline/infra/worker-pool.ts`  | MODIFY — classify exhausted-retry failures, call `markFailedBatch`.                      |
| `src/core/domains/ingest/reindexing.ts`                  | MODIFY — union quarantined paths into work set; clear on success.                        |
| `src/core/domains/ingest/indexing.ts`                    | MODIFY — `forceReindex=true` calls `clearAll`.                                           |
| `src/core/api/public/dto/ingest.ts`                      | EXTEND — `IndexStatus.quarantine?: { count: number }` field.                             |
| `src/core/domains/ingest/pipeline/status-module.ts`      | MODIFY — populate `quarantine.count` from `QuarantineStore.count()` at all return sites. |
| `src/core/domains/ingest/sync/quarantine-classifier.ts`  | NEW — `classifyQuarantinable(error, phase)` helper.                                      |
| `src/bootstrap/factory.ts`                               | MODIFY — wire `QuarantineStore` into ingest facade.                                      |

Tests follow the same shape
(`tests/core/domains/ingest/sync/quarantine-store.test.ts`, integration tests
covering retry-on-next-run).
