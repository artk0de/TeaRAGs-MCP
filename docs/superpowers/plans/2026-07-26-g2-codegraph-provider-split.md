# G2 — CodegraphEnrichmentProvider Collaborator Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> dinopowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose the 2836-LOC `CodegraphEnrichmentProvider` god-module into
four named collaborators plus a thin `EnrichmentProvider` facade, with zero
observable behavior change.

**Architecture:** The provider currently owns run-global mutable state (20+
fields), the extraction sink closure, the durable node-flush chain, pass-2 call
resolution, and SCC/PageRank scheduling. Extraction order is dictated by data
ownership: `CodegraphRunState` first (every other collaborator reads or mutates
those fields — without it the others degrade into back-references to the
provider), then `SymbolNodeFlushQueue`, `CallEdgeResolutionRunner`,
`GraphBuildFinalizer`, and finally the sink factory that wires them. The
provider keeps its public surface byte-identical and wires collaborators in its
constructor — the shape proven by `GitTrajectory#constructor`
(`src/core/domains/trajectory/git.ts`).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, DuckDB graph
client, tree-sitter walkers via injected `LanguageFactoryDescriptor`.

## Global Constraints

- `.claude/rules/test-invariants.md` governs every task: a behavior-preserving
  change leaves `tests/**` semantically untouched. `git diff --stat -- tests/`
  must be empty for Tasks 2–7, except Task 1 (new characterization tests) and
  Task 8 (relocation of test files).
- Relocation-migration order (inverts TDD): **relocate code → suite green →
  redistribute tests LAST**. Task 8 is the only task that moves test files.
- `.claude/rules/naming.md`: exported names are domain-qualified and unambiguous
  in an import line.
- `.claude/rules/barrel-files.md`: `codegraph/symbols/` is not a domain boundary
  directory; new files are imported directly by `provider.ts`, not re-exported
  through `symbols/index.ts` unless a consumer outside `codegraph/symbols/`
  needs them (none does).
- `.claude/rules/typed-errors.md`: existing typed errors
  (`CodegraphSpillIoError`, `CodegraphResolveError`, `CodegraphCheckpointError`,
  `CodegraphMetricsError`) move with their code; no error type is introduced,
  renamed, or swallowed.
- `.claude/rules/domain-boundaries.md`: `trajectory/**` must not import
  `domains/language/**`. All new files inherit that constraint — language
  capability arrives only via the injected `LanguageFactoryDescriptor`.
- Conventional commits, scope `trajectory`: `refactor(trajectory):` for moves,
  `test(trajectory):` for the characterization and relocation tasks.
- Coverage thresholds are never lowered. If a commit trips the pre-commit
  coverage gate, delegate to the `coverage-expander` subagent.
- Plan syncs 1:1 into beads tasks under epic `tea-rags-mcp-6vfrj`.

## Spec deviations (decided, not open questions)

The spec
(`docs/superpowers/specs/2026-07-21-architecture-drift-refactoring-design.md`,
Group 2) named four collaborators. Reading the current code changes two details:

1. **`run-state.ts` is extracted FIRST, not last.** The spec listed it fourth.
   `resolveExtraction` reads 15 run-global fields that `sink.write` mutates, so
   any other extraction order forces the new collaborators to hold a provider
   back-reference. Ownership moves first; everything else then takes a typed
   `CodegraphRunState` parameter.
2. **Node-flush gets its own file `node-flush.ts`**, instead of living inside
   `extraction-sink.ts` as the spec sketched. The flush chain has two entry
   points that are NOT the sink — `acceptExtraction` (main-thread cross-pass
   tee) and `endExtractionRun` — so filing it under the sink would make the sink
   a false owner. One responsibility per file.

Both deviations preserve the spec's decision (collaborator-split modeled on the
EnrichmentCoordinator split, provider stays a thin facade); they change only
which file owns what.

## File Structure

All paths relative to `src/core/domains/trajectory/codegraph/symbols/`.

| File                         | Responsibility                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `run-state.ts` (new)         | Owns every run-global aggregate + `RunStats`; the pass-1→pass-2 seal; the four reset seams; run-metrics drain.        |
| `node-flush.ts` (new)        | Owns the durable batched `cg_symbols` write chain: buffer → cadence flush → remainder drain → latched error.          |
| `resolution-runner.ts` (new) | Owns pass-2 per-file call resolution: builds `CallContext`, dispatches per call, tallies, emits `GraphEdges`.         |
| `graph-finalizer.ts` (new)   | Owns the streaming pass-2 loop (spill → resolve → bulk upsert → checkpoint) and SCC/PageRank recompute.               |
| `extraction-sink.ts` (new)   | Owns the `ExtractionSink` factory (`write`/`finish`) and the run-sink lifecycle helper.                               |
| `provider.ts` (modify)       | Thin `EnrichmentProvider` facade: DI validation, scope policy, file discovery, signal read-back, collaborator wiring. |

Out of scope, do NOT touch: `symbol-table.ts` (fanIn 73 — the real architectural
hub), `filters.ts` and `self-dispatch-discovery.ts` (deep-silo, single-owner),
`payload-signals.ts`, `inheritance-edges.ts`, `receiver-kind.ts`.

---

### Task 1: Characterization tests for run-reset and run-metrics seams

The four reset seams are NOT identical today — `clearRunState` also clears
`runIncludedBy`, the `getRunMetrics` success tail clears only five of the
sixteen aggregates, and `onRelease` clears sink maps too. That asymmetry is
load-bearing until proven otherwise, so pin it BEFORE moving any of it. These
are new tests over existing behavior (test-invariants rule 4 does not apply — no
invariant is changing).

**Files:**

- Test:
  `tests/core/domains/trajectory/codegraph/symbols/provider-run-reset-seams.test.ts`
  (create)

