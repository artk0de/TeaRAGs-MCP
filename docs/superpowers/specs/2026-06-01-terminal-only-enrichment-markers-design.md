# Terminal-Only Enrichment Markers + runId-Staleness

**Date:** 2026-06-01 **Status:** Design approved, pending spec review **Area:**
`src/core/domains/ingest/pipeline/enrichment/` + health mapping

## Problem

Stale / incorrect enrichment statuses (`get_index_status` showing `healthy` when
enrichment never finished) reappear every few iterations of trajectory / ingest
edits. Two mechanisms, working together, produce them:

### 1. `pending → healthy` observability bug (confirmed)

`health-mapper.ts:28`:

```ts
if (!level || level.status === "pending") {
  return { status: "healthy" };
}
```

`markStart` persists `chunk: { status: "pending" }`. If a run never reaches its
finalizers, `chunk` stays `pending` forever and is rendered as **healthy**. This
is the exact state observed live (runId `34bcbb0f`:
`file:in_progress, chunk:pending`, chunk shown as healthy).

### 2. Marker is a mutable multi-phase state machine on one shared point

Markers live at `INDEXING_METADATA_ID` under `payload.enrichment`. The current
write sequence is:

1. `markStart` — `file:in_progress, chunk:pending` for **all** providers (1 RMW
   write)
2. `markFileFinal` × N providers (CompletionRunner step 4 — N sequential RMW
   writes)
3. `markChunkFinal` × N providers (CompletionRunner step 8 — N sequential RMW
   writes)

Every write is a client-side read-modify-write (`marker-store.ts:146-192`): read
the whole `enrichment` object, deep-merge, write it back. This is stale
whenever:

- **(a)** `run()` hangs/crashes before its finalizers (steps 4/8 never run) →
  markers frozen at `markStart` state → false `healthy`.
- **(b)** Concurrent writers (providers parallelised by fix H, plus recovery)
  race between the read and the write round-trips and clobber each other.

There is no invariant tying the persisted marker to reality. `wait:true`
serialises writes within one coordinator but does not prevent (a), nor races
across processes / recovery.

## Goal

Make a false `healthy` **structurally impossible**, so stale statuses cannot
reappear across iterative edits. Reject derive-from-data (scroll cost on large
collections is too expensive). Two chosen directions:

- **(2) Terminal-only marker** — never persist `in_progress`/`pending`; write
  each marker exactly once, atomically, with a terminal status; absence = not
  finished.
- **(3) runId-staleness** — every marker carries the `runId` that produced it; a
  run-pointer records the active/latest `runId`; `get_index_status` reports a
  marker from a stale (or missing) run as `in_progress`/`crashed`, never
  `healthy`.

## Data model

`payload.enrichment` on `INDEXING_METADATA_ID`:

```jsonc
enrichment: {
  "_run": {                     // the ONLY pre-completion write
    "runId": "34bcbb0f",
    "startedAt": "ISO",
    "lastProgressAt": "ISO"     // throttled heartbeat, advanced on real apply progress
  },
  "git": {
    "file":  { "runId", "status": "completed|degraded|failed", "completedAt",
               "durationMs", "unenrichedChunks", "matchedFiles", "missedFiles", "errorMessage?" },
    "chunk": { "runId", "status", "completedAt", "durationMs", "unenrichedChunks", "errorMessage?" }
  },
  "codegraph.symbols": { "file": { … }, "chunk": { … } }
}
```

**Invariants:**

- Per-kind markers persist **only** terminal statuses: `completed`, `degraded`,
  `failed`. Never `pending`/`in_progress`.
- Each per-kind marker carries its own `runId`.
- `_run` is the only payload written before a level completes.

The four enrichment kinds (`git.file`, `git.chunk`, `codegraph.symbols.file`,
`codegraph.symbols.chunk`) each own a **disjoint nested key** and are written
independently, matching the established "all 4 kinds fully parallel" design
intent.

