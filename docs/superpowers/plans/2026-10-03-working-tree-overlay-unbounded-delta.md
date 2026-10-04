# WorkingTreeOverlay unbounded delta — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `dinopowers:executing-plans`
> to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Any working-tree delta answers from the tree. No file-count cap. The
cost of a request is bounded by its wait budget, not by the size of the delta.

**Architecture:** The 200-file cap and its over-cap `degraded` go away. Only
AST-chunked files are re-read. Delta chunking becomes a per-process warm queue:
a view waits at most `WORKING_TREE_WARM_WAIT_MS` and serves the files that are
ready; the rest come from the index marked `treeState: "modified"`. Every
per-request O(delta) recomputation is persisted or memoized. In the long-lived
server, an fs watcher keeps addressed trees warm.

**Spec:**
`docs/superpowers/specs/2026-10-03-working-tree-overlay-unbounded-delta-design.md`.

**One deliberate deviation from the spec.** The spec defines a "warm" file as
one with rows, sparse vectors and dense vectors all ready. The plan defines warm
as **rows ready** (chunked). Dense keeps its existing per-row pending reader
(`denseUnavailable`), but it now persists per batch. Why:
`WorkingTreeView#touchedPaths` is a synchronous set read by about 10 consumers
(strategies, `substitute.ts`, `trace-path-ops.ts`, `test-setup-hydration.ts`).
Gating it on dense as well would make a file's base rows reappear in find_symbol
whenever the embedder is slow, even though its tree rows are already in hand.

**Tech stack:** TypeScript, vitest, `fs.watch` (recursive), the existing
`ChunkerPool` / `WorkingTreeChunkStore` / `WorkingTreeDenseVectorSource`.

## Impact enrichment (tea-rags, blastRadius)

| File                                                         | Owner          | Commits | Signal                                     |
| ------------------------------------------------------------ | -------------- | ------- | ------------------------------------------ |
| `src/bootstrap/factory.ts`                                   | artk0de (72%)  | 133     | hub: fanIn 9, fanOut 55 — wiring only      |
| `src/core/domains/explore/working-tree/overlay.ts`           | artk0de (100%) | 7       | bugFixRate 57% (concerning), WTO-5         |
| `src/core/domains/explore/working-tree/tree-graph-marker.ts` | artk0de        | 5       | hub: fanIn 7 — touched only if marker text |
| `src/core/domains/explore/working-tree/dense-floor.ts`       | artk0de        | 1       | fanIn 5                                    |
| `src/core/domains/explore/working-tree/chunk-store.ts`       | artk0de        | 5       | sweep churn                                |
| `src/core/domains/explore/working-tree/delta.ts`             | artk0de        | 3       | bugFixRate 67%                             |
| `src/core/domains/explore/working-tree/chunk-layer.ts`       | artk0de        | 3       | —                                          |
| `src/core/domains/explore/working-tree/sparse-floor.ts`      | artk0de        | 3       | fanIn 5                                    |
| `src/core/domains/ingest/pipeline/base.ts`                   | artk0de (58%)  | 56      | fanOut 16                                  |
| `src/core/contracts/types/{working-tree,registry}.ts`        | artk0de        | 7 / 16  | contracts                                  |

Coordinated change: WTO-5 links overlay, chunk-layer, chunk-store, dense-floor
and contracts. Tasks that touch `overlay.ts` (1, 2, 5) run in sequence. Proven
templates: locality `none`. The whole working-tree area is 0 days old, and the
only L3 analogue, `BatchAccumulator#scheduleFlush`, is high-churn.

## Execution waves

| Wave | Tasks (parallel inside a wave) | Files that must not collide                                                                                   |
| ---- | ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| A    | 1+2 (one agent), 3, 4          | 1+2: overlay/delta/contracts/base/factory · 3: dense-floor · 4: sparse-floor/chunk-store/chunk-layer row read |
| B    | 5                              | overlay, chunk-layer, new `warmer.ts`, factory                                                                |
| C    | 6                              | new `watcher.ts`, overlay `prewarm`, factory, server/call wiring                                              |
| D    | 7 (plugin), 8 (live, parent)   | `.claude-plugin/tea-rags/**`                                                                                  |

