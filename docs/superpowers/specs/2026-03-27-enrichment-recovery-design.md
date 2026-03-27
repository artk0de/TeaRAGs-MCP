# Enrichment Recovery Design

**Date**: 2026-03-27 **Status**: Draft **Scope**: Enrichment failure detection,
recovery, and health reporting

## Problem

When git enrichment fails during indexing (full or incremental), chunks are
stored in Qdrant without git signals. There is no detection, no warning, and no
recovery path short of full reindex with `forceReindex: true`.

Specific failure scenarios:

1. **Full index**: Prefetch fails → all chunks stored without file-level
   signals. Chunk enrichment fails → chunks without chunk-level signals.
2. **Incremental reindex**: Old chunks deleted first, then new chunks created.
   If enrichment fails → regression: chunks that previously had git signals now
   have none. Next incremental reindex won't fix them (file unchanged → not in
   `changedPaths`).

Current error handling: ~15 catch blocks across Coordinator, Applier, and Git
infra silently swallow errors. Only prefetch failure is tracked in-memory
(`state.prefetchFailed`), never persisted to Qdrant marker.

## Solution Overview

Hybrid approach:

- **Source of truth**: `enrichedAt` timestamps on each chunk (per-level,
  per-provider)
- **Cached view**: Per-provider enrichment marker in Qdrant metadata point
  (ID=1) with `unenrichedChunks` count
- **Recovery step**: Runs at the start of every indexing operation (except
  `forceReindex`), scrolls for unenriched chunks, re-enriches them
- **Health API**: `get_index_status` and `get_index_metrics` report
  per-provider, per-level enrichment health

## Architecture

### Per-Trajectory Enrichment Status

Each trajectory provider (git, static, future) owns its enrichment lifecycle
independently. The marker and chunk payload are namespaced by provider key.

### Chunk Payload — Two Independent Timestamps

```typescript
// Written by EnrichmentApplier in the same batchSetPayload as signals
"git.file.enrichedAt": string   // ISO timestamp — file-level signals applied
"git.chunk.enrichedAt": string  // ISO timestamp — chunk-level signals applied
```

Timestamp value = `startedAt` of the current enrichment run (not wall clock at
write time). All chunks in one run share the same timestamp.

Both timestamps are written on **success and intentional skip** (e.g., file
outside git log time window). Absence of timestamp means only one thing:
enrichment did not reach this chunk (crash or error).

### Qdrant Marker — Per-Provider, Per-Level

Replaces flat `EnrichmentInfo` and `ChunkEnrichmentInfo`.

```typescript
// Qdrant point ID=1, payload.enrichment
enrichment: {
  [providerKey: string]: ProviderEnrichmentMarker;
};

interface EnrichmentLevelMarker {
  status: "pending" | "in_progress" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  matchedFiles?: number;
  missedFiles?: number;
  unenrichedChunks: number; // cached count from post-enrichment scroll
  // Heartbeat: written periodically during in_progress
  lastProgressAt?: string;      // ISO timestamp of last progress update
  lastProgressChunks?: number;  // enriched chunk count at last heartbeat
}

interface FileEnrichmentMarker extends EnrichmentLevelMarker {
  status: "pending" | "in_progress" | "completed" | "failed";
  // file-level is all-or-nothing: one git log call for all files
}

interface ChunkEnrichmentMarker extends EnrichmentLevelMarker {
  status: "pending" | "in_progress" | "completed" | "degraded" | "failed";
  // degraded = partial chunks enriched, some failed
}

interface ProviderEnrichmentMarker {
  runId: string;
  file: FileEnrichmentMarker;
  chunk: ChunkEnrichmentMarker;
}
```

### Status Lifecycle

```
File-level:   pending → in_progress → completed | failed
Chunk-level:  pending → in_progress → completed | degraded | failed
```

Transitions recorded in marker at each phase boundary:

