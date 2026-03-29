# Ingest Risk Zones Hardening

**Date:** 2026-03-29 **Status:** Approved **Scope:** daemon.ts,
status-module.ts, indexing.ts, reindexing.ts

## Motivation

Signal-driven bug-hunt analysis (`rank_chunks` with `bugHunt` and `hotspots`
presets) identified 4 risk zones in the ingest pipeline:

| File               | bugFixRate     | relativeChurn | Test coverage      |
| ------------------ | -------------- | ------------- | ------------------ |
| `daemon.ts`        | 58% concerning | 1.41          | 43 lines (minimal) |
| `status-module.ts` | 50% concerning | 2.88 high     | 776 lines (good)   |
| `indexing.ts`      | 50% concerning | 2.45 high     | 585 lines (good)   |
| `reindexing.ts`    | 50% concerning | 1.54          | 689 lines (good)   |

A fifth candidate (`contracts/errors.ts`, bugFixRate 56%) was triaged as a false
positive — high commit frequency reflects growth, not bugs.

## Phase 1: daemon.ts — Race Conditions and Orphaned Processes

### Problems

1. **Concurrent startup race.** Two MCP servers pass `isDaemonAlive() === false`
   simultaneously, both call `cleanupDaemonFiles()` + `spawn()`. Result: two
   daemons, one orphaned.
2. **Orphaned process on health timeout.** Spawn succeeds, PID written, health
   check fails after 30s. `SIGKILL` on a detached process may not arrive.
   PID/port files are cleaned up, but the process survives.
3. **Non-atomic ref counting.** `readRefs()` + `writeFileSync()` across two
   processes can lose an increment.

### Solution: DaemonLock

New file: `src/core/adapters/qdrant/embedded/daemon-lock.ts`

```typescript
class DaemonLock {
  acquire(lockPath: string, timeoutMs: number): { fd: number } | null;
  release(fd: number): void;
  isHeld(lockPath: string): boolean;
}
```

- Wraps `fs.openSync(path, 'wx')` for exclusive lock before spawn.
- If lock file exists, wait and attach to running daemon instead.
- Used in `ensureDaemon()` and `incrementRefs()`/`decrementRefs()`.
- Single synchronization point replaces scattered file operations.

Changes to `ensureDaemon()`:

- Acquire `DaemonLock` before any spawn/attach logic.
- After spawn: verify child is alive via `process.kill(pid, 0)` before writing
  PID file.
- On health timeout: `SIGTERM` first, wait 2s, then `SIGKILL`. Verify process is
  dead via `process.kill(pid, 0)` before cleanup.
- Release lock in `finally` block.

### New Tests

- `ensureDaemon()` happy path (mock spawn + probeHealth)
- Attach to existing daemon (mock isDaemonAlive + probeHealth)
- Health timeout cleanup (mock spawn + failing probeHealth)
- Stale PID file cleanup (process dead but files remain)
- Concurrent acquire returns null (lock already held)

## Phase 2: status-module.ts — Recursion and Untyped Payload

### Problems

1. **Recursion in `getStatusFromCollection()`** (lines 184, 190). After deleting
   a stale collection, calls itself. Cyclic alias or missing target leads to
   infinite recursion.
2. **Untyped payload.** All marker fields accessed via optional chaining without
   types. `completedAt` handles 3 types (string, number, Date) — evidence of
   historical format fixes.
3. **`as` casts.** `as EnrichmentMarkerMap` (line 158), `as Date` (line 225) —
   no runtime validation.

### Solution: IndexingMarkerCodec + resolveStaleCollection()

New file: `src/core/domains/ingest/pipeline/indexing-marker-codec.ts`

```typescript
interface IndexingMarkerPayload {
  indexingComplete: boolean;
  startedAt?: string; // ISO 8601
  completedAt?: string; // ISO 8601 (always string, converted on write)
  lastHeartbeat?: string; // ISO 8601
  embeddingModel?: string;
  enrichment?: EnrichmentMarkerMap;
}

function parseMarkerPayload(
  raw: Record<string, unknown>,
): IndexingMarkerPayload;
function serializeMarkerPayload(
  marker: IndexingMarkerPayload,
): Record<string, unknown>;
```

