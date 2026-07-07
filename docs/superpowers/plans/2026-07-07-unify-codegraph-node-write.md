# Unify codegraph durable node-write — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `dinopowers:executing-plans`
> (wrapper over `superpowers:executing-plans`) — or
> `superpowers:subagent-driven-development` — to implement this plan
> task-by-task. TDD steps use `dinopowers:test-driven-development`. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the durable codegraph node-write (`cg_symbols`) through ONE
buffered-bulk mechanism (`nodeDefBuffer` → `chainNodeFlush` → `flushNodeBatch` →
`upsertSymbolsBulk`) on BOTH the full-index cross-pass path AND the incremental
`reindex_changes` path — replacing the incremental path's per-file
`graphDb.upsertSymbols`.

**Architecture:** Extract two seams already inline in the cross-pass path —
`bufferNodeDefs` (buffer + enqueue) and `flushNodeRemainder` (drain buffer +
await chain + rethrow) — and reuse them from the incremental path: `sink.write`
buffers instead of per-file upserting; `streamFileBatchInner` fire-and-chain
flushes each batch (preserving embedding overlap on small changesets);
`finalizeSignals` flushes the remainder before pass-2 edge-resolve
(nodes-before-edges).

**Tech Stack:** TypeScript (ESM), DuckDB (`DuckDbGraphClient`), Vitest, Node
`worker_threads` / streaming enrichment.

**Spec:**
`docs/superpowers/specs/2026-07-07-unify-codegraph-node-write-design.md`

## Global Constraints

- **Worktree-only** (`worktree-vcs-adapter`). Commit each Task on that branch.
  NEVER push, NEVER merge. Build/link/reindex are user-gated — do NOT run from
  plan execution.
- **TDD mandatory** — failing test first (red), minimal impl (green). No prod
  code before a failing test (Task 1 is a pure refactor guarded by existing
  tests).
- **`skipDurableNodeWrite` flag STAYS** — it still marks the cross-pass DRAIN
  sink to skip the durable write entirely (the eager `acceptExtraction` flush
  already wrote during embedding). Only the incremental `false` branch changes
  shape.
- **Do NOT touch:** pass-2 edge-resolve (`streamingResolveAndUpsert`) / Tarjan
  SCC / PageRank / `recomputeGraphMetricsStreaming`;
  `InMemoryGlobalSymbolTable`; `upsertSymbolsBulk` / `BulkSymbolUpsertEntry`
  primitives.
- **In-memory table unchanged:** `symbolTable.upsertFile` +
  `indexChunkSymbolsByLine`
  - run-global merges stay per-file, unconditional, in `sink.write`.
- **Determinism invariant (bd `yl9tv`) IMMUTABLE:** the cross-pass sorted
  drain + run-global last-write-wins order stays untouched.
  `provider-eager-flush.test.ts`
  - `provider-spill.test.ts` are business-logic — MOVE OK, REWRITE NO.
- **Reuse fix#1 primitives:** `nodeDefBuffer`, `enqueueNodeFlush`,
  `chainNodeFlush`, `flushNodeBatch`, `nodeFlushError`, `resetNodeFlushState`,
  `CODEGRAPH_NODE_FLUSH_FILES`.
- No `eslint-disable`, no lowered coverage thresholds, typed errors only, no new
  top-level `src/` dirs.

---

## File Structure

- **Modify** `src/core/domains/trajectory/codegraph/symbols/provider.ts`
  (`CodegraphEnrichmentProvider`):
  - add private `bufferNodeDefs(relPath, defs, collectionName?)`
  - add private `flushNodeRemainder(key, collectionName?)`
  - `acceptExtraction` → call `bufferNodeDefs` (byte-identical)
  - `drainInputSpill` → call `flushNodeRemainder` (byte-identical)
  - `asExtractionSink` `write` (`:844`) → `bufferNodeDefs` instead of per-file
    `upsertSymbols`
  - `streamFileBatchInner` end → per-batch fire-and-chain flush
  - `finalizeSignals` non-crossPass → `flushNodeRemainder` before
    `sink.finish()`