| Moment                     | file.status | chunk.status |
| -------------------------- | ----------- | ------------ |
| Pipeline started           | pending     | pending      |
| Prefetch started           | in_progress | pending      |
| Prefetch succeeded         | completed   | pending      |
| Prefetch failed            | failed      | failed       |
| Chunk enrichment started   | (unchanged) | in_progress  |
| Chunk enrichment succeeded | (unchanged) | completed    |
| Chunk enrichment partial   | (unchanged) | degraded     |
| Chunk enrichment failed    | (unchanged) | failed       |

### Stale Detection

An `in_progress` status may indicate a crashed process. Detection uses
progress-based heartbeat, not wall clock timeout:

During enrichment, the coordinator periodically writes `lastProgressAt` and
`lastProgressChunks` to the marker (every N chunks or every 30 seconds,
whichever comes first).

`get_index_status` detects stale by:

1. Status is `in_progress`
2. `lastProgressChunks` has not changed for > 2 minutes (comparing
   `lastProgressAt` to now)

If stale detected → report as warning: "Enrichment appears stalled — no progress
in 2 minutes. May need reindex."

Recovery step also uses this: if previous run left `in_progress` with stale
heartbeat → treat as `failed` and attempt recovery.

### Recovery Step

Runs at the start of any indexing operation (full or incremental), **before**
the main enrichment pipeline. Skipped when `forceReindex: true` (collection
rebuilt from scratch).

```
Recovery (per provider):
├─ 1. Scroll Qdrant: chunks without {provider}.file.enrichedAt
│     → group by relativePath
│     → run buildFileSignals(root, { paths }) for those files
│     → apply file signals + set enrichedAt
│
├─ 2. Scroll Qdrant: chunks without {provider}.chunk.enrichedAt
│     → group by relativePath
│     → run buildChunkSignals() for those paths
│     → apply chunk signals + set enrichedAt
│
├─ 3. Count remaining unenriched (scroll again)
│     → update marker.file.unenrichedChunks
│     → update marker.chunk.unenrichedChunks
│
└─ 4. If recovery itself fails → log, write status to marker, stop
       Next run will retry. One retry per run — no infinite loops.
```

**Recovery does not block the main enrichment pipeline.** After recovery
completes (or fails), the main enrichment proceeds as usual for current-run
files.

### API Output

#### get_index_status

```typescript
// IndexStatus — replaces enrichment?: EnrichmentInfo and chunkEnrichment?: ChunkEnrichmentInfo
enrichment?: {
  [providerKey: string]: {
    file: {
      status: "healthy" | "in_progress" | "failed";
      unenrichedChunks?: number;
      message?: string;
    };
    chunk: {
      status: "healthy" | "in_progress" | "degraded" | "failed";
      unenrichedChunks?: number;
      message?: string;
    };
  };
};
```

Status mapping from marker to API:

| Marker status | API status  |
| ------------- | ----------- |
| pending       | (omitted)   |
| in_progress   | in_progress |
| completed     | healthy     |
| degraded      | degraded    |
| failed        | failed      |

Messages:

- `failed` (file): "Git file enrichment failed. All file-level signals missing.
  Will recover on next reindex."
- `failed` (chunk): "Chunk enrichment failed. Will recover on next reindex."
- `degraded` (chunk): "{N} chunks missing chunk-level signals. Will recover on
  next reindex."
- `in_progress`: "Enrichment in progress..."

#### get_index_metrics

```typescript
// IndexMetrics — add enrichment field
enrichment?: {
  [providerKey: string]: {
    file: {
      status: "healthy" | "degraded" | "failed";
      unenrichedChunks?: number;
    };
    chunk: {
      status: "healthy" | "degraded" | "failed";
      unenrichedChunks?: number;
    };
  };
};
```

### Migration

Existing collections have no `enrichedAt` timestamps. On first run of new
version, before recovery step:

1. Scroll all chunks in collection
2. For each chunk:
   - Has `git.file.commitCount` → set `git.file.enrichedAt = now()`
   - Has `git.chunk.commitCount` → set `git.chunk.enrichedAt = now()`
   - Missing either → leave without timestamp → recovery will pick up
3. Write migration marker to prevent re-running

Migration runs once per collection, is idempotent, uses batched `setPayload`.

### Breaking Changes

