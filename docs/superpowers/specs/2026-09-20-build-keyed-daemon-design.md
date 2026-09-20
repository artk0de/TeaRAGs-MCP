# Build-Keyed Codegraph Daemon (42hno path c)

- **Date:** 2026-09-20
- **Bead:** tea-rags-mcp-42hno (P1, `needs-design`)
- **Status:** design approved by user 2026-09-20, with the nlls amendment
- **Prerequisite:** tea-rags-mcp-nlls (per-collection idle eviction) ships FIRST
  as its own bead — dependency edge recorded in beads

## Problem

One socket path + one daemon identity serve every build. The first client whose
build fingerprint differs from the running daemon's drains it, cutting every
other session's in-flight requests — worker-thread pools have no respawn hook
and reject with `daemon connection failed: write EPIPE` (the 2026-08-17 class).
1wr7p only stops a client from draining a daemon matching its OWN on-disk build;
a daemon from another checkout is still treated as foreign. zgcmo (path b,
merged `f1611d8c4`) added the interim guard: the daemon refuses a shutdown drain
while another connection has writes in flight
(`CodegraphDaemonDrainRefusedError`, 503) — the draining side gets the typed
error instead of cutting live writers.

## Decision

Namespace the daemon per build: socket/pid/port/refs/lock files keyed by the
build fingerprint, so builds never drain each other. The DuckDB per-file RW lock
becomes the arbiter for shared collections: daemons release idle handles (nlls)
and clients do a bounded retry on `DuckDbOpenFailedError`.

Rejected: daemon-side drain deferral — moves the failure to the new session as
an exit timeout; cycles/PageRank run for minutes. Rejected: keying WITHOUT nlls
— without idle release the second keyed daemon hits a lock held forever by the
first; contention becomes permanent instead of transient (same bug class, new
shape).

## Design

### 1. Prerequisite: nlls

Per-collection idle eviction in the daemon's `GraphDbClientPool` (its own bead,
own live proof: the 2026-05-29 class — a lock held 3h after last touch — reads
as released). Everything below assumes idle handles are released.

### 2. Keying at `getDaemonPaths`

`getDaemonPaths` gains a per-build subdirectory derived from
`getBuildFingerprint()`; the five lifecycle files (socket, pid, port, refs,
lock) live inside it. Both the pool (`drainStaleDaemon`, connect flow) and the
daemon derive paths from this ONE function — no second place knows the layout.
`cleanupDaemonFiles` unlinks only its own key (satisfied for free). The
pre-listen stale-socket unlink becomes per-key automatically. A spawn sweeps key
directories whose pid is dead.

### 3. Connect flow

Client looks up ITS build's socket: found + alive → connect — same build by
construction; the handshake is retained as the op-capability check and defense
in depth. Miss → the existing respawn path spawns a keyed daemon. The
cross-build drain (`drainStaleDaemon`) leaves the hot path; it survives for
legacy migration only.

### 4. Legacy migration

The first keyed client encountering a legacy-layout (un-keyed) daemon drains it
through the existing flow — the zgcmo guard protects any in-flight writers —
then unlinks the legacy files. A dead legacy pid → unlink legacy files directly.
One-time cost at upgrade.

### 5. Shared collections across builds

Same-collection concurrent indexing is already refused by
`CollectionIndexingLock`. For read/write overlap across two keyed daemons, the
DuckDB RW lock decides: a losing opener retries boundedly on
`DuckDbOpenFailedError`; the wait is bounded because nlls releases the idle
holder.

### 6. Worker pools (no respawn hook)

A worker pool of build B finding no live B-socket gets a new typed
`CodegraphDaemonBuildUnavailableError` (retryable) instead of silently sharing
another build's daemon. Provisioning stays a main-thread-pool responsibility;
the implementation must verify the ingest pipeline orders worker fork after
provider init (it does today — verify, don't assume).

### 7. `doctor --restart`

Restarts ALL live keyed daemons — two or more live builds on one machine is the
normal case this design creates, not an anomaly. Doctor also gains a sweep for
orphaned key directories.

## Files touched

- `src/core/adapters/duckdb/daemon/lifecycle.ts` (`getDaemonPaths` keying)
- `src/core/adapters/duckdb/daemon/entry.ts` (keyed listen, sweep, cleanup)
- `src/core/adapters/duckdb/pool.ts` (own-key connect, legacy migration path)
- `src/core/adapters/duckdb/errors.ts` (`CodegraphDaemonBuildUnavailableError`)
- `src/cli/commands/doctor.ts` (multi-daemon restart + orphan sweep)
- `src/core/adapters/duckdb/daemon/build-fingerprint.ts` (reused, not changed)

## Tests

Keyed path derivation; own-key connect; miss → keyed spawn; legacy-layout
drain + cleanup; per-key cleanup on exit; dead-key-dir sweep; cross-build
same-collection retry (with nlls present); worker typed error; doctor
multi-daemon restart.

## Validation

The real-world class, live: two sessions on different builds (the `npm link`
flip case) working concurrently — neither drains the other, both index their own
collections, a shared collection arbitrates through the lock + retry with no
EPIPE. Plus the lp13p R2k kill test and a `doctor --restart` sweep.

## Out of scope

- nlls mechanics (its own bead).
- Any drain-deferral variant.
