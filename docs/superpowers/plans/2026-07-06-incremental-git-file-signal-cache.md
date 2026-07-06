# Incremental git file-signal commit-cache + window eviction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `dinopowers:executing-plans`
> (wrapper over superpowers:executing-plans) — or
> `superpowers:subagent-driven-development` — to implement this plan
> task-by-task. TDD steps use `dinopowers:test-driven-development`. Steps use
> checkbox (`- [ ]`) syntax.

**Goal:** On incremental indexing, stop re-reading the full 12-month
`git log --numstat` window for file signals every HEAD-change; instead cache
per-commit numstat, delta-extend with only the new commits, evict commits that
aged out of the window, and re-aggregate `FileChurnData` in memory — with
byte-identical results to a full recompute.

**Architecture:** Mirror the existing chunk-path `GitCommitDiscovery` +
`commit-discovery-store` delta-merge pattern for the FILE path, in a new
`FileChurnDiscovery`. The chunk path's `GitCommitDiscoveryEntry` carries only
`changedFiles: string[]` (paths, no line counts), so it CANNOT be reused
directly for `FileChurnData` (which needs per-file `linesAdded`/`linesDeleted`).
A new adapter method returns per-commit per-file numstat; `FileChurnDiscovery`
delta-merges + evicts those entries and aggregates `FileChurnData`. The chunk
path is left untouched (unifying the two into one cache is a documented
follow-up, not this plan).

**Tech Stack:** TypeScript (ESM), git CLI (`git log --numstat`) via
`VcsGitAdapter`, Vitest.

## Global Constraints

- **Windowed-semantics equality (THE correctness invariant, business-logic).** A
  warm-cache incremental run MUST produce `FileChurnData` byte-identical to a
  cold full recompute over the same HEAD + window (same `commitCount`,
  `linesAdded`/`linesDeleted`, `commits[]` order, and every derived signal).
  Assert this directly. This test may be MOVED but never REWRITTEN.
- **Eviction correctness.** Cached commit entries with
  `commit.timestamp < sinceDate` (window lower bound =
  `now − logMaxAgeMonths*30d`) contribute ZERO to the aggregated
  `FileChurnData`.
- **Staleness → full recompute.** Fall back to today's full `readNumstatLog`
  path when: no cache; OR `prior.head` is not an ancestor of the current HEAD
  (history rewrite / force-push); OR the window (`logMaxAgeMonths`) changed
  beyond `SINCE_DRIFT_TOLERANCE_MS` (24h). Same triggers as
  `GitCommitDiscovery.resolveEntries`.
- **Chunk path untouched.** Do NOT modify `GitCommitDiscovery`,
  `GitCommitDiscoveryEntry`, `commit-discovery-store.ts`, `chunk-reader.ts`, or
  `walk-commits.ts`. `buildChunkChurnMap*` stays as-is.
- **Deep-silo aggregators unchanged.** `computeFileSignals` (metrics.ts),
  `assembleFileSignals` (metrics/file-assembler.ts) business logic is NOT
  rewritten — `FileChurnData` is their input and its shape/semantics are
  preserved. Their existing tests stay green.
- **`FileChurnData` shape is fixed:**
  `{ commits: CommitInfo[]; linesAdded: number; linesDeleted: number }`
  (`git-cli/parsers.ts:56`).
  `CommitInfo = { sha, author, authorEmail, timestamp, body, parents }`
  (`parsers.ts:38`).
- TDD mandatory (failing test first). Typed errors; no `eslint-disable`; no
  lowered coverage thresholds.
- **Worktree-only** (`worktree-vcs-adapter`): commit each Task on that branch.
  NEVER push, NEVER merge. `npm run build` / `npm link` / any reindex are
  USER-GATED — do NOT run them from plan execution (all live validation is
  deferred until after this fix).

---

## File Structure

- **Create** `src/core/adapters/vcs/git/git-cli/client.ts` — new export
  `readCommitFileNumstat(repoRoot, sinceDate?, range?, timeoutMs?)` returning
  per-commit per-file numstat (a parser that keeps line counts, unlike
  `parsePathspecOutput` which drops them). Add to the `VcsGitAdapter` abstract +
  `git-cli/adapter.ts` + `es-git/adapter.ts` (delegates to CLI, like the other
  history ops).