- **Create**
  `tests/core/domains/trajectory/codegraph/symbols/provider-incremental-bulk.test.ts`
  (incremental buffered-bulk invariants).

---

## Task 1: Extract shared seams — `bufferNodeDefs` + `flushNodeRemainder` (pure refactor)

Land the two extractions with ZERO behaviour change. The cross-pass path calls
the new helpers; existing cross-pass tests are the regression guard (no new test
— a behaviour-preserving refactor is verified by the untouched suite staying
green, per the relocation-migration test rule).

**Files:**

- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts`
  - `acceptExtraction` (~:1601-1604), `drainInputSpill` (~:1726-1729), plus two
    new privates near `enqueueNodeFlush` (~:1607) / `chainNodeFlush` (~:1621).

**Interfaces:**

- Produces:
  - `private bufferNodeDefs(relPath: RelPath, defs: SymbolDefinition[], collectionName?: string): void`
  - `private async flushNodeRemainder(key: string, collectionName?: string): Promise<void>`

- [ ] **Step 1: Add `bufferNodeDefs`** (near `enqueueNodeFlush`)

```ts
/**
 * Buffer one file's durable symbol defs for the bulk node-write chain. The
 * single seam BOTH entry points use: `acceptExtraction` (cross-pass main-thread
 * tee) and `asExtractionSink.write` (incremental worker). Pushes onto the
 * per-collection `nodeDefBuffer` and enqueues a flush once the buffer reaches
 * `nodeFlushFiles` (256 safety valve). Order-independent — `upsertSymbolsBulk`
 * is last-wins per relPath.
 */
private bufferNodeDefs(relPath: RelPath, defs: SymbolDefinition[], collectionName?: string): void {
  const key = this.collectionKey(collectionName);
  const buf = this.nodeDefBuffer.get(key) ?? [];
  buf.push({ relPath, definitions: defs });
  this.nodeDefBuffer.set(key, buf);
  this.enqueueNodeFlush(key, collectionName);
}
```

- [ ] **Step 2: Point `acceptExtraction` at it** — replace the inline
      buffer+enqueue (`:1601-1604`)

```ts
// was: const buf = this.nodeDefBuffer.get(key) ?? []; buf.push({...}); this.nodeDefBuffer.set(key, buf); this.enqueueNodeFlush(key, options?.collectionName);
this.bufferNodeDefs(
  extraction.relPath,
  this.buildSymbolDefs(extraction),
  options?.collectionName,
);
```

- [ ] **Step 3: Add `flushNodeRemainder`** (near `chainNodeFlush`)

```ts
/**
 * Flush the per-collection node buffer's remainder, await the whole flush chain,
 * and rethrow any latched eager-flush error — aborting the run before pass-2.
 * Every chain link resolves (errors latch in `nodeFlushError`, not a rejected
 * tail), so the await never trips an unhandled rejection. Shared by the
 * cross-pass drain and the incremental finalize so `cg_symbols` is fully durable
 * before pass-2 edge-resolve (nodes-before-edges).
 */
private async flushNodeRemainder(key: string, collectionName?: string): Promise<void> {
  const remainder = this.nodeDefBuffer.get(key)?.splice(0) ?? [];
  if (remainder.length > 0) this.chainNodeFlush(remainder, key, collectionName);
  await this.nodeFlushChain;
  if (this.nodeFlushError) throw this.nodeFlushError;
}
```

- [ ] **Step 4: Point `drainInputSpill` at it** — replace the inline block
      (`:1726-1729`)

```ts
// was: const remainder = this.nodeDefBuffer.get(key)?.splice(0) ?? []; if (remainder.length > 0) this.chainNodeFlush(remainder, key, collectionName); await this.nodeFlushChain; if (this.nodeFlushError) throw this.nodeFlushError;
await this.flushNodeRemainder(key, collectionName);
```

- [ ] **Step 5: Run the cross-pass regression suite — verify GREEN (behaviour
      identical)**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/provider-eager-flush.test.ts tests/core/domains/trajectory/codegraph/symbols/provider-spill.test.ts tests/core/domains/trajectory/codegraph/symbols/provider-spill-errors.test.ts tests/core/domains/trajectory/codegraph/symbols/provider-run-stats-crosspass.test.ts`