Each agent works in its own `isolation: "worktree"` branch off this branch. The
parent merges every wave and checks `tsc`, the targeted suites and `eslint`
before starting the next. `npm run test:coverage` runs once, on main, after the
final merge.

---

### Task 1: Remove the count cap

**Files:**

- Modify: `src/core/contracts/types/working-tree.ts` — delete
  `WORKING_TREE_DELTA_FILE_CAP`
- Modify: `src/core/contracts/types/registry.ts` — `indexedDirtyPathsOverflowed`
  doc: legacy, read-only
- Modify: `src/core/domains/explore/working-tree/delta.ts` — always run
  `readRenamePairs` when something was deleted; drop the re-export
- Modify: `src/core/domains/explore/working-tree/overlay.ts` — delete the
  over-cap branch, the `measured` arg of `degraded`, and
  `WORKING_TREE_WORKTREE_INDEX_REMEDY` (with every other user — grep first);
  `dirtyAtIndexTime` legacy reason:
  `"index built from a dirty tree whose dirty files were not listed"`
- Modify: `src/core/domains/explore/working-tree/index.ts`,
  `src/core/domains/explore/index.ts` — barrels
- Modify: `src/core/domains/ingest/pipeline/base.ts` —
  `BaseIndexingPipeline#buildRegistryGitState` stores the full sorted list and
  never sets the overflow flag
- Modify: `src/core/domains/explore/working-tree/chunk-layer.ts` — comment on
  `CONTENT_CACHE_MAX_FILES` only (Task 5 replaces the constant)
- Test: `tests/core/domains/explore/working-tree/{overlay,delta}.test.ts`, the
  ingest test that pins `buildRegistryGitState` (find with
  `hybrid_search "indexedDirtyPaths" testFile:only`)

- [ ] Write the failing tests: a 250-file delta yields a measured view
      (`changedFiles: 250`, no `degraded`, `touchedPaths.size === 250`);
      `measureDelta` returns rename pairs for a 250-file delta with deletions;
      ingest stores a 250-path `indexedDirtyPaths` with no overflow flag; a
      legacy entry with `indexedDirtyPathsOverflowed: true` still degrades with
      the reindex remedy.
- [ ] Run the tests and confirm they fail for the stated reason (cap degraded or
      overflow written).
- [ ] Rewrite the existing tests that pin the cap so they assert the new
      invariant. Name each one in the commit body (invariant change).
- [ ] Implement; `npx tsc --noEmit`, the targeted suites, `npx eslint` on the
      touched files.
- [ ] Commit: `feat(explore)!: remove the working-tree delta file cap` with a
      body that names the invariant change. Not breaking for users: the cap was
      never configurable. Drop the `!` unless a public DTO changed.

### Task 2: Delta admission — AST-chunked languages only

**Files:**