- **Create** `src/core/domains/trajectory/git/infra/file-churn-discovery.ts` —
  `FileChurnDiscovery` (mirrors `GitCommitDiscovery`): delta-merge + eviction +
  aggregate → `Map<string, FileChurnData>`. Its own persistence seam.
- **Create**
  `src/core/domains/trajectory/git/infra/file-churn-discovery-store.ts` —
  on-disk snapshot store (mirrors `commit-discovery-store.ts`), keyed
  `(repoRoot, head)`, holding per-commit numstat entries + `sinceIso`.
- **Modify** `src/core/domains/trajectory/git/infra/file-reader.ts` —
  `buildFileSignalMap` / `buildFileSignalDiscovery` route through
  `FileChurnDiscovery` when a store is available; full `readNumstatLog` stays as
  the cold-path fallback.
- **Modify** `src/core/domains/trajectory/git/provider.ts` — construct
  `FileChurnDiscovery` with its store (like the chunk `GitCommitDiscovery` in
  `makeCommitDiscovery`), thread into `getRunDiscovery` / `buildFileSignalMap`.
- **Modify** (Task 6 only, measure-gated) `provider.ts` `getRunDiscovery` — the
  `writeCommitGraph` warmup call.

Tests mirror under `tests/core/...`.

---

## Task 1: Adapter method — per-commit per-file numstat

The commit cache needs per-commit per-file line counts (to evict a commit's
contribution and re-aggregate). Existing `getCommitsSince`/`getCommitsInRange`
throw the counts away (`parsePathspecOutput` keeps only `changedFiles`). Add a
numstat-preserving reader.

**Files:**

- Modify: `src/core/adapters/vcs/git/git-cli/client.ts` (new
  `parseCommitFileNumstat` + `readCommitFileNumstat`, near `getCommitsSince`
  ~:415 / `NUMSTAT_LOG_FORMAT` ~:405)
- Modify: `src/core/adapters/vcs/git/adapter.ts` (abstract method, near
  `getCommitsInRange` ~:28)
- Modify: `src/core/adapters/vcs/git/git-cli/adapter.ts` (impl delegate, near
  ~:44)
- Modify: `src/core/adapters/vcs/git/es-git/adapter.ts` (delegate to
  `this.cliHistory`, near ~:92)
- Test: `tests/core/adapters/vcs/git/commit-file-numstat.test.ts` (new)

**Interfaces:**

- Produces:
  `type CommitFileNumstat = { commit: CommitInfo; files: { path: string; added: number; deleted: number }[] }`
  (export from `adapters/vcs/types.ts`).
  `readCommitFileNumstat(sinceDate?: Date, range?: { fromSha: string; toSha: string }, timeoutMs?: number): Promise<CommitFileNumstat[]>`
  — `range` present ⇒ `from..to`, absent ⇒ whole-repo `--since`. Binary numstat
  rows (`-`/`-`) count as 0 added/0 deleted (match `parseNumstatLog`).

- [ ] **Step 1: Write the failing test**

`commit-file-numstat.test.ts` — build a tiny real temp repo (2-3 commits
touching known files with known +/- line counts) via the harness in
`tests/core/adapters/vcs/git/*.test.ts` (temp dir + `git init` + commits).
Assert:

```ts
it("returns per-commit per-file numstat over a since window", async () => {
  const entries = await adapter.readCommitFileNumstat(sinceEpoch);
  // newest→oldest (git log order); each entry has the commit + its files' +/-
  expect(entries.map((e) => e.commit.sha)).toEqual([c2sha, c1sha]);
  const c2 = entries.find((e) => e.commit.sha === c2sha)!;
  expect(c2.files).toContainEqual({ path: "a.ts", added: 3, deleted: 1 });
});

it("range form returns only commits in from..to", async () => {
  const entries = await adapter.readCommitFileNumstat(sinceEpoch, {
    fromSha: c1sha,
    toSha: c2sha,
  });
  expect(entries.map((e) => e.commit.sha)).toEqual([c2sha]); // excludes c1 (the 'from')
});

it("binary files count as 0 added / 0 deleted", async () => {
  const entries = await adapter.readCommitFileNumstat(sinceEpoch);
  const bin = entries.flatMap((e) => e.files).find((f) => f.path === "img.png");
  expect(bin).toEqual({ path: "img.png", added: 0, deleted: 0 });
});
```

- [ ] **Step 2: Run — verify fail** —
      `npx vitest run tests/core/adapters/vcs/git/commit-file-numstat.test.ts` →
      FAIL (`readCommitFileNumstat` not a function).