Expected: PASS (all) — the refactor is byte-identical for the cross-pass path.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit` Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/trajectory/codegraph/symbols/provider.ts
git commit -m "refactor(trajectory): extract bufferNodeDefs + flushNodeRemainder seams

Pure extraction of the inline buffer+enqueue (acceptExtraction) and the
remainder-flush+await+rethrow (drainInputSpill) into shared privates. Cross-pass
behaviour byte-identical; prep for incremental reuse."
```

---

## Task 2: Incremental path buffers through the shared mechanism (behaviour change)

Switch `sink.write`'s durable write from per-file `upsertSymbols` to
`bufferNodeDefs`; flush each streamed batch (overlap) and the finalize remainder
(nodes-before-edges). TDD — write the invariant tests first.

**Files:**

- Create:
  `tests/core/domains/trajectory/codegraph/symbols/provider-incremental-bulk.test.ts`
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts`
  - `asExtractionSink` `write` (~:844), `streamFileBatchInner` (~:1508-1526),
    `finalizeSignals` non-crossPass (~:1785-1787).

**Interfaces:**

- Consumes: `bufferNodeDefs`, `flushNodeRemainder` (Task 1); `chainNodeFlush`,
  `nodeDefBuffer` (fix#1); `collectionKey`.
- Driving API (existing, public): `provider.streamFileBatch(root, relPaths)`,
  `provider.finalizeSignals(root)`,
  `provider.beginExtractionRun(collectionName)` +
  `provider.acceptExtraction(e, {collectionName})` (cross-pass), real
  `DuckDbGraphClient` + `runMigrations`, spies on `client.upsertSymbols` /
  `client.upsertSymbolsBulk`.

- [ ] **Step 1: Write the failing tests** — `provider-incremental-bulk.test.ts`

Mirror the harness in `provider-eager-flush.test.ts` (real `DuckDbGraphClient`,
`runMigrations(MIG_DIR)`, `buildTestCodegraphDeps`, `mkExtraction`) and the
`makeRoot()` real-file pattern in `provider.test.ts` (`streamFileBatch` reads
files off disk via `extractOneFile`).

```ts
// Helper: run the INCREMENTAL path over a temp repo, return persisted cg_symbols
// + spy tallies. Reuses the same temp-DuckDB + provider construction as
// provider-eager-flush.test.ts (see that file's runCrossPass for the setup shape).
async function runIncremental(
  files: Record<string, string>,
  batches: string[][],
) {
  const root = mkdtempSync(join(tmpdir(), "cg-incr-"));
  for (const [rel, src] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), src);
  }
  const client = new DuckDbGraphClient({
    path: join(mkdtempSync(join(tmpdir(), "cg-incr-db-")), "g.duckdb"),
  });
  await client.init();
  await runMigrations(client, MIG_DIR);
  const perFileSpy = vi.spyOn(client, "upsertSymbols");
  const bulkSpy = vi.spyOn(client, "upsertSymbolsBulk");
  const provider = new CodegraphEnrichmentProvider({
    graphDb: client,
    symbolTable: new InMemoryGlobalSymbolTable(),
    ...buildTestCodegraphDeps(),
    composer: new DefaultSymbolIdComposer(),
    collectSymbols,
  });
  for (const batch of batches) await provider.streamFileBatch(root, batch);
  await provider.finalizeSignals(root);
  const rows = await client.queryAll(
    "SELECT * FROM cg_symbols ORDER BY rel_path, symbol_id",
  );
  return {
    rows,
    perFileCalls: perFileSpy.mock.calls.length,
    bulkCalls: bulkSpy.mock.calls.length,
    client,
    root,
  };
}

