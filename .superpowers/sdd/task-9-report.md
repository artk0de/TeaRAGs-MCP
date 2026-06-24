# Task 9 Bug Fix Report

## Bug 1: CodegraphArtifact cloned by logical name, not physical

**Root cause:** `CodegraphArtifact.clone()` called
`pool.cloneDatabase(ctx.source.logicalName, ctx.target.logicalName)` and
`remove()` called `pool.removeCollection(ctx.target.logicalName)`.
`GraphDbClientPool.pathFor(name)` appends `.duckdb` verbatim, so
`pathFor("code_8b243ffe")` resolves to a non-existent file — the physical file
is `code_8b243ffe_v30.duckdb`. The `existsSync` guard inside `cloneDatabase` saw
no file → silent no-op. No codegraph data was ever cloned into the worktree.

**Fix:** Changed `codegraph-artifact.ts` to use `ctx.source.physicalName` /
`ctx.target.physicalName` in both `clone()` and `remove()`. `StatsArtifact` and
`SnapshotArtifact` remain on `logicalName` — they are keyed by logical name on
disk.

**RED → GREEN:** Updated test
`clone: calls cloneDatabase with source and target PHYSICAL names when enabled`
to set `physicalName: "code_src_v30"` (distinct from logical `"code_src"`),
asserting `cloneDatabase("code_src_v30", "code_dst_v1")`. Added
`remove: calls removeCollection with target PHYSICAL name` asserting
`removeCollection("code_dst_v30")`. Both failed before the fix, both pass after.

---

## Bug 2: WorktreeOps.remove hardcodes `_v1` for target physical

**Root cause:** `worktree-ops.ts` `remove()` built
`physicalName: \`${entry.collectionName}\_v1\``unconditionally. After a force-reindex or incremental bump the active physical advances to`\_v2`, `\_v3`, etc. Deleting `\_v1`
missed the live collection entirely → orphaned Qdrant collection + orphaned
DuckDB file.

**Fix:** Added a `resolveActive` call for `entry.collectionName` with
`.catch(() => \`${entry.collectionName}\_v1\`)`fallback, and used the resolved value as`physicalName`. `create()`keeps`\_v1`
— that's correct (recover always starts fresh at v1).

**RED → GREEN:** Added `WorktreeOps.remove physical resolution` describe block
with two tests:

1. `uses resolveActive result as target physicalName` — stubs
   `resolveActive("code_dst") → "code_dst_v2"`, asserts
   `buildCalls[0].target.physicalName === "code_dst_v2"`. Failed before fix
   (received `"code_dst_v1"`), passes after.
2. `falls back to _v1 when resolveActive throws` — stubs `resolveActive` to
   throw for "code_dst", asserts `physicalName === "code_dst_v1"`. Passes with
   the `.catch` fallback.

Also updated `makeDeps` to track `buildCalls` so target can be inspected by
`remove` tests.

---

## Bug 3: CLI worktree create/remove process lingers after completion

**Root cause:** Both `runWorktreeCreate` and `runWorktreeRemove` used a
`try/catch/finally` pattern where `ctx.cleanup?.()` ran in `finally`. This never
explicitly called `process.exit()` on the success path. Open Qdrant and DuckDB
handles kept the event loop alive indefinitely — the process had to be
SIGTERM'd.

**Fix:** Restructured both handlers to mirror
`src/cli/index-progress/worker.ts main()`: call `ctx.cleanup?.()` then
`process.exit(0)` in the success branch; call `ctx.cleanup?.()` (best-effort in
its own try/catch) then `process.exit(1)` in the error branch. Removed the
`finally` block. Output format and `nextStep` hint unchanged.

**Test evidence:** No unit test (exit-only change, no observable unit surface).
Verified by Task 9 smoke test: `tea-rags worktree create` and
`tea-rags worktree remove` self-exit after printing result.

---

## Summary

| Bug                          | File changed                      | RED tests | GREEN tests         | tsc |
| ---------------------------- | --------------------------------- | --------- | ------------------- | --- |
| 1 — codegraph physical names | `footprint/codegraph-artifact.ts` | 2 new     | 2 pass              | 0   |
| 2 — resolve active on remove | `worktree/worktree-ops.ts`        | 1 new     | 2 pass (+ fallback) | 0   |
| 3 — CLI self-exit            | `cli/commands/worktree.ts`        | n/a       | smoke only          | 0   |

`npx vitest run tests/core/domains/maintenance/` — 33/33 passed.
`npx tsc --noEmit` — 0 errors.