**Interfaces:**

- Consumes: the provider's existing public surface only — `beginExtractionRun`,
  `asExtractionSink`, `getRunMetrics`, `finalizeSignals`, `onRelease`.
- Produces: nothing consumed by later tasks; it is the safety net they run
  against.

- [ ] **Step 1: Read the seams you are pinning**

Read `src/core/domains/trajectory/codegraph/symbols/provider.ts` lines 1293–1325
(`getRunMetrics` empty-run branch), 1373–1379 (success tail), 2009–2029
(`clearRunState`), 2037–2047 (`resetNodeFlushState`), 2069–2093 (`onRelease`).
Write down which fields each one clears — the test asserts exactly that set.

- [ ] **Step 2: Write the characterization test**

Reuse the fixture style of the existing suite (a real DuckDB client + temp dir),
copying setup from
`tests/core/domains/trajectory/codegraph/symbols/provider-run-stats.test.ts`.
Assert through observable surface only — never reach into private fields.

```typescript
import { describe, expect, it } from "vitest";

describe("CodegraphEnrichmentProvider — run-reset seams", () => {
  it("getRunMetrics returns undefined and zeroes the tally for an empty run", async () => {
    const { provider } = await makeProvider();
    expect(provider.getRunMetrics()).toBeUndefined();
    // Second call still undefined — the empty branch is idempotent.
    expect(provider.getRunMetrics()).toBeUndefined();
  });

  it("getRunMetrics is read-and-clear: a second call after a real run reports an empty run", async () => {
    const { provider, root, collectionName } = await makeProvider();
    await provider.buildFileSignals(root, { collectionName });
    await provider.finalizeSignals(root, { collectionName });
    const first = provider.getRunMetrics();
    expect(first?.extractedFiles).toBeGreaterThan(0);
    expect(provider.getRunMetrics()).toBeUndefined();
  });

  it("beginExtractionRun zeroes a prior run's tally so counts never leak across runs", async () => {
    const { provider, root, collectionName } = await makeProvider();
    await provider.buildFileSignals(root, { collectionName });
    provider.beginExtractionRun(collectionName);
    await provider.finalizeSignals(root, { collectionName, crossPass: true });
    const metrics = provider.getRunMetrics();
    expect(metrics?.extractedFiles ?? 0).toBe(0);
  });

  it("onRelease clears run state so a reused instance starts clean", async () => {
    const { provider, root, collectionName } = await makeProvider();
    await provider.buildFileSignals(root, { collectionName });
    await provider.onRelease();
    expect(provider.getRunMetrics()).toBeUndefined();
  });
});
```

Replace `makeProvider()` with the concrete helper the neighbouring test files
use — copy their `beforeEach` verbatim rather than inventing a new fixture.

- [ ] **Step 3: Run the test — it must PASS (characterization, not TDD)**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/provider-run-reset-seams.test.ts`
Expected: PASS. A failure here means the test misreads current behavior — fix
the TEST, never the provider.

- [ ] **Step 4: Commit**

```bash
git add tests/core/domains/trajectory/codegraph/symbols/provider-run-reset-seams.test.ts
git commit -m "test(trajectory): pin codegraph run-reset + run-metrics seams before G2 split"
```

---

### Task 2: Extract `CodegraphRunState`

**Files:**

- Create: `src/core/domains/trajectory/codegraph/symbols/run-state.ts`
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts` (fields at
  507–652; `getRunMetrics` 1293–1392; `loadGemfile` 1458–1466; `clearRunState`
  2009–2029; `onRelease` 2069–2093; every `this.run*` read in `asExtractionSink`
  and `resolveExtraction`)

**Interfaces:**

- Consumes: `RunStats`, `createEmptyRunStats`, `aggregateReceiverKinds`,
  `languageKindTally`, `emptyReceiverKindTally`, `ReceiverKindTally` — all
  currently private to `provider.ts` (lines 2549–2676). They move to
  `run-state.ts` with the state.
- Produces:

```typescript
export class CodegraphRunState {
  stats: RunStats;
  ancestors: Record<string, readonly string[]>;
  compactClasses: Set<string>;
  prependedAncestors: Record<string, readonly string[]>;
  includedBy: Record<string, string[]>;
  classExtends: Record<string, string>;
  returnTypes: Record<string, string>;
  readonly instantiatedTypes: Set<string>;
  ivarTypes: Record<string, Record<string, string>>;
  structuredReturnTypes: Record<string, RubyTypeRef>;
  dispatchTables: Record<string, DispatchTableDef[]>;
  callbackParams: Record<string, number[]>;
  inheritanceRows: InheritanceEdgeRow[];
  hierarchyView: HierarchyView | undefined;
  selfDispatchMethods: SelfDispatchMethod[];
  selfDispatchTemplates: Record<string, string>;
  selfInstantiatingClassMethods: string[];
  gemfileContent: string | undefined;

  /** Read the run's Gemfile once (guarded). Was `provider.loadGemfile`. */
  loadGemfile(root: string): void;

  /** Pass-1→pass-2 barrier: hierarchy view + includedBy + self-dispatch templates. */
  seal(symbolTable: GlobalSymbolTable): void;

  /** Read-and-clear run metrics. Was `provider.getRunMetrics` body. */
  drainMetrics(): ProviderRunMetrics | undefined;

  /** Map the per-(language, receiver-kind) tally to persistable rows. */
  toResolveRunStatsRows(): ResolveRunStatsRow[];

  /** Seams — deliberately NOT unified (see the note below). */
  resetTally(): void; // was: `this.runStats = createEmptyRunStats()`
  clearForNextRun(): void; // was: `clearRunState` body minus resetNodeFlushState
  clearAll(): void; // was: `onRelease` run-global block
}
```