it("incremental writes cg_symbols via BULK, never per-file upsertSymbols", async () => {
  const { rows, perFileCalls, bulkCalls } = await runIncremental(
    {
      "src/a.ts": "export function a(){return 1;}\n",
      "src/b.ts": "export function b(){return 2;}\n",
    },
    [["src/a.ts"], ["src/b.ts"]],
  );
  expect(rows.length).toBeGreaterThan(0);
  expect(perFileCalls).toBe(0); // RED before impl: currently per-file
  expect(bulkCalls).toBeGreaterThan(0);
});

it("incremental cg_symbols == cross-pass cg_symbols for the same files (graph-equality)", async () => {
  // Subject: incremental path. Reference: the fix#1-proven cross-pass path over
  // the SAME extractions (drive via acceptExtraction + cross-pass finalize, per
  // provider-eager-flush.test.ts runCrossPass). Assert byte-identical rows.
  // (executor: reuse runCrossPass from the eager-flush harness or inline it.)
  const files = {
    "src/a.ts": "export function a(){return 1;}\n",
    "src/b.ts": 'import {a} from "./a.js";\nexport function b(){return a();}\n',
  };
  const incr = await runIncremental(files, [["src/a.ts", "src/b.ts"]]);
  const cross = await runCrossPassOverFiles(files); // parses same files, drives acceptExtraction+cross-pass finalize
  expect(incr.rows).toEqual(cross.rows);
});

it("in-memory symbolTable.upsertFile stays per-file (resolution source of truth unaffected)", async () => {
  // Spy symbolTable.upsertFile: called once per streamed file regardless of the
  // bulk durable path — the resolver's in-memory table must remain synchronous.
  // (assert upsertFile call count == number of streamed files.)
});

it("a mid-incremental flush failure rethrows at finalizeSignals (no unhandled rejection)", async () => {
  // Make upsertSymbolsBulk reject once; drive an incremental run; expect
  // provider.finalizeSignals(root) to reject with that error. Mirror the
  // bulkReject pattern in provider-eager-flush.test.ts.
});
```

- [ ] **Step 2: Run — verify RED**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/provider-incremental-bulk.test.ts`
Expected: FAIL — `perFileCalls` is currently > 0 (per-file path), `bulkCalls`
is 0.

- [ ] **Step 3: `sink.write` buffers instead of per-file upsert**
      (`asExtractionSink`, ~:844)

```ts
// was: if (!skipDurableNodeWrite) await graphDb.upsertSymbols(extraction.relPath, defs);
if (!skipDurableNodeWrite)
  this.bufferNodeDefs(extraction.relPath, defs, collectionName);
```

(`symbolTable.upsertFile(extraction.relPath, defs)` on the line above stays
unconditional — unchanged.)

- [ ] **Step 4: `streamFileBatchInner` per-batch flush** — after the file loop,
      before `return new Map()` (~:1526)

```ts
// Fire-and-chain flush of THIS batch's buffered defs so each streamed batch's
// nodes land durably DURING embedding overlap (the 256 threshold alone would
// defer a <256-file changeset to finalize, losing the overlap the per-file path
// had). Not awaited — overlaps the next embedding batch; finalize awaits the chain.
const key = this.collectionKey(options?.collectionName);
const batch = this.nodeDefBuffer.get(key)?.splice(0) ?? [];
if (batch.length > 0) this.chainNodeFlush(batch, key, options?.collectionName);
```