**Removed types:**

- `EnrichmentInfo` (src/core/types.ts:113-128)
- `ChunkEnrichmentInfo` (src/core/types.ts:131-135)
- `EnrichmentStatusValue` type alias

**Changed types:**

- `IndexStatus.enrichment` — from `EnrichmentInfo` to per-provider map
- `IndexStatus.chunkEnrichment` — removed, merged into
  `enrichment[provider].chunk`

**Changed Qdrant marker payload:**

- `payload.enrichment` — from flat `EnrichmentInfo` to
  `Record<string, ProviderEnrichmentMarker>`
- `payload.chunkEnrichment` — removed

## Affected Files

| File                                                         | Change                                                                |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `src/core/types.ts`                                          | Remove `EnrichmentInfo`, `ChunkEnrichmentInfo`; add new types         |
| `src/core/api/public/dto/ingest.ts`                          | Update `IndexStatus` DTO                                              |
| `src/core/api/public/dto/metrics.ts`                         | Add enrichment field to `IndexMetrics`                                |
| `src/core/domains/ingest/pipeline/enrichment/coordinator.ts` | Write `enrichedAt` timestamps, update marker per-level, recovery step |
| `src/core/domains/ingest/pipeline/enrichment/applier.ts`     | Write `enrichedAt` in same batch as signals                           |
| `src/core/domains/ingest/pipeline/enrichment/types.ts`       | New `ProviderEnrichmentMarker` types                                  |
| `src/core/domains/ingest/pipeline/status-module.ts`          | Read new marker format, map to API status                             |
| `src/core/api/internal/facades/explore-facade.ts`            | Add enrichment to `getIndexMetrics()`                                 |
| `src/core/api/internal/facades/ingest-facade.ts`             | Trigger recovery step before enrichment                               |
| `src/core/domains/ingest/reindexing.ts`                      | Trigger recovery step                                                 |
| `src/core/domains/ingest/pipeline/base.ts`                   | Trigger recovery step                                                 |
| `src/mcp/tools/code.ts`                                      | Update tool output schemas                                            |
| `src/core/domains/ingest/pipeline/enrichment/migration.ts`   | New file: enrichedAt migration                                        |
| `src/core/domains/ingest/pipeline/enrichment/recovery.ts`    | New file: recovery step logic                                         |

## Test Coverage Requirements

### Unit Tests — Recovery Step

**File-level recovery:**

- Prefetch failed on previous run → recovery scrolls chunks without
  `git.file.enrichedAt` → calls `buildFileSignals()` for found paths → applies
  signals + sets `enrichedAt` → verify `marker.file.unenrichedChunks === 0`
- Prefetch failed, recovery also fails → verify
  `marker.file.status === "failed"`, `marker.file.unenrichedChunks` reflects
  actual count
- No unenriched chunks → recovery is a no-op, no `buildFileSignals()` call

**Chunk-level recovery:**

- Chunk enrichment degraded on previous run → recovery scrolls chunks without
  `git.chunk.enrichedAt` → calls `buildChunkSignals()` → applies signals + sets
  `enrichedAt` → verify `marker.chunk.unenrichedChunks === 0`
- Chunk enrichment failed, recovery partially succeeds → verify
  `marker.chunk.unenrichedChunks` reflects remaining unenriched count
- Recovery itself fails for some paths → verify those paths remain without
  `enrichedAt`, `unenrichedChunks` count is accurate

**forceReindex:**

- Recovery step is skipped entirely when `forceReindex: true`

### Unit Tests — enrichedAt Timestamp Writing

**EnrichmentApplier.applyFileSignals():**

- Successful apply → every chunk in batch has `git.file.enrichedAt` set
- Intentional skip (file outside git log window) → chunk still gets
  `git.file.enrichedAt`
- Batch write fails (Qdrant error) → chunks do NOT have `git.file.enrichedAt` →
  appear in next recovery scroll

**EnrichmentApplier.applyChunkSignals():**

