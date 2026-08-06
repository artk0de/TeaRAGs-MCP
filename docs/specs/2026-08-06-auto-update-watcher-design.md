# Auto-Update Watcher — Index Freshness Design

- **Date**: 2026-08-06
- **Bead**: tea-rags-mcp-hpg2 (parent epic 0xyn)
- **Status**: approved (brainstorm 2026-08-06), supersedes the deleted
  `2026-05-10-tea-rags-auto-update-design.md`
- **Depends on**: Project Registry (me7f, done), Collection registry metadata
  (gr4o, done)

## Problem

Index freshness currently depends on the user remembering to run
`index_codebase`. Prime reports "Index is stale (1d)" and schema drift, but
nothing acts on it. Worse, the sync layer is Merkle-hash-based and
**branch-blind**: the index does not know which git state it represents, so a
branch switch is indistinguishable from a mass edit. Any naive auto-reindex
would thrash the index on every checkout and silently replace the canonical view
with whatever branch happens to be checked out.

User constraints resolved by this design:

1. Master (or a chosen branch) is the canonical indexed state.
2. Explicitly indexing the current working directory stays possible.
3. Returning to the target branch restores the canonical index automatically.
4. Free branch switching must not thrash the index or burn embeddings.

## Decisions (approved forks)

| Fork              | Decision                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Branch policy     | `targetBranch` per project (autodetect default); auto fires **only when `HEAD == targetBranch`**  |
| Opt-in            | `autoUpdate.enabled: false` by default. Enabling and picking the branch is an explicit CLI act.   |
| Trigger semantics | Background + stale serve — the query is served from the current index, reindex catches up behind  |
| Process model     | No resident daemon — an **ephemeral detached updater**, spawned on trigger, exits after the delta |
| Module home       | `src/core/domains/maintenance/freshness/` — next to `maintenance/registry/`, which it reads.      |

## Architecture

### 1. Registry extension (source of truth)

Collection registry entries gain two blocks:

```ts
git: {
  indexedBranch: string | null;   // branch at index time; null = detached HEAD
  indexedCommit: string;          // HEAD sha at index time
  indexedDirty: boolean;          // working tree had uncommitted changes
}
autoUpdate: {
  enabled: boolean;               // default false
  targetBranch: string;           // set at enable time; default-branch autodetect
  lastRun?: {
    at: string;                   // ISO timestamp
    outcome: "ok" | "no-op" | "skipped" | "lock-held" | "failed";
    durationMs: number;
    filesChanged: number;
    error?: string;
  };
}
```

`git.*` is written at Index/ReindexPipeline finalize, in the same place the
registry metadata (indexedAt, chunksCount, …) is already updated — one write
site (colocation rule). This is the **only** pipeline touch: hotspot signals on
`operations/indexing.ts` (bugFixRate 50–64) and `operations/reindexing.ts`
(42–60) argue against embedding branch logic inside the pipelines.

### 2. FreshnessCheck (`maintenance/freshness/`)

Pure decision module. Input: registry entry + repo path. Output: a discriminated
verdict. Cost: registry read + `.git/HEAD` read + indexing-marker read (~1 ms).
It deliberately does **not** detect file changes — under background +
stale-serve semantics the change detector is `reindexChanges` itself (Merkle
delta; `hasNoChanges` → cheap no-op). No duplicated sync logic, no fs-watcher.

| Verdict           | Condition                                                                             | Action                                                |
| ----------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `eligible`        | enabled, `HEAD == targetBranch`, no transient git state, marker free, debounce passed | spawn updater                                         |
| `branch-mismatch` | `HEAD != targetBranch`                                                                | notice only (prime + tool-response hint)              |
| `transient`       | rebase / merge / bisect in progress, detached HEAD                                    | silent skip                                           |
| `disabled`        | `enabled == false`                                                                    | notice only (prime keeps the existing staleness line) |
| `debounced`       | last run or live heartbeat too recent                                                 | silent skip                                           |

The check runs against the **registered project path** from the registry, not
the session cwd — a worktree session querying the main index triggers updates of
the main checkout at its own HEAD.

### 3. Trigger points

| Trigger      | Spawner                                                 | Notes                                            |
| ------------ | ------------------------------------------------------- | ------------------------------------------------ |
| SessionStart | `tea-rags prime` (existing hook): digest → spawn → exit | ~10 ms spawn; latency budget untouched           |
| Tool call    | MCP server, post-response on search tools               | in-memory TTL ~120 s gates FreshnessCheck itself |
| Manual       | `tea-rags auto-update run --project X`                  | foreground with progress when TTY                |

Debounce is two-layered:

- **in-process**: TTL (~120 s) inside the MCP server so FreshnessCheck is not
  evaluated on every call;
- **cross-process**: via registry — `lastRun.at` under 120 s → skip;
  `lastRun.outcome == "failed"` under 5 min → backoff (mirrors the negative TTL
  pattern in `src/cli/update-check/`).