- Modify: `src/core/contracts/types/working-tree.ts` —
  `WorkingTreeMarker.indexOnlyFiles?: number` (doc: changed files the overlay
  does not re-read; their rows are the index's, `treeState: "modified"`)
- Modify: `src/core/api/public/dto/working-tree.ts` if the marker DTO is
  separate (check), and the MCP formatter that renders the marker (grep
  `denseUnavailable` under `src/mcp`)
- Modify: `overlay.ts`:
  - `WorkingTreeOverlayDeps.admitsToDelta?: (relativePath: string) => boolean`.
    Absent → every file is admitted (test default).
  - After `foldDirtyAtIndexTime`: `reread = changed.filter(admits)`,
    `indexOnly = changed − reread`.
  - `touchedPaths = reread ∪ deleted`. Add the view field
    `indexServedPaths: ReadonlySet<string>` (= `indexOnly` here; Task 5 adds
    pending files to it).
  - `marker.changedFiles` stays `changed.length`, the true distance.
    `marker.indexOnlyFiles` is set when > 0.
  - Tree graph, chunk read and dense warm get `reread` only.
- Modify: `src/core/domains/explore/working-tree/substitute.ts` —
  `workingTreeStateOf` returns `"modified"` for a path in
  `view.indexServedPaths`
- Modify: `src/bootstrap/factory.ts` — `admitsToDelta` = `detectLanguage(path)`
  (ingest `chunker/utils/language-detector.ts`) →
  `LanguageFactory#capabilities()` (or `nativeLanguageCapabilities`) entry with
  `ast.tier === "full"`. Read the capability map once at construction. Put the
  builder in a small exported function (e.g. `createWorkingTreeDeltaAdmission`).
  Before naming it, check the name with `get_naming_lexicon`.
- Test: overlay tests (split, counts, `treeState` on index-only rows via
  `workingTreeStateOf`, deleted index-only files stay in `deletedPaths`); an
  admission-predicate test: `.ts .tsx .js .py .go .rb .swift .md .sh` → true;
  `.json .jsonc .yaml .yml .sql .toml .xml` and unknown extensions → false.

- [ ] Write the failing tests and run them red.
- [ ] Implement; `tsc`, targeted suites, `eslint`.
- [ ] Commit:
      `feat(explore): re-read only AST-chunked files in the working-tree delta`.

Corner cases the tests must pin:

- a renamed `.json` → its old path is deleted (rows hidden), its new path is
  index-only and has no rows;
- a changed file that is dirty-at-index-time and non-AST stays index-only;
- `changed` empty but `indexOnly` non-empty → no chunk read, no dense warm, no
  tree graph.

### Task 3: Dense vectors persist per batch, not at the end

**Files:**

- Modify: `src/core/domains/explore/working-tree/dense-floor.ts`
- Test: `tests/core/domains/explore/working-tree/dense-floor.test.ts`

Today `WorkingTreeDenseVectorSource#persist` runs once, in `finally`, after
every row has resolved. A one-shot process exits at the 2 s wait, so nothing is
saved, and every call re-retrieves base vectors with `content` (~1.2 s at 674
files) and re-embeds.

- [ ] Write the failing tests:
  - vectors reused from base points are `putVectors`-ed even when the embed call
    never settles;
  - with `batchSize: 2` over three files, where the second embed batch hangs, a
    file whose rows were all in the first batch is persisted before the hang
    resolves;
  - a second `warm` on a fresh source (new memory, same store) does no
    `retrieveDenseVectors` and no `embedBatch` for rows already stored.
- [ ] Implement:
  - persist after the store and base-reuse stage;
  - persist after each embed batch, for every file that gained vectors (merging
    with what the store already had for that file — read `chunk-store.ts`
    `putVectors` semantics first);
  - order the embed list by file, so files complete one at a time;
  - no persistence in `finally`.
- [ ] `tsc`, the dense-floor and overlay suites, `eslint`.
- [ ] Commit: `perf(explore): persist working-tree dense vectors per batch`.

### Task 4: Sparse vectors computed once per content

**Files:**

- Read first: `sparse-floor.ts` (`rowSparseVectors`), `chunk-store.ts` entry
  format, `chunk-layer.ts`
- Modify: whichever of those holds the per-row sparse memo
- Test: `tests/core/domains/explore/working-tree/sparse-floor.test.ts` (+
  chunk-store test if the entry changes)

Goal: no `generateSparseVector` call in a new process for rows the chunk store
already holds. A process-wide memo keyed by content sha256 covers the long-lived
server. Persisting the vectors beside the rows in the store entry covers the
one-shot CLI.

- [ ] Write the failing test: two independent sparse-floor scorings, through two
      fresh layer and store instances that share a store directory, over the
      same stored rows → `generateSparseVector` is spied, and the second scoring
      makes zero calls.
- [ ] Implement:
  - stored sparse vectors are optional in the entry (an older entry without them
    is computed, not a miss);
  - bump the row format only if the stored shape of `rows` changes — it should
    not.
- [ ] `tsc`, targeted suites, `eslint`.
- [ ] Commit:
      `perf(explore): store working-tree sparse vectors with their rows`.

### Task 5: Progressive warm — the view waits at most its budget

**Files:**

- Create: `src/core/domains/explore/working-tree/warmer.ts` —
  `WorkingTreeDeltaWarmer` (check the name with `get_naming_lexicon`; spec name
  `WorkingTreeWarmer`)
- Modify: `chunk-layer.ts` — chunk files concurrently, up to `deps.concurrency`
  (default = the pool size the factory configures), keeping request order in the
  result; bound the memory cache by bytes of row content (default 64 MB), oldest
  evicted first
- Modify: `overlay.ts`:
  - `WorkingTreeOverlayDeps.warmer?` (absent → today's behaviour: chunk
    everything, unbounded wait — keeps the existing tests valid);
  - `WORKING_TREE_WARM_WAIT_MS = 2_000` in `contracts/types/working-tree.ts`;
  - `view` awaits `warmer.warm(…, budget, "live")` before it builds
    `touchedPaths`;
  - `marker.pendingFiles?: number`.
- Modify: `factory.ts` wiring; marker DTO and formatter; `tree-graph-marker.ts`
  only if marker text changes
- Test: new `warmer.test.ts`, plus overlay tests

Warmer contract:

```ts
interface WorkingTreeDeltaWarmRequest {
  tree: WorkingTree;
  collectionName: string;
  config: ChunkerConfig;
  paths: readonly string[]; // the view's re-read files
}
interface WorkingTreeDeltaWarmState {
  rows: readonly ScrollChunk[]; // rows of every warm file, in path order
  warmPaths: ReadonlySet<string>; // chunked OR unparsed
  unparsed: readonly string[];
  pending: readonly string[]; // re-read files not yet warm
  storeKeys: ReadonlyMap<string, WorkingTreeChunkStoreKey>;
}
warm(request, budgetMs: number, lane: "live" | "background"): Promise<WorkingTreeDeltaWarmState>;
```

- One queue per process, two lanes. Live work is always taken before background
  work. Batches hold 32 files. A path already queued or in flight is joined,
  never enqueued twice. Key = tree root + collection + chunker config + path +
  content sha (the layer already content-addresses).
- Each finished batch goes to the chunk store (the layer already `put`s per
  file). A process killed mid-warm keeps every finished file.
- `warm` resolves when every requested path is warm or the budget lapses,
  whichever comes first. The budget timer is `unref`'d.
- View semantics:
  - `touchedPaths = warm ∪ deleted`;
  - `indexServedPaths = indexOnly ∪ pending`;
  - `readDeltaChunks` resolves to `state.rows` immediately;
  - dense warms over `state.rows` with `state.storeKeys`;
  - tree graph over all `reread`.
- Never throws: a warmer failure leaves every reread path pending, marks the
  answer with `pendingFiles`, and serves index rows.

- [ ] Write the failing tests:
  - budget lapse returns partial state with pending paths;
  - live work jumps ahead of queued background work;
  - two concurrent `warm`s over overlapping paths chunk each path once;
  - a second warmer (fresh process) over the same store chunks nothing
    (`chunkFile` spy) and returns every path warm well inside the budget;
  - the overlay serves a pending file's base row with `treeState: "modified"`
    and excludes a warm file's base rows;
  - `pendingFiles` falls to absent once warm;
  - the byte bound evicts by size;
  - concurrency: N files on a fake pool with K slots never exceed K in flight.
- [ ] Implement; `tsc`, the working-tree and strategies suites, `eslint`.
- [ ] Commit:
      `feat(explore): warm the working-tree delta progressively within a wait budget`.

### Task 6: Watcher in the long-lived server

**Files:**

- Create: `src/core/domains/explore/working-tree/watcher.ts` —
  `WorkingTreeWatcher`
- Modify: `overlay.ts` — `WorkingTreeOverlay#prewarm(tree)`: measure the delta,
  admit, enqueue reread paths on the background lane, and start the tree-graph
  warm. Returns nothing; never throws. `view` calls `watcher.watch(tree)` when
  the reread set is non-empty and `tree.root` is not the base index's own
  checkout.
- Modify: `factory.ts` / the server bootstrap — the watcher is built only for
  `tea-rags server`. Find how `call` already differs from the server (its
  epilog: "search tools never trigger a background auto-update") and reuse that
  switch; `call` gets no watcher.
- Modify: app dispose path — `watcher.close()`
- Test: `watcher.test.ts` (fake `fs.watch` injected, fake timers)

Contract:

- `watch(tree)` is idempotent per root. It ignores events under `.git` and paths
  the ingest filter rejects.
- Debounce: 2 s after the last event, call `prewarm(tree)`.
- Stop conditions:
  - the root is gone (event on the root or `ENOENT` on stat);
  - 30 min without a `view` of that tree (each `view` touches it);
  - `close()`.
- A watcher error (`EMFILE`, `ENOSPC`) stops that tree's watcher and is logged
  at debug. Requests still warm on demand.
- Never writes Qdrant. A test asserts this with a Qdrant fake that throws on any
  write method.

- [ ] Write the failing tests: debounce coalesces a burst into one `prewarm`;
      `.git` events are ignored; idle stop after 30 min; root removed → stop;
      double `watch` → one fs watcher; `close` stops everything; `call`-mode app
      context builds no watcher.
- [ ] Implement; `tsc`, suites, `eslint`.
- [ ] Commit: `feat(explore): keep watched working trees warm in the server`.

### Task 7: Plugin guidance

**Files:**

- Modify: `.claude-plugin/tea-rags/rules/index-freshness.md` — remove "Worktree
  clone — only when the overlay degrades" and the over-cap mention in the
  linked-worktree row
- Modify: `.claude-plugin/tea-rags/rules/search-cascade.md` — drop "Clone mode";
  in "Read the `workingTree` marker", add `pendingFiles` (files not yet warm:
  their rows come from the index with `treeState`; a later call reads more of
  the tree) and `indexOnlyFiles` (non-code files changed in the tree; their rows
  are the index's)
- Modify: the subagent injection block (`references/subagent-injection.md`) —
  one line per field
- Modify: plugin version (minor bump) per `.claude/rules/` plugin versioning;
  run the plugin eval for the changed rules
- Modify: `docs/superpowers/specs/2026-10-02-working-tree-overlay-design.md` —
  the "Cap" paragraph points to the new spec

- [ ] Edit, bump, run the eval, commit `docs(plugin): …` (scope per
      commit-rules).

### Task 8: Live validation and defect probing (parent session)

Build: `npm run build` in the integration worktree (no link). Calls go through
`node build/cli/index.js call` with `project: "tea-rags"` plus `path`.

Measured (record the load average beside each timing):

1. Far tree `t674`, cold store (empty the overlay store namespace for that tree
   first, or use a fresh content state). The probe set is find_symbol by symbol,
   find_symbol by `relativePath`, hybrid_search, semantic_search and
   get_callers:
   - every call returns within budget + boot;
   - `pendingFiles` falls call over call;
   - converged → absent.
2. Far tree, warm: compare per-call wall time against the same probe on a clean
   tree. Target overhead ≤ 300 ms in one-shot `call`.
3. Near tree (≤ 20 files): no regression against pre-change timings. Measure a
   baseline on the pre-change build first.
4. Server mode, via an in-process MCP session script or `tea-rags server` over
   stdio: edit a file in the watched tree → after debounce plus one batch,
   `find_symbol` on it shows the edit with no `pendingFiles`.

Defect and corner-case probes (each one a call plus an assertion of the marker
and rows):

- json/yaml-only change → `indexOnlyFiles`, rows carry `treeState: "modified"`,
  no chunk work;
- a renamed `.ts` file, and a renamed `.json`;
- a deleted directory of 300 files → all hidden, no rename-pair blow-up;
- an untracked new file of 0 bytes, a binary-ish file with a code extension, a
  file that fails to parse → `unparsed`, never pending forever;
- the same file edited twice between calls → new content warmed, old content
  never served;
- a file pending at the budget, then edited → the next call serves the new
  content;
- embedder down (wrong `EMBEDDING_URL` for the call only) → chunks and sparse
  floors present, `denseUnavailable`, no hang past budget;
- a tree outside the repository, a tree at a subdirectory of the git toplevel;
- the alias's own checkout → no watcher;
- two trees over one index at once (two worktrees) → no cross-tree row leakage;
- a delta of more than 2,000 files (git worktree at an older commit) → bounded
  per-call time, steady convergence, memory stays bounded (watch RSS).

Every defect found gets fixed in this branch, TDD, before merge. Defects that
can only be checked with a reindex get a bead.