- [ ] **Step 3: Implement** — in `git-cli/client.ts`, add
      `parseCommitFileNumstat(stdout)` (reuse the NUL-delimited
      `NUMSTAT_LOG_FORMAT` split already used by `parsePathspecOutput`; in the
      numstat loop, instead of pushing only the path to `changedFiles`, push
      `{ path, added: Number.isNaN(a)?0:a, deleted: Number.isNaN(d)?0:d }`), and
      `readCommitFileNumstat(repoRoot, sinceDate?, range?, timeoutMs?)` building
      args
      `["log", "--since=<iso>", ...(range?[`${from}..${to}`]:[]), NUMSTAT_LOG_FORMAT, "--numstat"]`
      → `execFileForPathspec` → parse. Wire the abstract + both adapters (es-git
      delegates to `this.cliHistory.readCommitFileNumstat(...)`, mirroring its
      `getCommitsSince` at :92).

- [ ] **Step 4: Run — verify pass.** Then
      `npx vitest run tests/core/adapters/vcs/git` (whole git-adapter suite) +
      `npx tsc --noEmit` → 0.

- [ ] **Step 5: Commit**

```bash
git add src/core/adapters/vcs/git tests/core/adapters/vcs/git/commit-file-numstat.test.ts
git commit -m "feat(adapters): add readCommitFileNumstat (per-commit per-file numstat reader)"
```

---

## Task 2: `FileChurnDiscovery` — delta-merge + eviction + aggregate

**Files:**

- Create: `src/core/domains/trajectory/git/infra/file-churn-discovery.ts`
- Create: `src/core/domains/trajectory/git/infra/file-churn-discovery-store.ts`
- Test: `tests/core/domains/trajectory/git/infra/file-churn-discovery.test.ts`

**Interfaces:**

- Consumes: `adapter.readCommitFileNumstat` (Task 1); `adapter.getHead`,
  `adapter.isAncestor`; `CommitFileNumstat`; `FileChurnData`.
- Produces: `class FileChurnDiscovery` with
  `constructor(adapter | Promise<adapter>, opts: { maxAgeMonths: number; timeoutMs: number; store?: FileChurnDiscoveryPersistence })`
  and `async fileChurn(): Promise<Map<string, FileChurnData>>` (whole-repo
  per-file aggregate over the window). Persistence seam
  `FileChurnDiscoveryPersistence` mirrors `GitCommitDiscoveryPersistence`
  (load/loadLatest/save of
  `{ version:1, repoRoot, head, sinceIso, entries: CommitFileNumstat[] }`).

- [ ] **Step 1: Write the failing tests** (the correctness core)

```ts
it("warm-cache incremental == cold full recompute (windowed equality)", async () => {
  // repo at HEAD c3, window W. Cold: no store.
  const cold = await new FileChurnDiscovery(adapter, {
    maxAgeMonths: 12,
    timeoutMs: 30000,
  }).fileChurn();
  // Warm: store already holds entries up to c2 (ancestor of c3); only c3 is fetched fresh + merged.
  const warm = await new FileChurnDiscovery(adapter, {
    maxAgeMonths: 12,
    timeoutMs: 30000,
    store,
  }).fileChurn();
  expect(warm).toEqual(cold); // same FileChurnData per file: commits[], linesAdded, linesDeleted
});

it("evicts commits older than the window lower bound", async () => {
  // store holds an entry whose commit.timestamp < now − window; it must NOT contribute
  const churn = await new FileChurnDiscovery(adapter, {
    maxAgeMonths: 1,
    timeoutMs: 30000,
    store,
  }).fileChurn();
  const f = churn.get("a.ts")!;
  expect(f.commits.map((c) => c.sha)).not.toContain(agedOutSha);
  expect(f.linesAdded).toBe(withinWindowAddedOnly);
});

it("staleness → full recompute: non-ancestor prior.head", async () => {
  // store's prior.head is NOT an ancestor of current head (rewrite)
  const spy = vi.spyOn(adapter, "readCommitFileNumstat");
  await new FileChurnDiscovery(adapter, {
    maxAgeMonths: 12,
    timeoutMs: 30000,
    store: rewrittenStore,
  }).fileChurn();
  // last call is a whole-repo (no range) full read, not a range top-up
  expect(spy.mock.calls.at(-1)?.[1]).toBeUndefined(); // range arg absent
});

it("staleness → full recompute: window (maxAgeMonths) changed beyond tolerance", async () => {
  /* prior.sinceIso off by > 24h → full */
});
it("no store ⇒ single full read", async () => {
  /* store undefined → one whole-repo read */
});
```

