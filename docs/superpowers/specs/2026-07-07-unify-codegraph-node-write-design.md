# Unify codegraph durable node-write across all indexing paths — Design

**Date:** 2026-07-07 **Branch:** `worktree-vcs-adapter` (builds on merged fix#1
codegraph overlap + fix#2 git cache; local main `59d53c46`) **Status:** approved
design, pending plan

## Problem

The durable codegraph node-write (`cg_symbols` rows) goes through **two
divergent mechanisms** depending on indexing path:

| Path                                                       | Entry                                                            | Durable node-write shape                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Full-index cross-pass** (primary first-time + `--force`) | `acceptExtraction` (main-thread tee, during embedding)           | **buffered BULK** — `nodeDefBuffer` → `enqueueNodeFlush` → `flushNodeBatch` → `upsertSymbolsBulk` (fix#1) |
| **Incremental** (`reindex_changes`)                        | `streamFileBatchInner` → `sink.write` (worker, during embedding) | **PER-FILE** — `graphDb.upsertSymbols` per file (`provider.ts:844`, `skipDurableNodeWrite=false`)         |

Both already **overlap embedding** (verified: `file-phase.ts:144-147` — the
deferred codegraph provider's `streamFileBatch` runs per-batch "during embedding
overlap"; the `enrichment` finalize tail is the irreducible pass-2
edge-resolve + SCC/PageRank, not the node-write). So this is **not** closing an
overlap gap.

The divergence itself is the cost: two code paths for the same durable write, a
`skipDurableNodeWrite` flag whose `false` branch does something different from
the buffered mechanism, and per-file transaction overhead on large incrementals
(hundreds of files → hundreds of DuckDB `BEGIN/COMMIT` vs a handful of bulk
txns).

## Goal

One durable-node-write **mechanism** (buffered bulk via `nodeDefBuffer` →
`flushNodeBatch` → `upsertSymbolsBulk`) on **every** path — primary, `--force`,
incremental. Single Choice / OCP: the "how do codegraph nodes get durably
written" decision lives in exactly one place. Perf on large incrementals (fewer
DuckDB txns) is a hidden bonus; the driver is architectural uniformity.

## Non-goals

- Pass-2 edge-resolve / SCC / PageRank stay the irreducible post-embedding tail
  (both paths). Untouched.
- The in-memory `symbolTable` build stays per-file (resolver's source of truth).
- No change to `upsertSymbolsBulk` / `BulkSymbolUpsertEntry` (fix#1 primitives
  reused).

## Load-bearing safety fact

Pass-2 resolve reads the **in-memory `symbolTable`**, NOT durable `cg_symbols`:
`streamingResolveAndUpsert` → `resolveExtraction(extraction, symbolTable)`. The
`sink.write` comment (`provider.ts:838`) is explicit: _"the in-memory table is
the source of truth during the run, DuckDB is the durable copy."_ Therefore
deferring the durable node-write to a buffered bulk flush **cannot** affect
resolution — as long as `symbolTable.upsertFile` stays synchronous per-file (it
does; unchanged).

## Design

### 1. Shared buffering seam — `bufferNodeDefs`

Extract the buffer+enqueue currently inline in `acceptExtraction:1601-1604` into
a private method:

```ts
private bufferNodeDefs(relPath: RelPath, defs: SymbolDefinition[], collectionName?: string): void {
  const key = this.collectionKey(collectionName);
  const buf = this.nodeDefBuffer.get(key) ?? [];
  buf.push({ relPath, definitions: defs });
  this.nodeDefBuffer.set(key, buf);
  this.enqueueNodeFlush(key, collectionName); // 256-file safety valve (unchanged)
}
```

Both entry points call it:

- `acceptExtraction` (cross-pass):
  `this.bufferNodeDefs(extraction.relPath, this.buildSymbolDefs(extraction), options?.collectionName)`
  — behaviour byte-identical, refactored.
- `sink.write` (`:844`): replace
  `if (!skipDurableNodeWrite) await graphDb.upsertSymbols(...)` with
  `if (!skipDurableNodeWrite) this.bufferNodeDefs(extraction.relPath, defs, collectionName)`.
  `defs` already built at `:830`.

`skipDurableNodeWrite` **stays** — it still marks the cross-pass DRAIN sink to
skip entirely (the eager `acceptExtraction` flush already buffered during
embedding; re-buffering at drain would re-write nodes and defeat fix#1). Only
the `false` branch changes shape: per-file upsert → buffer.

### 2. Preserve overlap on small incrementals — per-batch flush

**Risk:** the `enqueueNodeFlush` threshold is `nodeFlushFiles` (256). A typical
incremental changeset (< 256 files) would never trip it — the whole buffer would
sit until the finalize remainder flush, moving the durable write from
_during-embedding_ to _at-finalize_. That REGRESSES the overlap the per-file
path had for the common case.

**Fix:** at the end of `streamFileBatchInner` (incremental only — it's past the
`if (options?.crossPass) return` early-out at `:1503`), flush this batch's
buffered remainder as one bulk write, **fire-and-chain** (not awaited — overlaps
the next embedding batch), mirroring how the per-file path flushed each file as
the batch streamed:

```ts
// after the file loop, before `return new Map()`
const batch = this.nodeDefBuffer.get(key)?.splice(0) ?? [];
if (batch.length > 0) this.chainNodeFlush(batch, key, options?.collectionName);
```

Result: each streamed batch's nodes flush during embedding (overlap preserved,
any changeset size), in bulk (batch-sized), onto the shared `nodeFlushChain`.
The 256 threshold remains a mid-batch safety valve for pathologically large
batches.

### 3. Nodes-before-edges invariant at finalize — `flushNodeRemainder`

Extract the remainder-flush + chain-await + error-rethrow currently inline in
`drainInputSpill:1726-1729` into a helper:

```ts
private async flushNodeRemainder(key: string, collectionName?: string): Promise<void> {
  const remainder = this.nodeDefBuffer.get(key)?.splice(0) ?? [];
  if (remainder.length > 0) this.chainNodeFlush(remainder, key, collectionName);
  await this.nodeFlushChain;
  if (this.nodeFlushError) throw this.nodeFlushError;
}
```

- `drainInputSpill` (cross-pass): replace the inline block with a call —
  behaviour identical.
- `finalizeSignals` **non-crossPass** branch: call
  `await this.flushNodeRemainder(key, options?.collectionName)` **before**
  `sink.finish()` (pass-2). This guarantees every buffered node is durable in
  `cg_symbols` before `streamingResolveAndUpsert` writes edges referencing them
  (nodes-before-edges), and surfaces any latched `nodeFlushError` to abort the
  run cleanly — symmetric with the cross-pass path.

### Data flow (after)

```
cross-pass:   acceptExtraction ─(per file, embedding)─▶ bufferNodeDefs ─▶ [nodeDefBuffer] ─▶ enqueueNodeFlush(256) ─▶ chainNodeFlush ─▶ flushNodeBatch ─▶ upsertSymbolsBulk
                                                                                     finalize: drainInputSpill → flushNodeRemainder → sink.finish (pass-2)

incremental:  sink.write ─(per file, embedding)─▶ bufferNodeDefs ─▶ [nodeDefBuffer] ─┬─▶ enqueueNodeFlush(256 safety)
              streamFileBatchInner end ─(per batch, embedding)──────────────────────┴─▶ chainNodeFlush ─▶ flushNodeBatch ─▶ upsertSymbolsBulk
                                                                                     finalize: flushNodeRemainder → sink.finish (pass-2)
```

One buffer, one flush chain, one bulk primitive, both paths.

## Invariants (must hold — business-logic tests)

1. **Graph equality.** Incremental reindex of a changeset produces
   byte-identical `cg_symbols` rows as the legacy per-file `upsertSymbols` path
   (same set, same symbol_id/rel_path/kind columns).
2. **Nodes-before-edges.** No `cg_edges` row (written by
   `streamingResolveAndUpsert` → `graphDb.upsertFile`) references a `cg_symbols`
   row not yet durable.
3. **In-memory table unchanged.** `symbolTable.upsertFile` +
   `indexChunkSymbolsByLine`
   - run-global merges still run per-file, unconditionally, in `sink.write`.
4. **Error propagation.** A `flushNodeBatch` failure mid-incremental latches
   into `nodeFlushError` and is rethrown at `finalizeSignals` (via
   `flushNodeRemainder`), aborting the run — mirrors cross-pass. No Node-≥22
   unhandled-rejection crash.
5. **Cross-pass byte-identical.** The cross-pass path (fix#1) behaves
   identically — only mechanically refactored to call `bufferNodeDefs` /
   `flushNodeRemainder`.

## Affected files

- `src/core/domains/trajectory/codegraph/symbols/provider.ts`:
  - add `bufferNodeDefs`, `flushNodeRemainder` privates
  - `acceptExtraction` → call `bufferNodeDefs`
  - `sink.write` (`:844`) → `bufferNodeDefs` instead of per-file `upsertSymbols`
  - `streamFileBatchInner` end → per-batch fire-and-chain flush
  - `drainInputSpill` → call `flushNodeRemainder`
  - `finalizeSignals` non-crossPass → `flushNodeRemainder` before
    `sink.finish()`
- Tests (mirror under `tests/core/domains/trajectory/codegraph/symbols/`):
  - extend `provider-eager-flush.test.ts` / `provider-spill.test.ts` or a new
    `provider-incremental-bulk.test.ts` covering invariants 1–4.

## Risk / rollback

- `provider.ts` is extreme-churn (commitCount 85) + the node-flush machinery is
  deep-silo (single author) → **adversarial review mandatory** on the diff.
- Pure refactor of durable-write timing; in-memory resolution path untouched →
  blast radius bounded to `cg_symbols` durability ordering.
- Rollback = revert the commit; fix#1 cross-pass + incremental per-file both
  independently restored.

## Testing / validation

- TDD: invariant tests red→green.
- Full `npx vitest run` + `tsc` + eslint gate.
- Live: incremental self-reindex, assert `cg_symbols` count +
  `codegraph.symbols` healthy + `get_callers`/`get_callees` non-empty on a known
  symbol (graph intact).