- Successful apply → every chunk has `git.chunk.enrichedAt` set
- Partial batch failure → only failed chunks lack `git.chunk.enrichedAt`
- buildChunkSignals() returns empty map for a file → chunks for that file still
  get `git.chunk.enrichedAt` (intentional skip)

### Unit Tests — Marker Status Transitions

- Pipeline start → both levels `pending`
- Prefetch starts → file `in_progress`, chunk `pending`
- Prefetch succeeds → file `completed`, chunk `pending`
- Prefetch fails → file `failed`, chunk `failed`
- Chunk enrichment starts → chunk `in_progress`
- Chunk enrichment completes fully → chunk `completed`, `unenrichedChunks === 0`
- Chunk enrichment partial → chunk `degraded`,
  `unenrichedChunks === actual count`

### Unit Tests — Heartbeat and Stale Detection

- During enrichment, `lastProgressAt` and `lastProgressChunks` update
  periodically in marker
- `get_index_status` with `in_progress` + `lastProgressChunks` unchanged +
  `lastProgressAt` > 2 min ago → status "in_progress" with stale warning
- `get_index_status` with `in_progress` + `lastProgressAt` < 2 min ago → status
  "in_progress", no warning
- Recovery step: previous run left `in_progress` with stale heartbeat → treated
  as `failed`, recovery proceeds
- Recovery step: previous run left `in_progress` with fresh heartbeat
  (concurrent run) → skip recovery, do not interfere

### Unit Tests — unenrichedChunks Cache Accuracy

**After every enrichment failure scenario, verify cached count matches
reality:**

- Prefetch fails → `file.unenrichedChunks` === total chunk count in collection
- Chunk enrichment fails for 5 of 20 files → `chunk.unenrichedChunks` === count
  of chunks belonging to those 5 files
- Applier batch write fails for 1 batch of 3 → `file.unenrichedChunks` === count
  of chunks in failed batch
- Recovery fixes 10 of 15 unenriched → `chunk.unenrichedChunks === 5`
- Recovery fixes all → `unenrichedChunks === 0`
- Full successful enrichment → both `unenrichedChunks === 0`

### Unit Tests — API Output

**get_index_status:**

- All healthy →
  `{ git: { file: { status: "healthy" }, chunk: { status: "healthy" } } }`
- File failed → `file.status === "failed"`, message present
- Chunk degraded → `chunk.status === "degraded"`, `unenrichedChunks` shown,
  message present
- In progress → `status === "in_progress"`, message present
- Stale in_progress (lastProgressChunks unchanged for > 2 minutes) → warning
  message indicating enrichment may have stalled

**get_index_metrics:**

- Enrichment health included in response
- Per-provider structure matches marker state

### Unit Tests — Migration

- Collection with existing `git.file.commitCount` → gets `git.file.enrichedAt`
- Collection with existing `git.chunk.commitCount` → gets `git.chunk.enrichedAt`
- Chunk without any git signals → no `enrichedAt` set → appears in recovery
- Migration runs once (marker written), second call is no-op
- Migration is idempotent — running twice produces same result

### Integration Tests — End-to-End Failure Scenarios

- **Prefetch crash**: Mock git log to throw → index completes → chunks in Qdrant
  without file signals → `get_index_status` shows `file.status: "failed"` → next
  `reindex_changes` runs recovery → file signals applied →
  `file.status: "healthy"`
- **Chunk enrichment crash**: Mock buildChunkSignals to throw for specific files
  → chunks stored without chunk signals → `get_index_status` shows
  `chunk.status: "degraded"` with correct `unenrichedChunks` → next reindex
  recovery fixes them
- **Qdrant batch write failure**: Mock batchSetPayload to fail for one batch →
  enrichment "succeeds" but some chunks lack enrichedAt → post-enrichment scroll
  detects them → `unenrichedChunks` reflects actual count
- **Incremental reindex regression**: File has git signals → file changes → old
  chunks deleted → enrichment fails → new chunks without signals →
  `get_index_status` shows degraded → next reindex recovery restores signals
- **Recovery itself fails**: Previous run degraded → recovery starts →
  buildFileSignals throws → marker still shows failed/degraded with correct
  count → next run retries