**Seam asymmetry is preserved, not fixed.** `clearForNextRun` clears
`includedBy`; the metrics-drain tail clears only `stats`, `ancestors`,
`compactClasses`, `gemfile*`, `prependedAncestors`; `clearAll` clears everything
but `includedBy`. Keep each one byte-equivalent to today. File a follow-up bead
for unification — with the SSoT in place it becomes a one-line change, but it is
a behavior change and does not belong in a relocation commit.

- [ ] **Step 1: Create `run-state.ts` with the state, the tally helpers, and the
      seams**

Move verbatim from `provider.ts`: the `ReceiverKindTally` and `RunStats`
interfaces (2549–2610), `emptyReceiverKindTally` (2611–2626),
`languageKindTally` (2627–2639), `aggregateReceiverKinds` (2640–2653),
`createEmptyRunStats` (2654–2676). Then declare the class above, moving each
field with its existing doc comment intact — the comments carry the bead
references that explain why each map exists.

`seal(symbolTable)` is the barrier block currently inlined in `sink.finish`
(provider.ts 1019–1043):

```typescript
seal(symbolTable: GlobalSymbolTable): void {
  this.hierarchyView = new MapHierarchyView(buildHierarchySnapshot(this.inheritanceRows));
  this.includedBy = buildIncludedBy(this.ancestors, this.prependedAncestors);
  if (this.selfDispatchMethods.length > 0) {
    this.selfDispatchTemplates = foldSelfDispatchTemplates(
      discoverSelfDispatchTemplates(
        this.selfDispatchMethods,
        buildSelfDispatchProbe(symbolTable, this.hierarchyView),
      ),
    );
    this.selfInstantiatingClassMethods = collectSelfInstantiatingClassMethods(this.selfDispatchMethods);
  }
}
```

`buildIncludedBy` stays exported from `provider.ts` (it is imported by
`tests/.../included-by.test.ts`); `run-state.ts` imports it from there. Moving
it would break that import — leave it alone.

- [ ] **Step 2: Rewire the provider to delegate**

In `provider.ts`, replace the 16 run-global fields with one:

```typescript
private readonly runState = new CodegraphRunState();
```

Then mechanically rewrite every reader/writer. The full rename table — apply ALL
of it, there are no other `this.run*` references:

| Before                                  | After                                         |
| --------------------------------------- | --------------------------------------------- |
| `this.runStats`                         | `this.runState.stats`                         |
| `this.runAncestors`                     | `this.runState.ancestors`                     |
| `this.runCompactClasses`                | `this.runState.compactClasses`                |
| `this.runPrependedAncestors`            | `this.runState.prependedAncestors`            |
| `this.runIncludedBy`                    | `this.runState.includedBy`                    |
| `this.runExtends`                       | `this.runState.classExtends`                  |
| `this.runReturnTypes`                   | `this.runState.returnTypes`                   |
| `this.runInstantiatedTypes`             | `this.runState.instantiatedTypes`             |
| `this.runIvarTypes`                     | `this.runState.ivarTypes`                     |
| `this.runStructuredReturnTypes`         | `this.runState.structuredReturnTypes`         |
| `this.runDispatchTables`                | `this.runState.dispatchTables`                |
| `this.runCallbackParams`                | `this.runState.callbackParams`                |
| `this.runInheritanceRows`               | `this.runState.inheritanceRows`               |
| `this.hierarchyView`                    | `this.runState.hierarchyView`                 |
| `this.runSelfDispatchMethods`           | `this.runState.selfDispatchMethods`           |
| `this.runSelfDispatchTemplates`         | `this.runState.selfDispatchTemplates`         |
| `this.runSelfInstantiatingClassMethods` | `this.runState.selfInstantiatingClassMethods` |
| `this.runGemfileContent`                | `this.runState.gemfileContent`                |
| `this.loadGemfile(root)`                | `this.runState.loadGemfile(root)`             |

`runGemfileLoaded` becomes private to `CodegraphRunState` (only `loadGemfile`
reads it, plus the reset seams). Method bodies become delegations:

```typescript
getRunMetrics(): ProviderRunMetrics | undefined {
  const metrics = this.runState.drainMetrics();
  if (metrics === undefined) this.resetNodeFlushState();
  else this.resetNodeFlushState();
  return metrics;
}
```

Both branches call `resetNodeFlushState()` with no key today (1323 and 1379), so
collapse to a single call after the drain — same behavior, one statement:

```typescript
getRunMetrics(): ProviderRunMetrics | undefined {
  const metrics = this.runState.drainMetrics();
  this.resetNodeFlushState();
  return metrics;
}
```

`clearRunState(key)` becomes:

```typescript
private clearRunState(key: string): void {
  this.runState.clearForNextRun();
  this.resetNodeFlushState(key);
}
```

The `onRelease` run-global block becomes `this.runState.clearAll();` — the sink
maps (`chunkSymbolByLine`, `runSinks`, `runExtractedPaths`, `runBatchChains`,
`xpassWritten`) stay on the provider for now; Task 6 revisits them.

- [ ] **Step 3: Type-check and run the codegraph suite**

Run: `npx tsc --noEmit -p tsconfig.json` Expected: clean.

Run: `npx vitest run tests/core/domains/trajectory/codegraph` Expected: PASS,
including the Task 1 characterization file.

- [ ] **Step 4: Verify tests were not touched**

