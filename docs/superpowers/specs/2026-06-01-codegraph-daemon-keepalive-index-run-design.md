# Codegraph Daemon Keep-Alive for the Index Run

**Date:** 2026-06-01 **Status:** Design approved, pending implementation (TDD)
**Area:** `bootstrap/factory.ts`, `api/internal` ingest wiring,
`adapters/duckdb/daemon`

## Problem (root-caused live)

During `force_reindex`, file-level codegraph enrichment hangs for minutes and
its markers never finalize. Root cause, proven by live repro + stack dump +
code:

- The codegraph DuckDB daemon is spawned **only** lazily by the bootstrap pool's
  `ensure()` wrapper (`wireCodegraph`, `factory.ts:392-398` →
  `ensureCodegraphDaemon`).
- The daemon **self-terminates after 30 s idle** (`IDLE_SHUTDOWN_MS = 30_000`,
  `lifecycle.ts`), where "idle" = the refs file (live socket count) at ≤ 0.
- A `force_reindex`'s chunk-write phase takes ~154 s (≫ 30 s). During that
  window nothing holds a daemon socket, so the daemon idle-dies before
  enrichment begins.
- Enrichment runs in **worker_threads**. The worker rebuilds the codegraph
  provider via `createCodegraphEnrichmentProvider` (`factory.ts:151`), whose
  pool has the daemon socket path but **no `ensure`/spawn wrapper** — the worker
  can only **connect**, never spawn.
- So at enrichment time the daemon is gone, the worker's
  `DaemonGraphDbClient.init()` connect fails, retries ~5 s, throws — repeated
  per queued codegraph batch on the single affinity-pinned thread. codegraph
  file enrichment stalls; the run's file markers stay `in_progress`. git
  (stateless, no daemon) is unaffected.

Evidence: enrichment frozen 9.5+ min, no codegraph events, no daemon process;
stack dump showed a worker in
`PipeWrap.Connect`/`uv_pipe_connect2`/`AfterConnect` connect-retry; chunk-write
154 s ≫ 30 s idle window.

## Goal

Keep the codegraph daemon alive for the **entire index run** (chunk-write +
enrichment), so worker enrichment always connects to a live daemon. Chosen
approach: **hold one real keep-alive socket** for the run duration (refs ≥ 1
suppresses idle shutdown), released at run end.

## Why a held socket, not a refs-file bump

`factory.ts:241-248` is explicit: `refs` = number of live
`(collection, process)` sockets, owned solely by `entry.ts` (connect +1, close
−1). A per-process refs-file bump "would pin `refs` above 0 forever — the exact
bug that kept the daemon holding the lock." The keep-alive therefore uses the
**legitimate mechanism**: open a genuine `DaemonGraphDbClient` socket (which
increments refs via `entry.ts` on connect) and close it at run end (decrements).
No direct `incrementRefs` call.

## Design

### Contract

New interface in `contracts/` (no-op when codegraph is disabled):

```ts
export interface IndexRunDaemonGuard {
  /**
   * Ensure the codegraph daemon is alive and hold a keep-alive connection for
   * the duration of an index run. Returns a release handle that MUST be called
   * (in a finally) when the run ends — on success, error, or crash — or the
   * daemon will never idle-shut-down (refs pinned > 0).
   */
  begin(collectionName: string): Promise<IndexRunDaemonRelease>;
}
export type IndexRunDaemonRelease = () => Promise<void>;
```

### Implementation (bootstrap / composition layer)

`bootstrap` owns `daemonPaths`, `ensureCodegraphDaemon`, and may import
concretes. `wireCodegraph` produces a `CodegraphIndexRunDaemonGuard`:

- `begin(collection)`:
  1. `ensureCodegraphDaemon(daemonPaths, rootDir, resources)` — spawn if dead
     (single-flighted; no-op if already alive).
  2. `const client = new DaemonGraphDbClient(daemonPaths.socketPath, collection); await client.init();`
     — opens one real socket (refs +1). `init()`'s bounded 5 s retry absorbs the
     detached-spawn → connect race.
  3. return `async () => { await client.close(); }` — closes the socket (refs
     −1).
- When `codegraph.enabled` is false, `wireCodegraph` returns `undefined`; the
  composition root substitutes a **no-op guard** (`begin` returns a no-op
  release).

A `begin` that fails to establish the keep-alive (e.g. daemon spawn failed) MUST
NOT abort the index — it logs and returns a no-op release. The run proceeds; if
the daemon is genuinely unavailable, codegraph enrichment degrades exactly as
the typed-error path already handles (marker `failed`), but indexing is never
blocked by the keep-alive itself.

### Wiring (run boundary)

Inject the guard into the ingest path (via `IngestFacade` deps, per the DI
wiring chain). At the start of an index run, before chunk-write:

```ts
const release = await this.daemonGuard.begin(collectionName);
try {
  // … existing index run: chunk-write → startEnrichment → awaitCompletion …
} finally {
  await release();
}
```

The `finally` is the load-bearing invariant: release on success, throw, or any
early exit. `release()` itself swallows errors (close-of-already-closed is a
no-op) so it never masks the run's real outcome.

### Lifetime

The keep-alive spans exactly one index run (begin → finally release). After
release, refs decays to its natural value; if no other socket is open the daemon
idle-shuts-down 30 s later — restoring normal lifecycle. The daemon is NOT
pinned for the server lifetime.

## Out of scope

- `ThreadPool.dispatch` has no liveness/timeout bound — a worker that never
  posts back hangs the pool. This is a real defensive gap but NOT the root cause
  (the connect path is bounded; the daemon-absence is the cause). Tracked as a
  separate beads issue; a dispatch-level timeout is a backstop, not this fix.
- The terminal-only enrichment marker redesign (separate spec/plan) is
  orthogonal: it makes a stalled run's status truthful, this fix removes the
  stall.

## Testing strategy (TDD)

1. **Guard begin/release lifecycle** — `begin(coll)` calls
   `ensureCodegraphDaemon` then opens a client + `init()`; the returned release
   calls `client.close()`. (Mock `ensureCodegraphDaemon` +
   `DaemonGraphDbClient`.)
2. **No-op guard when codegraph disabled** — composition substitutes a no-op;
   `begin` returns a release that is safe to call and does nothing.
3. **begin failure is non-fatal** — when `init()` throws, `begin` resolves to a
   no-op release (logged), never rejects; index run proceeds.
4. **Run boundary releases on all paths** — IngestFacade calls `release()` in a
   finally on both success and thrown error (spy the release, throw mid-run,
   assert release called once).
5. **Live validation** (post-implementation, via `test-self-reindex`):
   force_reindex on `tea-rags-worktree` → all four enrichment levels reach
   `healthy`, daemon stays alive across chunk-write, no connect-retry stall.

## Deep-silo note

Commits touching `factory.ts` / `pool.ts` (deep-silo per
`.claude/rules/silo-pairing.md`) MUST carry a `Why:` line.

## Cross-references

- Root-cause investigation: this session's live repro (stack dump, 154 s vs 30
  s).
- Daemon lifecycle: `adapters/duckdb/daemon/lifecycle.ts`, `entry.ts`.
- Spawn: `bootstrap/factory.ts:250` `ensureCodegraphDaemon`.
- DI wiring chain: `.claude/rules/wiring.md`.