## Write path — nested-key `set_payload`, no read-modify-write

`QdrantManager.batchSetPayload` already supports a `key` parameter that maps to
Qdrant's `set_payload: { payload, points, key }` (`client.ts:896`). Qdrant
serialises payload updates per point server-side, so concurrent writes to
disjoint nested keys (`enrichment.git.file` vs `enrichment.git.chunk`) cannot
lose each other — each replaces only its own subtree, preserving siblings. This
is fundamentally race-free, unlike the current client-side read-merge-write
(separate read and write round-trips).

`.qdrant-required-version` = `1.17.0` supports the `key` parameter — no version
bump needed.

| When                                     | Payload written                                                                           | Nested key                                | wait    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------- | ------- |
| `beginRun`                               | `{ runId, startedAt, lastProgressAt }`                                                    | `enrichment._run`                         | `true`  |
| heartbeat (throttled, on apply progress) | `{ runId, startedAt, lastProgressAt }` (full object)                                      | `enrichment._run`                         | `false` |
| (provider, file) done — step 4           | `{ runId, status, completedAt, durationMs, unenrichedChunks, matchedFiles, missedFiles }` | `enrichment.<provider>.file`              | `true`  |
| (provider, chunk) done — step 8          | `{ runId, status, completedAt, durationMs, unenrichedChunks }`                            | `enrichment.<provider>.chunk`             | `true`  |
| prefetch failed / recovery               | both levels terminal                                                                      | two disjoint keys (one `batchSetPayload`) | `true`  |

**Key consequence:** a run that hangs after step 4 (file written) but before
step 8 leaves `enrichment.<provider>.chunk` **absent**. The health mapper sees
absent + active `runId` → `in_progress`, never `healthy`. The bug is dead by
construction.

### Heartbeat

`_run.lastProgressAt`, advanced on **real apply progress** (file or chunk
signals applied), throttled to at most once per ~15–30 s. The coordinator holds
`runId` and `startedAt` in `RunState`, so each heartbeat rewrites the **whole
`_run` object** (`key: "enrichment._run"`) — no data loss, no scalar-at-leaf
dependency on Qdrant. A hung run stops producing applies → `lastProgressAt`
freezes → detected as stalled, then crashed. The heartbeat carries no per-level
status, so it can never render as `healthy`.

## Read path — `health-mapper.ts` rewrite

```
run = enrichment._run
for each providerKey (skip "_run"):
  health[providerKey] = { file: mapLevel(marker.file, run), chunk: mapLevel(marker.chunk, run) }

mapLevel(marker, run):
  if marker exists AND run AND marker.runId === run.runId:   # finished current run
    completed → healthy | degraded → degraded | failed → failed (+errorMessage)
  else if !run:                                              # legacy / never-run (back-compat)
    legacy branch (see below)
  else:                                                      # absent OR from a stale run
    elapsed = now - parse(run.lastProgressAt ?? run.startedAt)
    elapsed > CRASHED_THRESHOLD_MS → failed   ("crashed … will retry on next reindex")
    elapsed > STALE_THRESHOLD_MS   → in_progress ("stalled — no progress in N min")
    else                           → in_progress ("in progress…")
```

The `status === "pending" → healthy` branch is removed (no `pending` status
exists). `STALE_THRESHOLD_MS` / `CRASHED_THRESHOLD_MS` keep their meaning but
key off `_run` timestamps instead of per-level `startedAt`/`lastProgressAt`.

**Reindex correctness:** after a successful run all four markers carry
`runId === _run.runId`. The next `beginRun` overwrites `_run.runId` with a new
id; the four markers still carry the _old_ id → `runId` mismatch → each renders
`in_progress` until it completes for the new run and overwrites its key. During
a reindex, status truthfully shows `in_progress`, never last-run `healthy`.

## Type changes

`types.ts`:

- Persisted `EnrichmentLevelStatus` (in `EnrichmentLevelMarker`) becomes
  `"completed" | "degraded" | "failed"`. `pending` / `in_progress` are
  **derived-only** and remain in the API-facing `EnrichmentLevelHealth`
  (`"healthy" | "in_progress" | "degraded" | "failed"`).
- New `_run` marker type:
  `{ runId: string; startedAt: string; lastProgressAt: string }`.
- `EnrichmentMarkerMap` gains the optional `_run` entry; per-provider entries
  keep `{ runId, file, chunk }` but `file`/`chunk` are terminal-only.
- Per-level `lastProgressAt` / `lastProgressChunks` removed (moved to `_run`).
- New input types for terminal writes carrying `runId`.

## Component changes

- **marker-store.ts** — `markStart` → `markRunStart` (writes `_run`); add
  `heartbeat`; `markFileFinal`/`markChunkFinal` rewritten as nested-key terminal
  writes carrying `runId`; `markPrefetchFailed`/`markRecoveryResult` rewritten
  as nested-key terminal writes (carrying `runId`). The private deep-merge
  `write()` is replaced by a thin nested-key writer (`setPayload` with `key`).
  `read`, `getRunId` keep working against the new shape.
- **coordinator.ts** — `markStartPromise` → `markRunStartPromise`; add a
  throttled heartbeat fired on apply progress; pass `runId` through to terminal
  writes.
- **completion-runner.ts** — steps 4 and 8 call the new terminal-write API
  (per-kind, carrying `runId`). Step structure unchanged.
- **recovery.ts** — `markRecoveryResult` stamps the snapshotted `runId`.
- **health-mapper.ts** — full rewrite per the read path above.
- **client.ts** — add a `key?` option to `setPayload` (single-op nested write)
  if not already present; `batchSetPayload` already supports `key`.

## Out of scope

The underlying **`completion-runner.run()` hang** on `filePhase.drain()` (a
`fileWork` promise that never settles) is a separate defect. This redesign makes
its symptom truthful (`in_progress` → `crashed`) instead of a false `healthy`,
but does not fix the hang. Tracked as a separate beads issue.

## Back-compat

Collections indexed before this change have the old marker shape (per-level
`in_progress`/`pending`, no `_run`). When `_run` is absent the mapper uses a
legacy branch: terminal statuses render as before, but legacy `pending` maps to
`in_progress` (never `healthy`), and legacy `in_progress` keeps the existing
time-based crash check on the per-level `startedAt`. One reindex rewrites the
point into the new shape. Low risk — the metadata point is rewritten on every
reindex.

## Testing strategy (TDD)

Failing tests first, per project rule. Priority scenarios:

1. **No false healthy on hang** — write `_run` + `git.file` terminal but no
   `git.chunk`; assert chunk health = `in_progress`, not `healthy`.
2. **Stale runId** — markers carry runId `A`, `_run.runId = B`; assert all
   levels render `in_progress` regardless of persisted terminal status.
3. **Race-free concurrent terminal writes** — concurrent nested-key writes to
   the four kinds preserve all four (no lost write).
4. **Crash vs stalled vs in-progress** — drive `_run.lastProgressAt` across the
   thresholds; assert correct derived status.
5. **Successful run** — four terminal markers with matching runId →
   `healthy`/`degraded`/`failed` rendered from persisted status.
6. **Back-compat** — legacy shape (no `_run`) renders without crash; legacy
   `pending` → `in_progress`.
7. **Recovery** — `markRecoveryResult` stamps runId; stale-runId guard in
   `recoverAll` still holds.

## Cross-references

- `.claude/rules/silo-pairing.md` — `recovery.ts` is deep-silo (`Why:` line
  required on commits touching it).
- Marker write-path notes: `marker-store.ts` header comment.
- Qdrant nested-key set_payload: `client.ts` `batchSetPayload`.