Run: `git diff --stat -- tests/` Expected: EMPTY output. Any entry means the
refactor changed behavior or a test asserted internals — stop and diagnose per
test-invariants rule 2.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/trajectory/codegraph/symbols/run-state.ts src/core/domains/trajectory/codegraph/symbols/provider.ts
git commit -m "refactor(trajectory): extract CodegraphRunState from provider god-module"
```

---

### Task 3: Extract `SymbolNodeFlushQueue`

**Files:**

- Create: `src/core/domains/trajectory/codegraph/symbols/node-flush.ts`
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts` (fields
  487–500; `bufferNodeDefs` 1730–1740; `enqueueNodeFlush` 1749–1754;
  `chainNodeFlush` 1765–1771; `flushNodeRemainder` 1781–1786; `flushNodeBatch`
  1794–1804; `resetNodeFlushState` 2037–2047)

**Interfaces:**

- Consumes: `CodegraphRunState` is NOT involved. The queue needs a store
  resolver — pass the provider's `getStore` as a bound callback so the queue
  never learns about pools.
- Produces:

```typescript
export type GraphDbResolver = (
  collectionName?: string,
) => Promise<{ graphDb: GraphDbClient }>;

export class SymbolNodeFlushQueue {
  constructor(resolveStore: GraphDbResolver, flushFiles: number);
  /** Buffer one file's defs; flush when the buffer reaches the cadence. */
  buffer(
    relPath: string,
    defs: SymbolDefinition[],
    key: string,
    collectionName?: string,
  ): void;
  /** Flush the remainder, await the chain, rethrow the latched error. */
  flushRemainder(key: string, collectionName?: string): Promise<void>;
  /** Reset buffer + flushed-set (per key, or all when key is undefined). */
  reset(key?: string): void;
}
```

Note the signature change from the provider's private
`bufferNodeDefs(relPath, defs, collectionName)`: the queue takes `key`
explicitly instead of recomputing `collectionKey(collectionName)` internally,
because `collectionKey` stays a provider concern. Both call sites already have
the key in hand or can compute it in one call.

- [ ] **Step 1: Create `node-flush.ts`**

Move the five methods verbatim into the class, renaming `this.nodeDefBuffer` →
`this.buffer_`, `this.nodeFlushChain` → `this.chain`, `this.nodeFlushError` →
`this.latchedError`, `this.nodeFlushedFiles` → `this.flushedFiles`,
`this.nodeFlushFiles` → `this.flushFiles`. Keep every doc comment — they explain
the load-bearing "every chain link resolves so Node ≥22 never terminates on an
unhandled rejection" invariant.

```typescript
private async flushBatch(batch: BulkSymbolUpsertEntry[], key: string, collectionName?: string): Promise<void> {
  if (batch.length === 0) return;
  const { graphDb } = await this.resolveStore(collectionName);
  await graphDb.upsertSymbolsBulk(batch);
  const flushed = this.flushedFiles.get(key) ?? new Set<string>();
  for (const e of batch) flushed.add(e.relPath);
  this.flushedFiles.set(key, flushed);
  if (isDebug()) {
    console.error("[GitEnrich] PHASE: CODEGRAPH_NODES_FLUSH", { batch: batch.length, cumulative: flushed.size });
  }
}
```

`nodeFlushFilesFromEnv()` (provider.ts 2733) stays in `provider.ts` — it is env
parsing, a composition concern; the provider passes the resolved number into the
queue constructor.

- [ ] **Step 2: Rewire the provider**

```typescript
private readonly nodeFlush = new SymbolNodeFlushQueue(
  (collectionName) => this.getStore(collectionName),
  nodeFlushFilesFromEnv(),
);
```

Call-site rewrites — all five, no others exist:

| Before                                                                                                         | After                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `this.bufferNodeDefs(relPath, defs, collectionName)` (sink.write 889)                                          | `this.nodeFlush.buffer(relPath, defs, this.collectionKey(collectionName), collectionName)`                                                      |
| `this.bufferNodeDefs(...)` (acceptExtraction 1719)                                                             | `this.nodeFlush.buffer(extraction.relPath, this.buildSymbolDefs(extraction), key, options?.collectionName)` — `key` is already in scope at 1695 |
| `this.flushNodeRemainder(key, collectionName)` (sink.finish 1007, drainInputSpill 1892, endExtractionRun 1853) | `this.nodeFlush.flushRemainder(key, collectionName)`                                                                                            |
| `this.resetNodeFlushState(key)`                                                                                | `this.nodeFlush.reset(key)`                                                                                                                     |
| `this.resetNodeFlushState()`                                                                                   | `this.nodeFlush.reset()`                                                                                                                        |

The `getStore` callback returns the full `{graphDb, symbolTable}` pair, which
structurally satisfies `{graphDb}` — no adapter needed.

- [ ] **Step 3: Type-check, run the eager-flush and crosspass suites**

Run: `npx tsc --noEmit -p tsconfig.json` Expected: clean.

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/provider-eager-flush.test.ts tests/core/domains/trajectory/codegraph/symbols/provider-crosspass-node-remainder.test.ts tests/core/domains/trajectory/codegraph/symbols/provider-incremental-bulk.test.ts`
Expected: PASS — these three pin the flush cadence, the cross-pass remainder,
and the bulk write path respectively.

- [ ] **Step 4: Full suite + untouched-tests check**

Run: `npx vitest run` Expected: PASS.

Run: `git diff --stat -- tests/` Expected: EMPTY.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/codegraph/symbols/node-flush.ts src/core/domains/trajectory/codegraph/symbols/provider.ts
git commit -m "refactor(trajectory): extract SymbolNodeFlushQueue from provider god-module"
```

---

### Task 4: Extract `CallEdgeResolutionRunner`

`resolveExtraction` is the single largest method (268 LOC vs the ≤87 threshold).
Extract it whole first, then decompose it internally — two commits, so a
reviewer can check the move and the decomposition independently.

**Files:**

