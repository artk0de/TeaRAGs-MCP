---
title: "Auto-Update Watcher"
sidebar_position: 5
---

# Auto-Update Watcher

Keeps a project's index fresh on one chosen branch — without you remembering to
run `index_codebase`. Opt-in, per project, branch-pinned.

## Why branch-pinned

The index represents ONE git state. A naive "reindex on every file change"
would thrash on branch switches: every checkout re-embeds the diff, burns
enrichment time, and silently replaces your canonical index with whatever
branch happens to be checked out. The watcher instead pins auto-updates to a
**target branch** (typically `master`/`main`): edits on that branch catch up
automatically; everything else is notice-only.

## Enabling

```bash
tea-rags auto-update enable --project myrepo              # target = autodetected default branch
tea-rags auto-update enable --project myrepo --branch dev # explicit target
tea-rags auto-update status --project myrepo              # config + verdict + last run + log path
tea-rags auto-update disable --project myrepo             # keeps the target branch for re-enable
```

Disabled by default. Enabling writes `autoUpdate { enabled, targetBranch }`
into the project registry entry; the registry also records which branch/commit
the index was last built from (`git` block, written at the end of every
indexing run).

## How it fires

No resident daemon, no filesystem watcher. Two in-session triggers run a ~1 ms
freshness check (registry read + `.git/HEAD` read):

| Trigger | When |
| --- | --- |
| `tea-rags prime` | SessionStart — digest shows the verdict, spawn is fire-and-forget |
| MCP search tools | after serving the query (in-memory debounce ~120 s per collection) |

When the check says **eligible** (`HEAD == targetBranch`, no rebase/merge in
progress, no recent run), an **ephemeral detached updater process** is
spawned: `tea-rags auto-update run --project X`. It survives session close,
re-checks the branch (the switch may have happened mid-flight), probes the
indexing marker (another run holding it → exit `lock-held`), performs an
incremental Merkle-delta reindex, waits for enrichments, records the outcome
into the registry, and exits.

The triggering query is **never blocked**: it serves from the current index;
the next query sees the fresh one. Search responses show a one-line hint
(`index updating in background`) while the updater works.

## Verdicts

| Verdict | Condition | Effect |
| --- | --- | --- |
| `eligible` | HEAD on target branch, no debounce | detached updater spawned |
| `branch-mismatch` | HEAD elsewhere | paused; prime/tool hint tells you; index untouched |
| `transient` | rebase / merge / bisect in progress | silent skip |
| `disabled` | not enabled | prime shows a one-line enable hint when the index is stale |
| `debounced` | last run &lt; 2 min ago (failed run: &lt; 5 min) | silent skip |

Switching back to the target branch after working on a feature branch is the
sweet spot: the next trigger auto-catches the index up to the target state.
Explicitly indexing a feature branch stays possible (`index_codebase` as
always) — auto-update simply pauses while HEAD is off-target.

## Failure behavior

- A failed run (embedding endpoint down, crash) records
  `lastRun: failed` and backs off for 5 minutes — no respawn storm.
- Prime surfaces it: `auto-update: failed 2h ago — see <log>`.
- Full DEBUG trace per run: `~/.tea-rags/logs/auto-update-<project>.log`
  (truncated past 5 MB).
- A crashed updater leaves a stale indexing-marker heartbeat; the standard
  `stale_indexing` recovery path applies.

## Known limitations

- Concurrent-run protection is a marker **probe**, not a hard lock: two
  updaters racing within the same second can both start. Incremental reindex
  is idempotent per chunk, so the cost is wasted work, not corruption.
- Updates fire only while sessions are active (prime / MCP tool calls) — an
  idle machine does not reindex, by design.
- Uncommitted changes on the target branch are indexed as-is, exactly like a
  manual `index_codebase`.
