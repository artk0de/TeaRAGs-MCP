# Codegraph node-upsert overlap + bulk-append — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `dinopowers:executing-plans`
> (wrapper over superpowers:executing-plans) — or
> `superpowers:subagent-driven-development` — to implement this plan
> task-by-task. TDD steps use `dinopowers:test-driven-development`. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the codegraph cross-pass (`--force`) path, hoist the durable node
write out of the post-embedding finalize tail into a batched, bulk write issued
_during_ embedding, reported live in the CLI — cutting the ~876s "dark" finalize
tail without perturbing determinism.

**Architecture:** Add `GraphDbClient.upsertSymbolsBulk` (one transaction per
batch, DELETE-per-file + one `insertOrIgnoreBatched` over `cg_symbols`). In the
codegraph provider, `acceptExtraction` buffers symbol defs and flushes them in
bulk during embedding via an internal serialized flush-chain; `drainInputSpill`
keeps the sorted, deterministic run-global merges + in-memory table build +
pass-2 resolve, but skips the now-already-done durable node write. Progress
rides the existing enrichment IPC channel under a new `codegraph.symbols` level.

**Tech Stack:** TypeScript (ESM), DuckDB (`@duckdb/node-api`) via
`DuckDbGraphClient` + daemon socket proxy, Vitest, Node `worker_threads` / IPC.

## Global Constraints

- **Determinism invariant — IMMUTABLE.** Run-global merges (`runAncestors` /
  `runReturnTypes` / `runDispatchTables` / …) stay last-write-wins over the
  **sort-by-`relPath`** order in `drainInputSpill` (bd `yl9tv`). Do NOT change
  that order or move the merges. The `yl9tv` bridge determinism test
  (`tests/core/domains/ingest/pipeline/codegraph-extraction-bridge.test.ts`) is
  business-logic — may be MOVED, never REWRITTEN.
