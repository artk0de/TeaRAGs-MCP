# Git blame off the main thread — cold-reindex un-stall

**Status:** design (approved direction: Option A — blame in the churn-walk
worker infra). **Date:** 2026-07-05. **Bead:** tea-rags-mcp-dog1v. **Branch:**
`worktree-vcs-adapter`.

## Problem

On a COLD full reindex of a large monolith (taxdome: 34 442 files with < 30
commits routed to in-process es-git blame, 993 with ≥ 30 to CLI), the git
enrichment **stalls the whole pipeline**.

Root cause (confirmed by a live stack sample of the `index-codebase --__worker`
process, main thread 100 % CPU):

```
es_git::blame::blame_file_c_callback → git2 Repository::blame_file
  → git_blame__like_git → git_odb_read/pack_backend__read   (1623/1665 samples)
```

`GitEnrichmentProvider.populateBlameMap` (`provider.ts:388`) calls
`adapter.blameFile` (`provider.ts:426`) **inline on the main thread**. es-git
`blameFile` is a **SYNC napi** call — each blame blocks the event loop. On a
warm run blame is ~free (OID-keyed blame cache hits), so inline is fine — the
current design is correct for warm and was chosen on warm evidence
(`worker-pool.ts:27-30`: the full git provider in the enrichment ThreadTransport
pool with `collection-affinity` pinned to 1 worker → 4× slower; per-batch cost
dominated by walkCommits, "not blame"). On COLD there is no cache: 34 442 sync
blames × ~444 ms = ~4 h of **main-thread** blocking → embedding (async I/O on
the same event loop) stalls (observed: points frozen at ~12 %, remote ollama
idle, `WORKER_EXIT code null` / manual kill).

Adjacent, already-fixed this session (do NOT redo):

- OOM storm — `getRunDiscovery` now single-flights the run-scoped
  `git log --numstat` (`02eca2fe`). Bounded to ONE discovery (~1.4 GB), not N.
- es-git deep-file blame stall — depth-routed hybrid, deep → CLI capped
  (`b770e18d`). Correct, but a different axis (the storm is `git log`; the stall
  is the sync `git blame` on main).

## Current architecture (verified)

| Component                                             | Isolation                                                                            | Evidence                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Chunker (tree-sitter)                                 | separate **PROCESSES** (`ProcessTransport`) — tree-sitter is not thread-safe (yl9tv) | `chunker/infra/pool.ts:71`                                                                |
| Enrichment dispatch (codegraph)                       | worker **THREADS** (`ThreadTransport`), `dispatch: "collection-affinity"`            | `enrichment/executor/worker-pool.ts:103`, `factory.ts:521`                                |
| Git churn-WALK (git log + cat-file + structuredPatch) | ONE dedicated worker **THREAD**                                                      | `churn-walk/thread.ts:95` (single `new Worker`)                                           |
| Git BLAME + file/chunk assemble                       | **INLINE, main thread**                                                              | `provider.ts:426`; blame passed to the walk worker as `job.blameByPath` (`worker.ts:109`) |

Key facts the design leans on:

- The churn-walk worker (`worker.ts`) **already builds its own `VcsGitAdapter`
  in-thread** (`adapterFor`, worker.ts:45-52) and owns a per-repoRoot
  `createBlobBatchReader`. es-git already runs in THAT one worker thread today.
- The walk worker today **receives** `job.blameByPath` (computed inline on main)
  and feeds it to `buildChunkChurnMapUncached` for per-range chunk ownership.
- Blame is consumed in TWO places: **chunk** signals (in the walk worker, via
  `blameByPath`) and **file** signals (on main, `fileSignalTransform` →
  `assembleFileSignals(..., blameLines)`, provider.ts:158-168).

## Chosen approach — Option A: compute blame inside the walk-worker infra

Move the sync `adapter.blameFile` calls off the main thread into the walk-worker
infrastructure (which already runs es-git on a worker thread). Main keeps the
async, single-flighted `git log --numstat` discovery (non-blocking) and the
run-scoped shared state; workers do the sync blame.

Two sub-decisions that Option A forces:

### A1. One worker is not enough — pool it

`ChunkChurnWalkThread` is a SINGLE worker (thread.ts:95). Blame moved onto one
worker is still **serial**: 34 442 × 444 ms ≈ 4 h on that thread. Embedding
un-blocks (main is free) but the run does not finish in time. Blame MUST run
across N workers. So `ChunkChurnWalkThread` becomes a small **pool**
(`ChunkChurnWalkPool`, N = `INGEST_TUNE_ENRICHMENT_POOL_SIZE`, default 4),
round-robin per batch.

### A2. Thread pool vs process pool — es-git thread-safety is the gate → RESOLVED GREEN

A pool of es-git worker THREADS raises the yl9tv risk: node native addons
(tree-sitter) are NOT thread-safe at process scope — concurrent `parse()` from
two threads corrupts shared native state. **Is es-git (napi-rs / libgit2) the
same?** libgit2 is thread-safe only if built with threads AND each thread uses
its own repo handle AND `git_libgit2_init` refcounts correctly. Today es-git
runs in exactly ONE walk-worker thread, so this has never been exercised
concurrently.

**Step 0 (spike, DONE 2026-07-05 — `scripts/spikes/esgit-thread-safety.js`):**
each of K `worker_threads` opens its OWN `openRepository` handle (the target
model — every worker builds its own `EsGitAdapter.open`) and blames the SAME 12
shallow multi-hunk files, M iterations, concurrently with the main thread also
blaming. Every observed per-hunk signature (`start:len:finalCommitId`) is
compared to a single-thread baseline; the isolation control re-runs
single-thread to prove the files are deterministic to begin with.