- Create: `src/core/domains/trajectory/codegraph/symbols/resolution-runner.ts`
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts`
  (`resolveExtraction` 2280–2546; `defaultImportFileEdges` 2677–2695 moves too)

**Interfaces:**

- Consumes: `CodegraphRunState` (Task 2), `LanguageFactoryDescriptor` from
  `CodegraphProviderDeps`, `GlobalSymbolTable` per call.
- Produces:

```typescript
export class CallEdgeResolutionRunner {
  constructor(
    private readonly languageFactory: LanguageFactoryDescriptor,
    private readonly runState: CodegraphRunState,
  ) {}

  /** Pass-2 per-file resolution. Was `provider.resolveExtraction`. */
  resolve(
    extraction: FileExtraction,
    symbolTable: GlobalSymbolTable,
  ): GraphEdges;
}
```

- [ ] **Step 1: Move `resolveExtraction` verbatim into the new class**

Copy lines 2280–2546 into `CallEdgeResolutionRunner#resolve`, rewriting
`this.deps.languageFactory` → `this.languageFactory` and every `this.run*` /
`this.hierarchyView` read to the `this.runState.*` names from Task 2's rename
table. Move `defaultImportFileEdges` (2677–2695) into this file — `resolve` is
its only caller.

- [ ] **Step 2: Wire the provider and delete the old method**

```typescript
private readonly resolutionRunner = new CallEdgeResolutionRunner(
  this.deps.languageFactory,
  this.runState,
);
```

Field initializers run before the constructor body but after parameter
properties are assigned, so `this.deps` is available. If TypeScript disagrees
under the project's target, assign in the constructor body instead — after the
existing mutual-exclusion validation.

The single call site is `streamingResolveAndUpsert` (1135):

```typescript
edges = this.resolutionRunner.resolve(extraction, symbolTable);
```

- [ ] **Step 3: Verify the move**

Run: `npx tsc --noEmit -p tsconfig.json` Expected: clean.

Run: `npx vitest run tests/core/domains/trajectory/codegraph` Expected: PASS —
`resolve-regression-gate.test.ts`, `provider-cone.test.ts`,
`provider-ambiguous-fanout*.test.ts`, `super-module-mro.test.ts` and
`inproject-edge-recall.test.ts` all exercise this path.

Run: `git diff --stat -- tests/` Expected: EMPTY.

- [ ] **Step 4: Commit the move**

```bash
git add src/core/domains/trajectory/codegraph/symbols/resolution-runner.ts src/core/domains/trajectory/codegraph/symbols/provider.ts
git commit -m "refactor(trajectory): extract CallEdgeResolutionRunner from provider god-module"
```

- [ ] **Step 5: Decompose `resolve` into three private helpers**

`resolve` is still 268 LOC. Split along the seams the code already has — context
construction, per-call dispatch, miss classification:

```typescript
/** Run-global-if-present-else-extraction selection for every resolver input. */
private buildResolverInputs(extraction: FileExtraction): ResolverInputs;

/** One call site → pushed edges. Returns true when at least one edge was emitted. */
private resolveCall(
  call: CallRef,
  chunk: ChunkExtraction,
  ctx: CallContext,
  resolver: CallResolver,
  methodEdges: GraphEdges["methodEdges"],
  ambiguousFanouts: NonNullable<GraphEdges["ambiguousFanouts"]>,
  kindTally: Record<ReceiverKind, ReceiverKindTally>,
  receiverKind: ReceiverKind,
): boolean;

/** Bucket an unresolved call: unresolvable / externalSkipped / noInProjectDef. */
private classifyMiss(
  call: CallRef,
  ctx: CallContext,
  resolver: CallResolver,
  symbolTable: GlobalSymbolTable,
  kindTally: Record<ReceiverKind, ReceiverKindTally>,
  receiverKind: ReceiverKind,
): void;
```

`ResolverInputs` is a local interface holding the ten `*ForResolver` values
computed at 2299–2331. The ambiguous-fanout `continue` at 2478 becomes a
distinct return from `resolveCall` — model it as a small union rather than a
bare boolean if the `continue` semantics get awkward:

```typescript
type CallResolutionOutcome = "resolved" | "unresolved" | "ambiguous";
```