(Note: `key` may already be in scope from `:1492` — reuse it, don't redeclare.)

- [ ] **Step 5: `finalizeSignals` non-crossPass flushes remainder before
      pass-2** (~:1785-1787)

```ts
if (options?.crossPass)
  await this.drainInputSpill(key, options?.collectionName);
else await this.flushNodeRemainder(key, options?.collectionName); // nodes-before-edges on the incremental path
const sink = this.runSinks.get(key);
if (sink) await sink.finish();
```

- [ ] **Step 6: Run the new suite — verify GREEN**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/provider-incremental-bulk.test.ts`
Expected: PASS (all four).

- [ ] **Step 7: Cross-pass regression + type-check**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/ && npx tsc --noEmit`
Expected: PASS + clean — cross-pass unaffected, incremental unified.

- [ ] **Step 8: Commit**

```bash
git add src/core/domains/trajectory/codegraph/symbols/provider.ts tests/core/domains/trajectory/codegraph/symbols/provider-incremental-bulk.test.ts
git commit -m "feat(trajectory): unify incremental codegraph node-write onto buffered bulk

sink.write buffers via bufferNodeDefs (was per-file upsertSymbols);
streamFileBatchInner fire-and-chain flushes each batch (preserves embedding
overlap on <256-file changesets); finalizeSignals flushes the remainder before
pass-2 (nodes-before-edges). One durable-node-write mechanism across cross-pass
and incremental. skipDurableNodeWrite retained for the cross-pass drain skip."
```

---

## Task 3: Full gate + adversarial review + fix loop

`provider.ts` is extreme-churn (85 commits) and the node-flush machinery is
deep-silo (single author, no second reviewer) → an adversarial whole-diff review
is mandatory before this is considered done.

- [ ] **Step 1: Full test + type + lint gate**

Run:
`npx vitest run && npx tsc --noEmit && npx eslint src/core/domains/trajectory/codegraph/symbols/provider.ts`
Expected: all green, zero eslint findings.

- [ ] **Step 2: Adversarial whole-diff review** — dispatch a code-reviewer
      subagent (`superpowers:requesting-code-review` template) over
      `git diff main...HEAD` restricted to this plan's commits. Reviewer MUST
      specifically check:
  - nodes-before-edges holds on the incremental path (remainder flushed before
    `sink.finish()`);
  - `skipDurableNodeWrite=true` drain still writes NO durable nodes (no
    double-write / no re-buffer);
  - `nodeFlushError` cannot leak as an unhandled rejection on the incremental
    path;
  - per-batch flush uses the correct `key` (no cross-collection buffer bleed
    under concurrent `streamFileBatch`);
  - the in-memory `symbolTable` + run-global merges are untouched (determinism
    `yl9tv`).

- [ ] **Step 3: Apply review fixes** (if any) with TDD — a new failing test per
      confirmed finding, then the fix. Re-run Step 1 gate.

- [ ] **Step 4: Final commit** (if fixes applied)

```bash
git add -A
git commit -m "fix(trajectory): address adversarial review of node-write unification"
```

---

## Self-review (author checklist — done)

- **Spec coverage:** §Design edits 1-6 → Task 1 (bufferNodeDefs,
  flushNodeRemainder, acceptExtraction, drainInputSpill) + Task 2 (sink.write,
  streamFileBatchInner, finalizeSignals). Invariants 1-5 → Task 2 Step 1 tests +
  Task 1 regression guard.
- **Placeholder scan:** the four Task 2 tests carry concrete driver code for the
  two measurable invariants (bulk-not-per-file, graph-equality); the
  symbolTable-per-file and error-propagation tests carry intent + the exact
  harness pattern to mirror (`spyOn` counts, `bulkReject` from the eager-flush
  file) — the executor fills the assertion bodies against the real client API
  during the RED step, per TDD.
- **Type consistency:** `bufferNodeDefs(relPath, defs, collectionName?)` +
  `flushNodeRemainder(key, collectionName?)` used identically in every
  reference.