**Result: GREEN.** 4×20 and 8×50 (worker×iter) runs — 4 800 concurrent blames
across 9 threads, 33 s of genuinely-parallel native es-git, **every sig ==
baseline, zero `Napi::Error`, zero hunk-count variance.** Unlike tree-sitter
(yl9tv), es-git/libgit2 is thread-safe with per-thread repo handles — the
napi-rs binding ships with libgit2 threading, and each adapter owning its own
`Repository` handle isolates per-thread object state.

→ **Decision: es-git thread pool (`worker_threads`)** — cheapest transport, no
process-boundary marshalling. (The rejected RED branch — `ProcessTransport`
process pool like the chunker — is not needed; recorded here only as the path we
did NOT take.)

The rest of the design is transport-agnostic; only the pool's transport is now
pinned to threads.

## Data flow (target)

1. **Main** (per embedding batch, `streamFileBatch`): ensure the run discovery
   (`getRunDiscovery`, single-flight, ONE async `git log --numstat`) and
   `bugFixShas` are resolved ONCE; slice the batch's churn.
2. **Main → worker**: dispatch a job carrying
   `{ batchPaths, slicedChurn, commitCounts, bugFixShas, gitAdapterKind }` (all
   structured-clone-safe; NO adapter instance crosses postMessage — the worker
   builds its own).
3. **Worker** (one of N, round-robin): with its own es-git adapter + blob
   reader, (a) **compute blame** for the batch's files — hybrid routing
   preserved (shallow → in-process es-git on THIS worker thread; deep ≥
   threshold → CLI under the existing per-adapter cap), (b) run
   `buildChunkChurnMapUncached` using the freshly-computed blame, (c) return
   `{ chunkOverlays, blameByPath, dirtyBlameCacheEntries, stats }`.
4. **Main**: from the returned `blameByPath`, populate `blameByChurnData` /
   `blameByRelPath` so `fileSignalTransform` (file signals) sees ownership;
   merge `dirtyBlameCacheEntries` into the persistent store.

This keeps blame computed EXACTLY ONCE (in the worker) and reused for both chunk
and file signals — no double blame, no main-thread sync blame.

## Components

- `churn-walk/pool.ts` — `ChunkChurnWalkPool` (rename/extend
  `ChunkChurnWalkThread`): N workers, round-robin `walk(job)`, drain/close
  fan-out. Preserve the existing single-worker lifecycle semantics per worker.
- `churn-walk/worker.ts` — add blame computation before
  `buildChunkChurnMapUncached` (reuse the provider's hybrid routing; the worker
  already has the adapter). Return `blameByPath` + dirty cache entries.
- `churn-walk/protocol.ts` — job gains `commitCounts` (for the depth hint) and
  drops the inbound `blameByPath`; response gains `blameByPath` +
  `dirtyBlameCacheEntries`.
- `provider.ts` — `populateBlameMap` no longer calls `adapter.blameFile`; it
  consumes the worker's returned `blameByPath`. The blame CACHE read moves to
  the worker (OID-keyed); the WRITE stays on main at finalize (A3 below).
- `chunk-phase.ts` — owns the pool lifecycle (mirrors today's single-thread
  hook).
- `bootstrap/factory.ts` — the inline-git note (`:255-266`) updated; N from
  `INGEST_TUNE_ENRICHMENT_POOL_SIZE`.

### A3. Blame cache concurrency

Today the OID-keyed blame cache (`GitBlameStore`, in-memory + per-root JSON on
disk) lives on the single main provider instance (`v2mlw`). With N workers each
holding their own provider, concurrent WRITES to one JSON file clobber.
Decision: **workers READ the store (or receive the relevant OID→lines slice),
compute misses, and RETURN dirty entries; MAIN merges + persists once at
finalize.** No concurrent writers. Warm reuse still works (worker reads the
shared read-only store snapshot per root).

## Testing

- **Spike test** (Step 0): concurrent es-git blame across threads is
  deterministic (or proves it is not → process pool).
- **Spawn/latency pin**: a streaming run of N concurrent batches keeps the MAIN
  thread responsive — assert the main event loop is not blocked (e.g. a timer /
  embedding heartbeat fires within budget while blame runs).
- **Equivalence**: file + chunk signals from the worker-blame path DEEP-EQUAL
  the current inline path on the real-git fixture (extend
  `file-discovery.test.ts` / the blame-cache tests). Business-logic tests
  immutable — move/extend, don't rewrite.
- **Cache**: dirty-entry merge on main equals the inline single-writer result;
  no double blame (spawn/hunk-count pin).
- **Concurrency cap**: CLI-blame semaphore still bounds deep-file spawns
  (per-worker cap × N workers = the memory budget to size).

## Risks / open items

1. es-git thread-safety (Step 0 gate) — **RESOLVED GREEN → thread pool** (A2).
2. Per-worker CLI-blame memory: cap × N workers must stay under budget (size
   it).
3. `bugFixShas` / discovery are per-run: computed once on main, passed in —
   never per-worker (would re-introduce the storm).
4. Warm-path postMessage overhead on cheap cache-hit blame — accept (cold is the
   target; warm was already fast).

## Out of scope

- Reducing blame SCOPE (gating which files blame) — orthogonal; can compound
  later.
- Reverting the depth-routed hybrid or the single-flight discovery — both stay.