- **In-memory symbol table stays in the drain/resolve context.** Hoist ONLY the
  durable DuckDB node write (`graphDb.upsertSymbols` → `upsertSymbolsBulk`).
  `symbolTable.upsertFile` + `indexChunkSymbolsByLine` remain in
  `drainInputSpill` (built in the resolver's own context) — unchanged.
- **Incremental path untouched.** Per-file `upsertSymbols` stays for the
  non-cross-pass path; `streamFileBatchInner` / `streamingResolveAndUpsert` are
  not modified.
- **Graph equality.** A cross-pass full index must produce byte-identical
  `cg_symbols` / edges / metrics before vs after this change.
- **`INSERT OR IGNORE` semantics preserved** (NOT `OR REPLACE`): PK
  `(rel_path, symbol_id)` is identity, first row wins on within-file duplicate
  symbolId (accessor pairs, overloads). Per-file DELETE precedes inserts.
- **TDD mandatory** — failing test first (red), minimal impl (green). No
  production code before a failing test.
- **Worktree-only.** Commit on the ephemeral branch. NEVER push, NEVER merge.
  Build+link / reindex are user-gated — do NOT run them from plan execution.
- **No new top-level `src/` dirs**; typed errors only (no bare `throw new Error`
  for user-facing paths); no `eslint-disable`.

---

## File Structure

- `src/core/contracts/types/codegraph.ts` — add `upsertSymbolsBulk` to the
  `GraphDbClient` interface (+ a `BulkSymbolUpsertEntry` type).
- `src/core/adapters/duckdb/client.ts` — `DuckDbGraphClient.upsertSymbolsBulk`
  (one transaction, DELETE-per-file + one `insertOrIgnoreBatched`).
- `src/core/adapters/duckdb/daemon/protocol.ts` — add `"upsertSymbolsBulk"` to
  `DaemonMethod` + its request-param shape.
- `src/core/adapters/duckdb/daemon/server.ts` — dispatch
  `case "upsertSymbolsBulk"`.
- `src/core/adapters/duckdb/daemon/client.ts` —
  `DaemonGraphDbClient.upsertSymbolsBulk` (socket proxy).
- `src/core/domains/trajectory/codegraph/symbols/provider.ts` — buffer +
  internal flush-chain in `acceptExtraction`; `drainInputSpill` awaits the
  chain, final-flushes the remainder, and builds its sink to skip the durable
  node write; DEBUG flush log.
- `src/core/domains/ingest/pipeline/enrichment/coordinator.ts` — emit the new
  `codegraph.symbols` progress level during cross-pass accept.
- `src/cli/index-progress/renderer.ts` — recognise/label the new level (bar).

Tests mirror source structure under `tests/core/...` and `tests/cli/...`.

---

## Task 1: `GraphDbClient.upsertSymbolsBulk` (hub — do first)

The highest-blast-radius change (`GraphDbClient` fanIn 76). Everything else
depends on it, so it lands first with its own tests.

**Files:**

- Modify: `src/core/contracts/types/codegraph.ts` (interface + new type)
- Modify: `src/core/adapters/duckdb/client.ts` (`DuckDbGraphClient`, after
  `upsertSymbolsImpl` ~:523)
- Modify: `src/core/adapters/duckdb/daemon/protocol.ts` (`DaemonMethod` ~:28-31,
  request params ~:71-73)
- Modify: `src/core/adapters/duckdb/daemon/server.ts` (dispatch, after
  `case "upsertSymbols"` ~:107-110)
- Modify: `src/core/adapters/duckdb/daemon/client.ts` (`DaemonGraphDbClient`,
  after `upsertSymbols` ~:218-220)
- Test: `tests/core/adapters/duckdb/upsert-symbols-bulk.test.ts` (new)

**Interfaces:**

- Consumes: existing `SymbolDefinition` (`contracts/types/codegraph.ts:705`),
  `RelPath`, the private `this.exec`/`this.run` + `this.insertOrIgnoreBatched`
  helpers on `DuckDbGraphClient`, `this.serialize` write-gate.
- Produces:
  `GraphDbClient.upsertSymbolsBulk(entries: BulkSymbolUpsertEntry[]): Promise<void>`
  where
  `type BulkSymbolUpsertEntry = { relPath: RelPath; definitions: SymbolDefinition[] }`.
  Semantics == calling `upsertSymbols(relPath, defs)` once per entry, but in ONE
  transaction. Empty `entries` → no-op.

- [ ] **Step 1: Write the failing test (direct client)**

`tests/core/adapters/duckdb/upsert-symbols-bulk.test.ts` — follow the
temp-DuckDB harness used by
`tests/core/domains/trajectory/codegraph/symbols/provider-spill.test.ts` (temp
dir + `DuckDbGraphClient` from `src/core/adapters/duckdb/client.js`,
`await client.init()`, migrations via
`src/core/infra/migration/database/runner.js`).

```ts
it("bulk upsert writes the same cg_symbols rows as N per-file upsertSymbols", async () => {
  const defsA = [mkDef("a.ts", "A#m", "A#m", "m")];
  const defsB = [
    mkDef("b.ts", "B#n", "B#n", "n"),
    mkDef("b.ts", "B#n", "B#n", "n"),
  ]; // dup symbolId
  // reference client: per-file
  await ref.upsertSymbols("a.ts", defsA);
  await ref.upsertSymbols("b.ts", defsB);
  // subject client: one bulk call
  await sut.upsertSymbolsBulk([
    { relPath: "a.ts", definitions: defsA },
    { relPath: "b.ts", definitions: defsB },
  ]);
  const refRows = await ref.queryAll(
    "SELECT * FROM cg_symbols ORDER BY rel_path, symbol_id",
  );
  const sutRows = await sut.queryAll(
    "SELECT * FROM cg_symbols ORDER BY rel_path, symbol_id",
  );
  expect(sutRows).toEqual(refRows);
  // within-file dup collapsed to one row (INSERT OR IGNORE, first wins)
  expect(sutRows.filter((r) => r.rel_path === "b.ts")).toHaveLength(1);
});

it("bulk upsert is all-or-nothing: a bad row rolls back the whole batch", async () => {
  await sut.upsertSymbols("keep.ts", [mkDef("keep.ts", "K#a", "K#a", "a")]);
  const bad = [
    { relPath: "x.ts", definitions: [mkDef("x.ts", "X#a", "X#a", "a")] },
    {
      relPath: "y.ts",
      definitions: [/* @ts-expect-error */ { relPath: "y.ts" } as any],
    },
  ];
  await expect(sut.upsertSymbolsBulk(bad)).rejects.toBeTruthy();
  const rows = await sut.queryAll(
    "SELECT rel_path FROM cg_symbols WHERE rel_path IN ('x.ts','y.ts')",
  );
  expect(rows).toHaveLength(0); // neither x nor y landed
});

it("empty entries is a no-op", async () => {
  await expect(sut.upsertSymbolsBulk([])).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run tests/core/adapters/duckdb/upsert-symbols-bulk.test.ts`
Expected: FAIL — `upsertSymbolsBulk is not a function`.

- [ ] **Step 3: Add the interface + type**

In `src/core/contracts/types/codegraph.ts`, near the `GraphDbClient` write
methods (`upsertFile`/`upsertSymbols`), add:

```ts
export interface BulkSymbolUpsertEntry {
  relPath: RelPath;
  definitions: SymbolDefinition[];
}
```

and on `interface GraphDbClient`:

```ts
  /** Batched form of {@link upsertSymbols}: one transaction for many files
   *  (DELETE-per-file + one INSERT OR IGNORE over all rows). Same per-file
   *  semantics; empty entries is a no-op. */
  upsertSymbolsBulk(entries: BulkSymbolUpsertEntry[]): Promise<void>;
```

- [ ] **Step 4: Implement on `DuckDbGraphClient`**

In `src/core/adapters/duckdb/client.ts` after `upsertSymbolsImpl` (~:523),
mirror `upsertSymbolsImpl` but batch across files (one BEGIN/COMMIT, reuse
`insertOrIgnoreBatched`). Column list is the 9 columns from `upsertSymbolsImpl`.

```ts
async upsertSymbolsBulk(entries: BulkSymbolUpsertEntry[]): Promise<void> {
  if (entries.length === 0) return;
  return this.serialize(async () => this.upsertSymbolsBulkImpl(entries));
}

private async upsertSymbolsBulkImpl(entries: BulkSymbolUpsertEntry[]): Promise<void> {
  await this.exec("BEGIN");
  try {
    for (const { relPath } of entries) {
      await this.run("DELETE FROM cg_symbols WHERE rel_path = ?", [relPath]);
    }
    const rows: unknown[][] = [];
    for (const { definitions } of entries) {
      for (const def of definitions) {
        rows.push([
          def.relPath, def.symbolId, def.fqName, def.shortName,
          JSON.stringify(def.scope ?? []),
          def.arity ? JSON.stringify(def.arity) : null,
          def.visibility ?? null,
          def.kwargs ? JSON.stringify(def.kwargs) : null,
          def.acceptsBlock ?? null,
        ]);
      }
    }
    await this.insertOrIgnoreBatched(
      "cg_symbols",
      ["rel_path", "symbol_id", "fq_name", "short_name", "scope_json", "arity_json", "visibility", "kwargs_json", "accepts_block"],
      rows,
    );
    await this.exec("COMMIT");
  } catch (err) {
    await this.exec("ROLLBACK");
    throw err;
  }
}
```

> Row build order iterates `entries` then `definitions` in order → within-file
> "first wins" on duplicate symbolId is preserved (cross-file rows have distinct
> `rel_path`, never collide). This is exactly the per-file behaviour, batched.

- [ ] **Step 5: Run the direct-client test, verify green**

Run: `npx vitest run tests/core/adapters/duckdb/upsert-symbols-bulk.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Add the daemon method (protocol + server + client)**

`protocol.ts`: add `| "upsertSymbolsBulk"` to `DaemonMethod` (~:31) and its
param shape to the request union (~:73):

```ts
    | { collection: string; entries: BulkSymbolUpsertEntry[] } // upsertSymbolsBulk
```

`server.ts`: after `case "upsertSymbols"` (~:110):

```ts
      case "upsertSymbolsBulk": {
        const p = req.params as { collection: string; entries: BulkSymbolUpsertEntry[] };
        const graphDb = await this.graphDbFor(p.collection);
        await graphDb.upsertSymbolsBulk(p.entries);
        return { ok: true };
      }
```

(Match the exact `graphDb` acquisition + return shape of the neighbouring
`upsertSymbols` case — copy its structure verbatim, swapping the method +
params.)

`client.ts` (daemon): after `upsertSymbols` (~:220):

```ts
  async upsertSymbolsBulk(entries: BulkSymbolUpsertEntry[]): Promise<void> {
    await this.call("upsertSymbolsBulk", { entries });
  }
```

- [ ] **Step 7: Write + run the daemon==direct parity test**

Add to the same test file — construct a `DaemonGraphDbClient` against a daemon
over the same temp DB (mirror the daemon harness in
`tests/core/adapters/duckdb/daemon/*.test.ts`), assert `upsertSymbolsBulk` via
the daemon writes identical `cg_symbols` rows to the direct client.

Run: `npx vitest run tests/core/adapters/duckdb/upsert-symbols-bulk.test.ts`
Expected: PASS.

- [ ] **Step 8: Type-check + commit**

Run: `npx tsc --noEmit` → 0 errors.

```bash
git add src/core/contracts/types/codegraph.ts src/core/adapters/duckdb/client.ts \
        src/core/adapters/duckdb/daemon/protocol.ts src/core/adapters/duckdb/daemon/server.ts \
        src/core/adapters/duckdb/daemon/client.ts tests/core/adapters/duckdb/upsert-symbols-bulk.test.ts
git commit -m "feat(codegraph): add GraphDbClient.upsertSymbolsBulk (batched node upsert)"
```

---

## Task 2: Provider eager batched flush during embedding

Hoist the durable node write out of the finalize tail: buffer defs in
`acceptExtraction`, flush in bulk on a serialized chain, and make
`drainInputSpill` skip the (now-done) durable write while keeping the in-memory
table build + Half-B run-global merges in sorted order.

> **Deviation from spec (deliberate, lower-risk):** the spec named
> "`acceptExtraction` → async". The caller is `coordinator.onFileExtraction` →
> sync loop over `provider.acceptExtraction?.()` (`coordinator.ts:456`). Keeping
> `acceptExtraction` **synchronous** (buffer + fire-onto an internal
> flush-chain, no `await` in the hot path) avoids changing the
> `EnrichmentProvider` interface, the coordinator, and `indexing.ts`. Flush
> errors are captured on the chain and rethrown when `drainInputSpill` awaits it
> (aborting the run before completion — same failure contract as today's
> drain-time write).

**Files:**

- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts`
  - `acceptExtraction` (~:1507) — buffer defs + threshold flush onto a chain
  - new private fields: `nodeDefBuffer`, `nodeFlushChain`, `nodeFlushedFiles`
  - new private `flushNodeBuffer(collectionName)` + `enqueueNodeFlush(...)`
  - `drainInputSpill` (~:1580) — `await this.nodeFlushChain` + final flush
    BEFORE the sorted drain; build its sink with `skipDurableNodeWrite: true`
  - `asExtractionSink` (~:695) — accept an internal option to skip the durable
    `graphDb.upsertSymbols` at :781 (keep :780 symbolTable + :782 line-map +
    Half-B)
  - run-reset paths (~:1144/1208/1705/1747) — reset the three new fields
    alongside the existing `runAncestors` resets
- Test:
  `tests/core/domains/trajectory/codegraph/symbols/provider-eager-flush.test.ts`
  (new)

**Interfaces:**

- Consumes: `graphDb.upsertSymbolsBulk` (Task 1); `SymbolDefinition`; the
  existing `getStore`, `collectionKey`, `ensureRunSink` helpers.
- Produces: cross-pass runs where `cg_symbols` is written by `upsertSymbolsBulk`
  during accept; `drainInputSpill` no longer issues `graphDb.upsertSymbols`.
  Flush cadence: env-tunable `CODEGRAPH_NODE_FLUSH_FILES` (default 256) files
  per batch.

- [ ] **Step 1: Write the failing determinism+equality test**

`provider-eager-flush.test.ts` — mirror the cross-pass setup in
`tests/core/domains/ingest/pipeline/codegraph-extraction-bridge.test.ts` (feed N
extractions via `provider.acceptExtraction` then run the cross-pass finalize).

```ts
it("cross-pass with eager flush yields identical cg_symbols to the pre-change drain-only path", async () => {
  // baseline: force flush cadence huge so nothing flushes early (== old behaviour)
  const rowsDrainOnly = await runCrossPass(extractions, {
    flushFiles: Number.MAX_SAFE_INTEGER,
  });
  // eager: small cadence so most files flush during accept
  const rowsEager = await runCrossPass(extractions, { flushFiles: 4 });
  expect(rowsEager).toEqual(rowsDrainOnly);
});

it("durable node write happens exactly once per file (no double write)", async () => {
  const spy = vi.spyOn(graphDb, "upsertSymbolsBulk");
  const perFileSpy = vi.spyOn(graphDb, "upsertSymbols");
  await runCrossPass(extractions, { flushFiles: 4 });
  const flushedFiles = spy.mock.calls
    .flatMap((c) => c[0])
    .map((e) => e.relPath);
  expect(new Set(flushedFiles).size).toBe(extractions.length); // each file once
  expect(perFileSpy).not.toHaveBeenCalled(); // drain skipped the per-file durable write
});

it("run-global merge order is unchanged (determinism invariant)", async () => {
  // feed the SAME files in two different accept orders; assert equal run-global output
  const a = await runCrossPass(shuffle(extractions, 1), { flushFiles: 4 });
  const b = await runCrossPass(shuffle(extractions, 2), { flushFiles: 4 });
  expect(a.runGlobalSnapshot).toEqual(b.runGlobalSnapshot);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/provider-eager-flush.test.ts`
Expected: FAIL — eager cadence still routes the write through the drain (double
write / per-file `upsertSymbols` called).

- [ ] **Step 3: Add the buffer + flush-chain to the provider**

Add private state near the `runAncestors` fields (~:463):

```ts
private nodeDefBuffer = new Map<string, { relPath: RelPath; definitions: SymbolDefinition[] }[]>(); // key: collection
private nodeFlushChain: Promise<void> = Promise.resolve();
private nodeFlushedFiles = new Map<string, Set<string>>(); // key: collection → relPaths flushed
private readonly nodeFlushFiles = envInt("CODEGRAPH_NODE_FLUSH_FILES", 256);
```

Add helpers:

```ts
private enqueueNodeFlush(key: string, collectionName?: string): void {
  const buf = this.nodeDefBuffer.get(key);
  if (!buf || buf.length < this.nodeFlushFiles) return;
  const batch = buf.splice(0, buf.length);
  this.nodeFlushChain = this.nodeFlushChain.then(() => this.flushNodeBatch(batch, key, collectionName));
}

private async flushNodeBatch(batch: { relPath: RelPath; definitions: SymbolDefinition[] }[], key: string, collectionName?: string): Promise<void> {
  if (batch.length === 0) return;
  const { graphDb } = await this.getStore(collectionName);
  await graphDb.upsertSymbolsBulk(batch);
  const flushed = this.nodeFlushedFiles.get(key) ?? new Set<string>();
  for (const e of batch) flushed.add(e.relPath);
  this.nodeFlushedFiles.set(key, flushed);
  if (isDebug()) console.error("[GitEnrich] PHASE: CODEGRAPH_NODES_FLUSH", { batch: batch.length, cumulative: flushed.size });
}
```

In `acceptExtraction` (~:1507), after the existing input-spill append, build the
defs (same mapping as `asExtractionSink` :760-772) and buffer them:

```ts
const defs = extraction.chunks.map((c) => ({
  symbolId: c.symbolId,
  fqName: c.symbolId,
  shortName: lastSegment(c.symbolId),
  relPath: extraction.relPath,
  scope: c.scope,
  ...(c.arity !== undefined ? { arity: c.arity } : {}),
  ...(c.visibility !== undefined ? { visibility: c.visibility } : {}),
  ...(c.kwargs !== undefined ? { kwargs: c.kwargs } : {}),
  ...(c.acceptsBlock !== undefined ? { acceptsBlock: c.acceptsBlock } : {}),
}));
const buf = this.nodeDefBuffer.get(key) ?? [];
buf.push({ relPath: extraction.relPath, definitions: defs });
this.nodeDefBuffer.set(key, buf);
this.enqueueNodeFlush(key, options?.collectionName);
```

(Extract the defs-mapping into a shared private `buildSymbolDefs(extraction)`
used by BOTH `acceptExtraction` and `asExtractionSink` :760 — DRY, single source
of the 9-field mapping.)

- [ ] **Step 4: Drain awaits the chain, final-flushes, skips the durable write**

In `drainInputSpill` (~:1580), BEFORE building `extractions`/sorting:

```ts
// Flush any remainder buffered during accept, then await all in-flight flushes
const remainder = this.nodeDefBuffer.get(key)?.splice(0) ?? [];
if (remainder.length > 0)
  this.nodeFlushChain = this.nodeFlushChain.then(() =>
    this.flushNodeBatch(remainder, key, collectionName),
  );
await this.nodeFlushChain; // rethrows any eager-flush failure here (aborts the run)
```

Build the drain's sink to skip the durable node write (it is already done):
change `ensureRunSink` / `asExtractionSink` to accept
`{ skipDurableNodeWrite?: boolean }`; when true, `sink.write` runs
`symbolTable.upsertFile` (:780) + `indexChunkSymbolsByLine` (:782) + Half-B
(:789-882) but SKIPS `await graphDb.upsertSymbols` (:781). `drainInputSpill`
creates its sink with `skipDurableNodeWrite: true`. (The incremental path —
`streamFileBatchInner` — keeps `skipDurableNodeWrite: false`, so per-file
`upsertSymbols` is unchanged there.)

- [ ] **Step 5: Reset the new fields on run reset**

At each existing `this.runAncestors = {}` reset site (~:1144, :1208, :1705,
:1747), also clear the collection's buffer + flushed-set entry and reset the
chain to `Promise.resolve()` (guard against a rejected chain leaking into the
next run).

- [ ] **Step 6: Run the test, verify green**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/provider-eager-flush.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the yl9tv determinism anchor + incremental no-op check**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/codegraph-extraction-bridge.test.ts tests/core/domains/trajectory/codegraph/symbols/provider-spill.test.ts`
Expected: PASS — determinism + incremental path unchanged.

- [ ] **Step 8: Type-check + commit**

Run: `npx tsc --noEmit` → 0.

```bash
git add src/core/domains/trajectory/codegraph/symbols/provider.ts \
        tests/core/domains/trajectory/codegraph/symbols/provider-eager-flush.test.ts
git commit -m "perf(codegraph): eager batched node upsert during embedding on cross-pass"
```

---

## Task 3: CLI progress for the eager node write

Surface the overlapped node write in the CLI so it is no longer a dark tail.

**Files:**

- Modify: `src/core/domains/ingest/pipeline/enrichment/coordinator.ts` — in the
  cross-pass accept fan-out (`onFileExtraction`, ~:455-457), emit a
  `codegraph.symbols` progress event via the existing `progressCb`.
- Modify: `src/cli/index-progress/renderer.ts` — label/bar the new level (the
  `enrichment` handling already keys bars by `${providerKey}:${level}`, so this
  is a label-map addition, ~:154 + the TTY bar path ~:462-491).
- Test:
  `tests/core/domains/ingest/pipeline/enrichment/coordinator-codegraph-progress.test.ts`
  (new)
- Test: extend `tests/cli/index-progress/renderer.test.ts` (existing) for the
  new level label.

**Interfaces:**

- Consumes: `EnrichmentProgressCallback` (already on the coordinator via
  `setEnrichmentProgress`), `this.grandFileCount`.
- Produces: `enrichment` IPC events
  `{ providerKey: "codegraph.symbols", level: "symbols", applied, total, totalFinal: false }`
  during the cross-pass chunk pass. `applied` = count of cross-pass extractions
  accepted so far.

- [ ] **Step 1: Write the failing coordinator test**

```ts
it("emits codegraph.symbols:symbols progress per accepted extraction on cross-pass", async () => {
  const events: EnrichmentProgressEvent[] = [];
  coordinator.setEnrichmentProgress((e) => events.push(e));
  // begin a cross-pass run with a codegraph provider, then feed 3 extractions
  await coordinator.beginRun({ crossPass: true, collectionName: "c" });
  for (const ex of threeExtractions) coordinator.onFileExtraction(ex, "c");
  const symbols = events.filter(
    (e) => e.providerKey === "codegraph.symbols" && e.level === "symbols",
  );
  expect(symbols.map((e) => e.applied)).toEqual([1, 2, 3]); // monotone
  expect(symbols.at(-1)?.totalFinal).toBe(false);
});

it("does NOT emit the symbols level on a non-cross-pass (incremental) run", async () => {
  const events: EnrichmentProgressEvent[] = [];
  coordinator.setEnrichmentProgress((e) => events.push(e));
  await coordinator.beginRun({ crossPass: false, collectionName: "c" });
  for (const ex of threeExtractions) coordinator.onFileExtraction(ex, "c");
  expect(events.filter((e) => e.level === "symbols")).toHaveLength(0);
});
```

- [ ] **Step 2: Run, verify fail**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/coordinator-codegraph-progress.test.ts`
Expected: FAIL — no `symbols`-level events emitted.

- [ ] **Step 3: Emit progress in the coordinator**

In `onFileExtraction` (~:455), after the `acceptExtraction` fan-out loop, when
the run is cross-pass and a codegraph provider accepted the extraction, bump a
per-run counter and call `progressCb`:

```ts
if (this.currentRun?.crossPass && this.progressCb) {
  this.codegraphSymbolsApplied += 1;
  this.progressCb({
    providerKey: "codegraph.symbols",
    level: "symbols",
    applied: this.codegraphSymbolsApplied,
    total: this.grandFileCount || this.codegraphSymbolsApplied,
    totalFinal: false,
  });
}
```

(Reset `codegraphSymbolsApplied = 0` in `beginRun`. Guard on
`acceptsExtractions()` so non-codegraph runs never emit it.)

- [ ] **Step 4: Run, verify green**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/coordinator-codegraph-progress.test.ts`
Expected: PASS.

- [ ] **Step 5: Renderer label for the new level (failing test first)**

Extend `tests/cli/index-progress/renderer.test.ts`:

```ts
it("renders a codegraph.symbols:symbols enrichment bar labelled 'codegraph nodes'", () => {
  const line = renderEnrichmentLine({
    type: "enrichment",
    providerKey: "codegraph.symbols",
    level: "symbols",
    applied: 40,
    total: 100,
    totalFinal: false,
  });
  expect(line).toContain("codegraph nodes");
  expect(line).toContain("40/100");
});
```

Run it → FAIL (label missing). Then add the `codegraph.symbols:symbols` →
`"codegraph nodes"` entry to the renderer's provider/level label map (~:154 for
the line renderer + the TTY bar registration path). Re-run → PASS. Confirm JSON
mode still no-ops (`JsonProgressRenderer` `case "enrichment"` unchanged, ~:561).

- [ ] **Step 6: Type-check + commit**

Run: `npx tsc --noEmit` → 0.

```bash
git add src/core/domains/ingest/pipeline/enrichment/coordinator.ts src/cli/index-progress/renderer.ts \
        tests/core/domains/ingest/pipeline/enrichment/coordinator-codegraph-progress.test.ts \
        tests/cli/index-progress/renderer.test.ts
git commit -m "feat(codegraph): report eager node-upsert progress in the CLI index UI"
```

---

## Task 4: Full-suite gate

**Files:** none (verification only).

- [ ] **Step 1: Run the codegraph + duckdb + cli suites**

Run:
`npx vitest run tests/core/adapters/duckdb tests/core/domains/trajectory/codegraph tests/core/domains/ingest/pipeline/enrichment tests/cli/index-progress`
Expected: all PASS.

- [ ] **Step 2: Type-check + lint**

Run: `npx tsc --noEmit` → 0. Run:
`npx eslint src/core/adapters/duckdb src/core/domains/trajectory/codegraph/symbols/provider.ts src/core/domains/ingest/pipeline/enrichment/coordinator.ts src/cli/index-progress`
→ 0.

- [ ] **Step 3: STOP — live validation is user-gated**

Do NOT `npm run build` / `npm link` / reindex from plan execution. Report to the
user that Tasks 1-3 are green and offer live cross-pass validation (build+link +
`DEBUG=1 tea-rags index-codebase --project <alias> --force --wait-enrichments`)
as an explicit, user-triggered next step — the real ~876s-tail measurement.

---

## Self-Review

- **Spec coverage:** overlap (Task 2) ✓; bulk-append (Task 1 `upsertSymbolsBulk`
  - Task 2 batched flush) ✓; CLI progress (Task 3) ✓; determinism invariant
    (Global Constraints + Task 2 Step 7) ✓; in-memory table stays in drain (Task
    2 Step 4) ✓; incremental path untouched (Task 2 Step 4, Step 7) ✓; graph
    equality (Task 2 Step 1) ✓; daemon==direct (Task 1 Step 7) ✓; out-of-scope
    pass-2 edge bulking + SCC/PageRank — not touched ✓.
- **Type consistency:** `upsertSymbolsBulk(entries: BulkSymbolUpsertEntry[])` +
  `BulkSymbolUpsertEntry = { relPath, definitions }` used identically in Task 1
  (interface, direct, daemon, server) and Task 2 (provider flush). Progress
  event
  `{ providerKey: "codegraph.symbols", level: "symbols", applied, total, totalFinal }`
  identical in Task 3 coordinator + renderer test.
- **Deviation flagged:** `acceptExtraction` stays sync (Task 2 note) — spec's
  "async" wording superseded for lower blast radius; behaviour + invariants
  unchanged.