### 4. Updater process (ephemeral, detached)

No resident process exists between runs. The updater is the installed `tea-rags`
package itself, launched as a new hidden-ish subcommand:

```text
spawn(process.execPath,
      [<installRoot>/build/cli/index.js, "auto-update", "run", "--project", X],
      { detached: true, stdio: ["ignore", logFd, logFd] })
child.unref()
```

- `process.execPath` + own install root (via `import.meta.url`) — no PATH
  dependency.
- `detached: true` → new process group; the updater reparents to init/launchd
  and **survives session close**.
- stdout/stderr → `~/.tea-rags/logs/auto-update-<project>.log` (full DEBUG
  trace).

Updater lifecycle:

1. **Re-run FreshnessCheck** — TOCTOU guard: the branch may have changed between
   trigger and start → exit `skipped`.
2. **Acquire indexing marker** (heartbeat in Qdrant) — the existing
   cross-process mutex. Held → exit `lock-held`; this is how the loser of two
   concurrent spawns dies.
3. **`ReindexPipeline#reindexChanges`** — incremental Merkle delta;
   `hasNoChanges` → exit `no-op`.
4. **Wait for enrichments** to completion (equivalent of `--wait-enrichments`) —
   the process is detached, nobody waits on it, so waiting is free and leaves
   the index fully consistent.
5. **Write registry**: `git.*` state + `autoUpdate.lastRun`.
6. Exit.

Spawns are intentionally cheap and "dumb": races between sessions are resolved
by the marker inside the updater, not by coordinating spawners. Storage access
is already multi-process-safe: embedded Qdrant is a shared daemon with an HTTP
endpoint, codegraph DuckDB has its own cross-process-locked daemon — the updater
is just another client, like any parallel CLI command.

### 5. Failure model

- Updater crash → stale heartbeat → existing `stale_indexing` path + crash
  recovery. Nothing new invented.
- Embedding endpoint down → updater fails fast; the 5-minute failure backoff
  prevents respawn storms on every tool call.
- The serving query is never affected: reindex errors surface through
  `autoUpdate.lastRun` (next prime shows `auto-update: failed 2h ago (see log)`)
  and existing `ReindexFailedError` logging, never through the search response.

### 6. CLI surface

```bash
tea-rags auto-update enable  --project X [--branch master]  # autodetects default branch if omitted
tea-rags auto-update disable --project X
tea-rags auto-update status  --project X                    # verdict + lastRun + log path
tea-rags auto-update run     --project X                    # updater entry; also manual trigger
```

`enable` writes `autoUpdate { enabled: true, targetBranch }` to the registry.

### 7. Observability

- Prime digest gains a branch-aware line replacing the purely time-based
  staleness message, e.g.:
  - `auto-update: on (master) · last run ok 3m ago`
  - `index = feature-x@ab12f3, HEAD = master — auto-update catching up`
  - `auto-update: paused — HEAD feature-x ≠ target master; run index_codebase to switch the index`
- Tool responses get a one-line hint when a background update is running
  (`index updating in background`) or when `branch-mismatch` applies.

## Out of scope (explicit)

- Resident OS daemon (launchd/systemd) and fs-watchers — rejected: platform
  lifecycle burden, updates indexes nobody queries; the bead scopes detection to
  in-session.
- `follow-HEAD` auto policy — possible future `autoUpdate` mode, not built now.
- Schema-drift-triggered force reindex — remains user-gated
  (`schema-drift-vs-migration` rule).
- npm-version update channel — already implemented in `src/cli/update-check/`;
  untouched.
- Any change to what gets indexed for dirty trees — uncommitted content is
  indexed as-is, exactly as today.

## Testing strategy

TDD throughout (failing test first):

- **FreshnessCheck verdicts** — fixture git states: on-target clean/delta,
  branch mismatch, detached HEAD, rebase/merge in progress, disabled, debounced
  (lastRun recency, failure backoff).
- **Registry extension** — read/write round-trip of `git.*` and `autoUpdate.*`;
  pipeline-finalize write happens exactly once per run.
- **Trigger path** — post-response check respects in-process TTL; spawns at most
  once per window; marker-held short-circuit (mock spawn + mock pipeline).
- **Updater exit semantics** — each verdict maps to the documented outcome;
  `lastRun` written on every path including failure.
- **CLI** — enable/disable/status round-trip; default-branch autodetect.

## Risk notes (from tea-rags enrichment)

- `operations/indexing.ts` / `operations/reindexing.ts` are the top hotspots
  (bugFixRate 42–64) — design confines their change to the finalize-time
  registry write.
- `status-module.ts` (churn 5.4 high) is read-only for this feature; prime
  formatting changes live in `src/cli/prime/format.ts`.
- `ingest/errors.ts` and `debug-logger.ts` are structural hubs (transitive
  impact 21–23) — extend, do not modify existing members.