- [ ] **Step 2: Run — verify fail.**

- [ ] **Step 3: Implement** — mirror `GitCommitDiscovery.resolveEntries`
      (`commit-discovery.ts:145-192`) exactly for the resolve+merge+staleness
      logic, swapping `getCommitsSince`/`getCommitsInRange` for
      `readCommitFileNumstat(since)` /
      `readCommitFileNumstat(since, {fromSha,toSha})`, and reuse the same
      `SINCE_DRIFT_TOLERANCE_MS = 24h` + `withinTolerance` + `isAncestor` gates.
      THEN add two steps the chunk path lacks:
  1. **Evict:** after obtaining `entries`, drop those with
     `commit.timestamp < Math.floor(sinceDate.getTime()/1000)` (git timestamps
     are epoch seconds in `CommitInfo`).
  2. **Aggregate:** fold the (merged, evicted) `CommitFileNumstat[]` into
     `Map<string, FileChurnData>`: per file, `commits.push(entry.commit)` (in
     git-log newest→oldest order — mirror `parseNumstatLog`'s per-file commit
     order so `commits[]` matches the cold path), `linesAdded += f.added`,
     `linesDeleted += f.deleted`. `file-churn-discovery-store.ts` is a near-copy
     of `commit-discovery-store.ts` (different filename key so the two snapshots
     don't collide).

  > **Aggregation-order note:** the windowed-equality test is the guard. If
  > merged (fresh-then-prior) order or eviction changes `commits[]` order vs the
  > cold `readNumstatLog`, that test fails — fix the fold order until
  > warm==cold.

- [ ] **Step 4: Run — verify all 5 pass** + `npx tsc --noEmit` → 0.

- [ ] **Step 5: Commit** —
      `feat(trajectory): FileChurnDiscovery — incremental delta-merge + window eviction for file signals`

---

## Task 3: Route `file-reader.ts` through `FileChurnDiscovery`

**Files:**

- Modify: `src/core/domains/trajectory/git/infra/file-reader.ts`
  (`buildFileSignalMap` ~:19, `buildFileSignalDiscovery` ~:61)
- Test: extend `tests/core/domains/trajectory/git/infra/git-log-reader.test.ts`
  (or a new `file-reader-incremental.test.ts`)

**Interfaces:**

- Consumes: `FileChurnDiscovery` (Task 2).
- Produces: `buildFileSignalMap` / `buildFileSignalDiscovery` accept an optional
  `discovery?: FileChurnDiscovery`; when present they return
  `await discovery.fileChurn()` (optionally sliced by window for
  `buildFileSignalDiscovery`'s `maxAgeMonths` param); when absent they keep the
  current `readNumstatLog` path unchanged (backward-compatible default).

- [ ] **Step 1: Failing test** —
      `buildFileSignalMap(adapter, cache, 12, t, discovery)` returns the
      discovery's aggregate and does NOT call `adapter.readNumstatLog` when
      `discovery` is supplied (spy); without `discovery` it still calls
      `readNumstatLog` (unchanged).
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement** — thread the optional `discovery` param; branch to
      `discovery.fileChurn()` when set, else the existing `readNumstatLog` body.
      Keep `buildFileSignalsForPaths` (per-path backfill) unchanged.
- [ ] **Step 4: Run — pass** + `tsc` 0.
- [ ] **Step 5: Commit** —
      `feat(trajectory): file-reader consumes FileChurnDiscovery when available`

---

## Task 4: Wire into `GitEnrichmentProvider`

**Files:**

- Modify: `src/core/domains/trajectory/git/provider.ts` (`getRunDiscovery`
  ~:245, the `buildFileSignalMap`/`buildFileSignalDiscovery` call sites
  ~:237/:321, construction — mirror `makeCommitDiscovery` ~:377 which builds the
  chunk `GitCommitDiscovery` with `commit-discovery-store`)
- Test: extend the provider's incremental test
  (`tests/core/domains/trajectory/git/provider*.test.ts`)

**Interfaces:**

- Consumes: `FileChurnDiscovery`, `file-churn-discovery-store`.
- Produces: the provider builds ONE run-scoped `FileChurnDiscovery`
  (store-backed, `maxAgeMonths = logMaxAgeMonths`) and passes it into the
  file-signal reads; run-scoped discovery (`this.fileDiscovery`) + per-batch
  slicing (`sliceFileSignalsByPaths`) still hold (the aggregate map is the same
  shape).

- [ ] **Step 1: Failing test** — a provider incremental run at HEAD c(n+1) with
      a warm file-churn store from c(n) produces the same file signals as a cold
      run, and issues only a `from..to` range read (spy on
      `readCommitFileNumstat`), not a whole-repo read.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement** — construct `FileChurnDiscovery` alongside the
      existing chunk `GitCommitDiscovery`; pass it to the file-signal reads; add
      the store path next to the chunk store. Preserve `getRunDiscovery`'s
      `writeCommitGraph` warmup call as-is (Task 6 handles it).
- [ ] **Step 4: Run — pass** + full `tests/core/domains/trajectory/git` suite +
      `tsc` 0.
- [ ] **Step 5: Commit** —
      `feat(trajectory): wire FileChurnDiscovery into GitEnrichmentProvider file signals`

---

## Task 5: Optional window eviction for the chunk path (documented decision)

The chunk-path `GitCommitDiscovery` merge (`commit-discovery.ts:172`) also only
APPENDS — aged-out commits never fall out of its persisted matrix until the 24h
tolerance forces a rebuild. This is the same drift the file path now fixes.

- [ ] **Step 1: Decide + document (no code unless chosen).** Adding eviction to
      `GitCommitDiscovery` touches the deep-silo delta engine (artk0de 100%) +
      the chunk hub consumers. Per YAGNI + blast-radius: **default = do NOT
      change the chunk path in this plan.** Record in the plan's follow-ups that
      chunk-path eviction (and unifying file+chunk into one numstat cache to
      drop the duplicate whole-repo log) is a separate, measured follow-up. If —
      and only if — the user explicitly asks to include it, add an eviction step
      mirroring Task 2 with the chunk windowed-equality test as guard. No commit
      if not chosen.

---

## Task 6: Warmup gate — MEASURE-FIRST (possibly YAGNI, no-op allowed)

**Files:** `src/core/domains/trajectory/git/provider.ts` (the `writeCommitGraph`
call in `getRunDiscovery`) — ONLY if measurement justifies it.

- [ ] **Step 1: Measure.** `git commit-graph write --reachable --changed-paths`
      is itself incremental (append-only). Under `DEBUG=1`, on an INCREMENTAL
      run (few new commits), record the warmup wall time. (User-gated live run —
      do NOT trigger it from plan execution; this step's output is a measurement
      the user provides or a follow-up captures.)
- [ ] **Step 2: Decide by the number.** If incremental warmup is effectively
      ~0ms → **do NOT add a gate (YAGNI); document the no-op decision and STOP
      this task.** If it is non-trivial → add a `crossPass`-only guard (skip the
      fire-and-forget `writeCommitGraph` when the run is incremental) with a
      test asserting `writeCommitGraph` is not called on the incremental path.
- [ ] **Step 3 (only if gated): Commit** —
      `perf(git): skip commit-graph warmup on incremental runs`

---

## Self-Review

- **Spec coverage:** delta-merge for file path (Tasks 1-4) ✓; window eviction
  (Task 2 evict step + test) ✓; re-aggregate not re-walk (Task 2 aggregate) ✓;
  staleness triggers (Task 2 tests) ✓; windowed-equality invariant (Task 2 + 4
  tests) ✓; chunk path untouched (Task 5 default no-op) ✓; warmup measure-first
  (Task 6) ✓.
- **Investigation resolved:** `GitCommitDiscoveryEntry` has no per-file numstat
  → separate `FileChurnDiscovery` + new `readCommitFileNumstat` (documented in
  Architecture); reuse rejected to keep the chunk hub untouched.
- **Type consistency:**
  `CommitFileNumstat = {commit: CommitInfo, files: {path,added,deleted}[]}` used
  identically in Task 1 (adapter) and Task 2 (discovery).
  `FileChurnData = {commits, linesAdded, linesDeleted}` is the aggregate output
  everywhere.
- **Out of scope:** chunk-path eviction; file+chunk cache unification (drop the
  duplicate whole-repo `git log --numstat`); both are documented follow-ups.