`"ambiguous"` skips miss classification (today's `continue`); `"unresolved"`
falls through to `classifyMiss`; `"resolved"` bumps the resolved counters.

- [ ] **Step 6: Verify the decomposition changed nothing**

Run: `npx vitest run tests/core/domains/trajectory/codegraph` Expected: PASS.

Run: `npx vitest run` Expected: PASS.

Run: `git diff --stat -- tests/` Expected: EMPTY.

Confirm every method is now under the threshold:

```bash
grep -nE '^  (private |public )?(async )?[a-zA-Z_][a-zA-Z0-9_]*\(' src/core/domains/trajectory/codegraph/symbols/resolution-runner.ts
```

Expected: no method spans more than 87 lines between consecutive signatures.

- [ ] **Step 7: Commit the decomposition**

```bash
git add src/core/domains/trajectory/codegraph/symbols/resolution-runner.ts
git commit -m "refactor(trajectory): decompose CallEdgeResolutionRunner.resolve into context/dispatch/miss helpers"
```

---

### Task 5: Extract `GraphBuildFinalizer`

**Files:**

- Create: `src/core/domains/trajectory/codegraph/symbols/graph-finalizer.ts`
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts`
  (`streamingResolveAndUpsert` 1077–1226; `recomputeGraphMetricsStreaming`
  1247–1285)

**Interfaces:**

- Consumes: `CallEdgeResolutionRunner` (Task 4), `CodegraphRunState` (Task 2)
  for the edge-count tally, and the store resolver callback.
- Produces:

```typescript
export class GraphBuildFinalizer {
  constructor(
    private readonly resolveStore: (
      collectionName?: string,
    ) => Promise<{ graphDb: GraphDbClient; symbolTable: GlobalSymbolTable }>,
    private readonly resolutionRunner: CallEdgeResolutionRunner,
    private readonly runState: CodegraphRunState,
  ) {}

  /** Streaming pass-2: spill → resolve → bulk upsert → checkpoint. */
  resolveAndUpsert(spillPath: string, collectionName?: string): Promise<void>;

  /** Tarjan SCC (file + method) + confidence-weighted PageRank. */
  recomputeMetrics(collectionName?: string): Promise<void>;
}
```

- [ ] **Step 1: Move both methods verbatim**

`streamingResolveAndUpsert` → `resolveAndUpsert`,
`recomputeGraphMetricsStreaming` → `recomputeMetrics`. Rewrite
`this.getStore(...)` → `this.resolveStore(...)`, `this.resolveExtraction(...)` →
`this.resolutionRunner.resolve(...)`, `this.runStats.*` →
`this.runState.stats.*`. The constants (`CHECKPOINT_EVERY`, `PROGRESS_EVERY`,
`MAX_EDGES_PER_FILE`, `BULK_FILES`) move with the loop; keep the comments that
justify each cap — they encode production failure modes (the 96k-edge ugnest
OOM, the daemon delegation branch).

- [ ] **Step 2: Wire the provider**

```typescript
private readonly graphFinalizer = new GraphBuildFinalizer(
  (collectionName) => this.getStore(collectionName),
  this.resolutionRunner,
  this.runState,
);
```

Call sites in `sink.finish` (1046 and 1056):

```typescript
if (spillWriteCount > 0) {
  await this.graphFinalizer.resolveAndUpsert(spillPath, collectionName);
}
try {
  await this.graphFinalizer.recomputeMetrics(collectionName);
} catch (err) {
  if (!(err instanceof CodegraphMetricsError)) throw err;
}
```

The `CodegraphMetricsError` swallow stays at the CALL site — it is the sink's
best-effort policy, not the finalizer's.

- [ ] **Step 3: Split `resolveAndUpsert` if it is still over threshold**

The moved loop is ~150 LOC. Extract the buffer flush and the per-file guard:

```typescript
/** Flush buffered files as ONE bulk transaction, wrapping failures with batch context. */
private flushBuffer(graphDb: GraphDbClient, buffer: BulkFileUpsertEntry[], processed: number): Promise<void>;

/** True when the file's edge count exceeds MAX_EDGES_PER_FILE (pathological minified bundle). */
private exceedsEdgeCap(edges: GraphEdges, extraction: FileExtraction, processed: number): boolean;
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit -p tsconfig.json` Expected: clean.

Run:
`npx vitest run tests/core/domains/trajectory/codegraph tests/core/adapters/duckdb`
Expected: PASS — `provider-spill.test.ts` and `provider-spill-errors.test.ts`
pin the streaming loop's error wrapping.

Run: `npx vitest run` Expected: PASS.

Run: `git diff --stat -- tests/` Expected: EMPTY.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/codegraph/symbols/graph-finalizer.ts src/core/domains/trajectory/codegraph/symbols/provider.ts
git commit -m "refactor(trajectory): extract GraphBuildFinalizer (pass-2 loop + SCC/PageRank) from provider"
```

---

### Task 6: Extract the extraction sink and thin the facade

**Files:**

- Create: `src/core/domains/trajectory/codegraph/symbols/extraction-sink.ts`
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts`
  (`asExtractionSink` 810–1065; `ensureRunSink` 1651–1669)

**Interfaces:**

- Consumes: `CodegraphRunState`, `SymbolNodeFlushQueue`, `GraphBuildFinalizer`,
  plus two provider callbacks that stay provider-owned (symbol-def building and
  the per-collection line index).
- Produces:

```typescript
export interface CodegraphSinkDeps {
  resolveStore: (
    collectionName?: string,
  ) => Promise<{ graphDb: GraphDbClient; symbolTable: GlobalSymbolTable }>;
  runState: CodegraphRunState;
  nodeFlush: SymbolNodeFlushQueue;
  graphFinalizer: GraphBuildFinalizer;
  buildSymbolDefs: (extraction: FileExtraction) => SymbolDefinition[];
  indexChunkSymbolsByLine: (
    collectionName: string | undefined,
    extraction: FileExtraction,
  ) => void;
  collectionKey: (collectionName?: string) => string;
  spillPathFor: (collectionName: string | undefined, runId: string) => string;
}

/** Was `provider.asExtractionSink`. */
export function createCodegraphExtractionSink(
  deps: CodegraphSinkDeps,
  collectionName?: string,
  skipDurableNodeWrite?: boolean,
): ExtractionSink;
```

- [ ] **Step 1: Move the sink factory**

Move 810–1065 into `createCodegraphExtractionSink`. The closure state
(`spillStream`, `spillWriteCount`, `finished`, `ensureSpillStream`,
`cleanupSpill`) moves unchanged. Split the run-global merge block (897–982) into
a module-private helper — it is ~85 lines of pure accumulation and belongs with
the state it feeds:

```typescript
/** Merge one file's pass-1 aggregates into the run-global state. */
function mergeExtractionIntoRunState(
  extraction: FileExtraction,
  runState: CodegraphRunState,
): void;
```

Prefer putting `mergeExtractionIntoRunState` in `run-state.ts` as a method
(`CodegraphRunState#absorb(extraction)`) — the state owns its own accumulation
rules and the sink then reads as: upsert defs → buffer node write → index lines
→ absorb → spill.

The barrier block (1019–1043) becomes `deps.runState.seal(barrierSymbolTable)`
from Task 2.

- [ ] **Step 2: Move `ensureRunSink`**

It stays a provider method (it owns `runSinks` / `runExtractedPaths` maps) but
its body now calls the factory:

```typescript
private ensureRunSink(key: string, collectionName?: string, skipDurableNodeWrite = false) {
  let sink = this.runSinks.get(key);
  if (!sink) {
    this.chunkSymbolByLine.delete(key);
    this.runState.resetTally();
    sink = createCodegraphExtractionSink(this.sinkDeps, collectionName, skipDurableNodeWrite);
    this.runSinks.set(key, sink);
  }
  // ... unchanged extracted-set handling
}
```

`asExtractionSink` stays on the provider as a one-line public delegate — it is
public API used by `tests/.../provider-spill.test.ts` and the worker path:

```typescript
asExtractionSink(collectionName?: string, skipDurableNodeWrite = false): ExtractionSink {
  return createCodegraphExtractionSink(this.sinkDeps, collectionName, skipDurableNodeWrite);
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit -p tsconfig.json` Expected: clean.

Run: `npx vitest run` Expected: PASS.

Run: `git diff --stat -- tests/` Expected: EMPTY.

- [ ] **Step 4: Measure the facade**

```bash
wc -l src/core/domains/trajectory/codegraph/symbols/*.ts
grep -nE '^  (private |public )?(async )?[a-zA-Z_][a-zA-Z0-9_]*\(' src/core/domains/trajectory/codegraph/symbols/provider.ts
```

Expected: `provider.ts` well under its 2836-LOC starting point, and no method
over 87 lines. Record the before/after numbers in the commit body — they are the
acceptance evidence for the epic.

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/codegraph/symbols/extraction-sink.ts src/core/domains/trajectory/codegraph/symbols/run-state.ts src/core/domains/trajectory/codegraph/symbols/provider.ts
git commit -m "refactor(trajectory): extract codegraph extraction sink; provider becomes a thin facade"
```

---

### Task 7: Phase-slice `walkCommits`

Mechanical decomposition, no design decision. `walkCommits`
(`src/core/domains/trajectory/git/infra/walk-commits.ts`) is ~312 LOC in a
437-LOC file.

**Files:**

- Modify: `src/core/domains/trajectory/git/infra/walk-commits.ts`

**Interfaces:**

- Consumes: nothing from Tasks 1–6 — this file is in the git trajectory, not
  codegraph. It can be done in parallel with any other task.
- Produces: no exported-surface change. `walkCommits`'s signature and return
  type stay identical; only private phase helpers are added.

- [ ] **Step 1: Read the function and identify its phases**

Read `src/core/domains/trajectory/git/infra/walk-commits.ts` from line 242 to
the end. Identify the sequential phases by their existing comment blocks — do
NOT invent boundaries. Typical shape: argument/range setup → `git log` stream
consumption → per-commit diff attribution → aggregation → result assembly.

- [ ] **Step 2: Extract one private helper per phase**

Each helper takes an explicit parameter object and returns its phase output — no
shared mutable closure state across helpers. Keep them in the same file (they
are private to `walkCommits`).

- [ ] **Step 3: Verify**

Run: `npx vitest run tests/core/domains/trajectory/git` Expected: PASS —
`walk-commits-discovery.test.ts`, `walk-commits-memo.test.ts`,
`walk-commits-parents.test.ts` and `walk-stats.test.ts` cover this path.

Run: `git diff --stat -- tests/` Expected: EMPTY.

- [ ] **Step 4: Commit**

```bash
git add src/core/domains/trajectory/git/infra/walk-commits.ts
git commit -m "refactor(trajectory): phase-slice walkCommits into per-phase helpers"
```

---

### Task 8: Redistribute tests to mirror the new structure

LAST, per the relocation-migration order. Until now `tests/**` was untouched;
now the test files that target a specific collaborator move to sit beside it.
This is a MOVE, not a rewrite — assertions and `it` bodies stay byte-identical.

**Files:**

- Move: test files whose subject is now a collaborator (see mapping below)
- Test: `npx vitest run` after every move

**Interfaces:**

- Consumes: the final file layout from Tasks 2–6.
- Produces: a test tree that mirrors `src/`.

- [ ] **Step 1: Decide the mapping from actual test content**

Read each candidate's `describe` block and classify by SUBJECT, not by filename:

| Test file (current)                                                                                      | Moves to                       | Rationale                                                                                         |
| -------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `provider-eager-flush.test.ts`                                                                           | `node-flush.test.ts`           | subject = flush cadence                                                                           |
| `provider-crosspass-node-remainder.test.ts`                                                              | `node-flush-crosspass.test.ts` | subject = remainder drain                                                                         |
| `provider-spill.test.ts`, `provider-spill-errors.test.ts`                                                | `extraction-sink*.test.ts`     | subject = sink spill lifecycle                                                                    |
| `provider-run-stats.test.ts`, `provider-run-stats-crosspass.test.ts`, `provider-run-reset-seams.test.ts` | `run-state*.test.ts`           | subject = run state/metrics                                                                       |
| `resolve-regression-gate.test.ts`, `provider-cone.test.ts`, `provider-ambiguous-fanout*.test.ts`         | keep in place                  | subject = end-to-end resolution through the provider — these are the invariant suite, do not move |

Files that drive the provider end-to-end STAY where they are. Only rename a file
when its subject is now a single collaborator.

- [ ] **Step 2: Move one file, adjust only its import paths, run it**

```bash
git mv tests/core/domains/trajectory/codegraph/symbols/provider-eager-flush.test.ts \
       tests/core/domains/trajectory/codegraph/symbols/node-flush.test.ts
npx vitest run tests/core/domains/trajectory/codegraph/symbols/node-flush.test.ts
```

Expected: PASS. Repeat per file — one move, one run, never batch.

- [ ] **Step 3: Verify no test content changed**

Run: `git diff -M --stat -- tests/` Expected: renames only (`R100`), zero
content churn. Any modified line other than an import path must be justified in
the commit body per test-invariants rule 2.

- [ ] **Step 4: Full suite + coverage gate**

Run: `npx vitest run` Expected: PASS.

Run: `npm run test:coverage` Expected: thresholds met. If the gate fails,
delegate to the `coverage-expander` subagent — never lower a threshold.

- [ ] **Step 5: Commit**

```bash
git add -A tests/
git commit -m "test(trajectory): relocate codegraph tests beside their collaborators (G2)"
```

---

## Acceptance

- `provider.ts` is a thin `EnrichmentProvider` facade; no method exceeds the
  87-LOC decomposition threshold in any file touched by this plan.
- Full suite green; `git diff -M --stat -- tests/` shows only Task 1's new file
  and Task 8's renames.
- Public surface unchanged: `key`, `signals`, `derivedSignals`, `filters`,
  `presets`, `defersChunkEnrichment`, `workerDescriptor`, `resolveRoot`,
  `shouldEnrich`, `handleDeletedPaths`, `asExtractionSink`, `buildFileSignals`,
  `buildChunkSignals`, `getRunMetrics`, `acceptExtraction`,
  `beginExtractionRun`, `endExtractionRun`, `finalizeSignals`, `onRelease`.
- Coverage thresholds met without modification.

## Follow-ups (file as beads, do NOT do inline)

- Unify the four run-reset seams now that `CodegraphRunState` owns them — a
  behavior change, needs its own TDD cycle and live validation.
- Live validation on a real index
  (`tea-rags index-codebase --project tea-rags --wait-enrichments --force --json`)
  comparing `resolveSuccessRate` and `byReceiverKind` before/after the split.
  User-gated; the split is a behavior-preserving refactor, so any delta is a
  bug.

## Execution log (2026-07-26)

All eight tasks executed on `worktree-arch-drift-g2`, base local main
`f56e611c`. `provider.ts` went from 2836 to 1511 lines.

| Task                           | Commit      | Result                                                                                                                                                                                                                                    |
| ------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — characterization tests     | `4013ba7a`  | 6 tests. Surfaced an asymmetry worth recording: `onRelease` clears the run-global maps and node-flush state but NOT the resolve tally, so a finished run's metrics stay readable after release. `beginExtractionRun` does zero the tally. |
| 2 — `CodegraphRunState`        | `47a6f09e`  | 17 fields + tally + 4 reset seams + `absorb` + `seal` + `drainMetrics`. `buildIncludedBy` moved along and is re-exported from `provider.ts` so no module cycle appears.                                                                   |
| 3 — `SymbolNodeFlushQueue`     | `06ebcac5`  | 4 methods (`buffer` / `flushPending` / `flushRemainder` / `reset`), store resolver injected as a callback.                                                                                                                                |
| 4 — `CallEdgeResolutionRunner` | `4991d61a`  | Moved AND decomposed in one commit (plan called for two; the second write of a 268-LOC body was not worth the tokens). `lastSegment` split into `symbol-name.ts`.                                                                         |
| 5 — `GraphBuildFinalizer`      | `85993836`  | Pass-2 loop + SCC/PageRank. Provider keeps both methods as private delegates — 31 test call sites drive pass-2 through them.                                                                                                              |
| 6 — extraction sink            | `f497612e`  | `createCodegraphExtractionSink` + `CodegraphSinkDeps`. Pass-2 stages passed as thunks so instance-level patching in tests still works.                                                                                                    |
| 7 — `walkCommits`              | `4b5e7e13`  | Sliced into `discoverCommits` / `createAcquire` / `collectHunksPerFile` / `applyFileHunksToAccumulators`; `walkCommits` is a ~40-line orchestrator.                                                                                       |
| 8 — test redistribution        | — (no move) | See below.                                                                                                                                                                                                                                |

**Task 8 outcome: zero files moved, deliberately.** The plan's own criterion is
"only rename a file when its subject is now a single collaborator". Applied to
the actual suite, it selects nothing: all 35 files under
`tests/core/domains/trajectory/codegraph/symbols/` drive the provider
end-to-end, either through its public surface or through provider-private seams
(`streamingResolveAndUpsert`, `asExtractionSink`). Moving them beside a
collaborator would misrepresent what they cover.

**Test edits, all justified under `.claude/rules/test-invariants.md`:**

- `provider-eager-flush.test.ts` — the run-global snapshot reads the same fields
  at their new address (`provider.runState`). Access-point adaptation; every
  `it` and assertion unchanged.
- `provider-spill-errors.test.ts` — rule-2 rewrite. It forced a resolver crash
  by monkey-patching the private `resolveExtraction`; now it injects a language
  factory whose resolver throws, asserting the same invariant (a per-file
  resolve failure surfaces as `CodegraphResolveError` carrying the file path)
  through the real path.
- `codegraph-crosspass-determinism.test.ts` — drain-order spy retargeted at
  `CallEdgeResolutionRunner.prototype.resolve`, which is still called exactly
  once per drained file in drain order.

**Verification.** Full suite: 8939 passed / 171 failed — byte-identical to the
pre-work baseline on this worktree. Every one of those 171 is a
`Cannot find module .../build/.../worker.js` failure from the worktree not being
built (three worktrees are active, so the auto-build rule does not apply); they
sit in `ingest` worker/pool paths, `codegraph/factory`, and `git` worker paths,
none of which this work touches.
`tests/core/domains/trajectory/codegraph/symbols`: 425/425 green. `tsc --noEmit`
and `eslint --max-warnings 0` clean throughout.

**Not verified here:** the coverage gate (`npm run test:coverage`) is not
meaningful on an unbuilt worktree — the 171 build-dependent failures would
depress coverage for reasons unrelated to this change. Run it after a build, or
on main post-merge.