- `parseMarkerPayload()` — runtime validation, normalizes `completedAt` to
  string. Used by `StatusModule`.
- `serializeMarkerPayload()` — writes canonical format. Used by
  `storeIndexingMarker()`.
- No more `as` casts or `typeof` checks in business logic.

Extract `resolveStaleCollection()` from `getStatusFromCollection()`:

```typescript
private async resolveStaleCollection(
  staleCollection: string,
  baseName: string,
): Promise<{ collection: string } | { notIndexed: true }>
```

- Handles stale cleanup: alias fallback, legacy real collection, empty first
  index.
- Returns resolved collection name or not_indexed signal.
- `getStatusFromCollection()` calls it once — no recursion.

### New Tests

- `resolveStaleCollection()` — alias points to working version
- `resolveStaleCollection()` — no alias, no real collection, empty → not_indexed
- `resolveStaleCollection()` — no alias, real collection exists → fallback
- `parseMarkerPayload()` — valid data, invalid data, missing fields
- `parseMarkerPayload()` — completedAt as string, number, undefined

## Phase 3: indexing.ts + reindexing.ts — Unified Error Handling

### Problems

1. **indexing.ts** (lines 113-122): raw errors caught, wrapped in
   `stats.status = "failed"` and **returned** instead of thrown. MCP tool
   receives a "successful" response with `errors[]` inside.
2. **reindexing.ts** (lines 101-106): raw errors wrapped in `ReindexFailedError`
   and thrown. Correct but inconsistent with indexing.
3. **Race marker-before-alias** in indexing.ts (lines 104-105):
   `storeIndexingMarker()` then `finalizeAlias()`. If alias fails, marker is
   written but alias not switched — next `getIndexStatus()` sees stale versioned
   collection.

### Solution: wrapUnexpectedError() + alias-before-marker

Add to `BaseIndexingPipeline`:

```typescript
protected wrapUnexpectedError(
  error: unknown,
  ErrorClass: new (message: string, cause?: Error) => TeaRagsError,
): never {
  if (error instanceof TeaRagsError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  throw new ErrorClass(message, error instanceof Error ? error : undefined);
}
```

Changes to `indexing.ts`:

- Remove `stats.status = "failed"` path. Raw errors → `IndexingFailedError` (new
  error class, mirrors `ReindexFailedError`).
- Reorder: `finalizeAlias()` before `storeIndexingMarker()`. If alias fails,
  marker not written, collection stays stale and is cleaned up normally.

Changes to `reindexing.ts`:

- Replace inline error wrapping with
  `this.wrapUnexpectedError(error, ReindexFailedError)`.

### Breaking Change

Consumers that checked `stats.status === "failed"` will receive an exception
instead. This is intentional — `stats.status = "failed"` was a leaky
abstraction. `errorHandlerMiddleware` in MCP layer already handles all typed
errors correctly.

### New/Updated Tests

- indexing.ts: raw error now throws `IndexingFailedError`
- indexing.ts: alias failure → marker not written
- Update existing tests that assert `stats.status === "failed"` → expect throw
- reindexing.ts: verify `wrapUnexpectedError` delegates correctly

## Phase 4: Integration

Depends on phases 1-3 (phases 1-3 are independent of each other).

- Verify all error paths propagate correctly through MCP error handler
- End-to-end: indexing with alias switch + status check
- Verify daemon lock does not interfere with normal startup flow

## Implementation Order

| Phase | What                                    | Depends on | Files touched                                                        |
| ----- | --------------------------------------- | ---------- | -------------------------------------------------------------------- |
| 1     | DaemonLock + daemon.ts hardening        | —          | daemon.ts, daemon-lock.ts (new)                                      |
| 2     | IndexingMarkerCodec + status-module.ts  | —          | status-module.ts, indexing-marker-codec.ts (new), indexing-marker.ts |
| 3     | wrapUnexpectedError + error unification | —          | base.ts, indexing.ts, reindexing.ts, errors.ts                       |
| 4     | Integration: alias-before-marker        | Phase 3    | indexing.ts                                                          |

Phases 1-3 are independent and can be parallelized.
