# Enrichment Worker-Affinity & Status-Reporting Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> dinopowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. When a Task's TDD cycle starts, invoke
> `dinopowers:test-driven-development`; before claiming done,
> `dinopowers:verification-before-completion`.

**Goal:** Restore fast git chunk enrichment on deep-history repos (lost when git
moved to the stateless worker pool) and fix the status/metric reporting bugs
surfaced by a monitored taxdome `force_reindex`.

**Architecture:** Git enrichment is stateful (the chunk phase reuses
`blameByRelPath` / `lastFileResult` / `enrichmentCache` populated by the file
phase on the SAME provider instance). The worker pool dispatches git
`"stateless"`, scattering file- and chunk-batches across 4 worker threads so the
chunk batch runs on an instance with empty blame → redundant
`git blame`/`git log` per batch. Pinning git per-collection
(`"collection-affinity"`, same as codegraph) restores the origin/main in-process
behavior. The remaining tasks fix read-time status derivation (false-stall,
durations, matchedFiles, dead overlap metrics) that the same monitored run
exposed.

**Tech Stack:** TypeScript (ESM), Node `worker_threads` ThreadPool, vitest,
Qdrant payload markers, git CLI (`git blame --porcelain`, `git log --numstat`,
`git cat-file --batch`).

**Beads:** ONE epic, Tasks 1:1 with beads tasks (see `plan-beads-sync.md`).
Follow-up `tea-rags-mcp-pd2u` (fire-and-forget tail dies on stdio disconnect) is
OUT of scope — start after this plan is verified.

**Background evidence (2026-06-03/04 session):** origin/main `2d2a3dec` (1.28.0)
ran git chunk enrichment IN-PROCESS (no `worker.ts`) and was fast; main is ~194
commits ahead and routes git through `WorkerPoolEnrichmentExecutor`. Monitored
taxdome (117k chunks, 24595 files): git.chunk ~700–1000 s @ ~225 chunks/s;
commons-lang (12k, shallow history) 6.7 s @ 1895 chunks/s on the SAME code —
confirming the slowdown is per-batch blame/log recompute amplified by deep
history, not repo size alone. Server RSS stayed bounded (server ≤2 GB, qdrant
2.4 GB, duckdb peak 1.9 GB) — not OOM. The first run's mid-enrichment death had
no crash/jetsam signature → tracked separately as `tea-rags-mcp-pd2u`.

---

## File Structure

| File                                                                             | Responsibility                                                                     | Tasks     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------- |
| `src/bootstrap/factory.ts`                                                       | builds `gitWorkerDescriptor` (dispatch mode) — **deep-silo, `Why:` line required** | 1         |
| `src/core/domains/trajectory/git/factory.ts`                                     | git provider worker factory + the stale "no cross-call state" comment              | 1         |
| `src/core/domains/ingest/pipeline/enrichment/executor/worker-pool.ts`            | `routingKeyFor` + dispatch                                                         | 1 (tests) |
| `src/core/domains/ingest/pipeline/enrichment/marker-store.ts` / `coordinator.ts` | writes the `_run` pointer incl. `lastProgressAt`                                   | 2         |
| `src/core/domains/ingest/pipeline/enrichment/health-mapper.ts`                   | read-time status derivation (stall/duration/matchedFiles surfacing)                | 2, 3, 4   |
| `src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts`                     | `chunkEnrichmentDurationMs` accumulation                                           | 3         |
| `src/core/domains/ingest/pipeline/enrichment/applier.ts`                         | `matchedFiles` counter                                                             | 4         |
| `src/core/domains/ingest/pipeline/enrichment/completion-runner.ts`               | builds ALL_COMPLETE metrics (duration, overlap, gitLogFileCount)                   | 3, 6      |
| `.claude/skills/debug-pipeline-log/SKILL.md`                                     | Rule 7 overlap interpretation                                                      | 6         |

> Line numbers below are anchors as of main `fe381ea7`; re-confirm before
> editing.

---

## Task 1: Run git enrichment INLINE (in-process) — supersedes the affinity attempt

> **OUTCOME (live-verified 2026-06-04):** The collection-affinity attempt below
> was REVERTED — a monitored taxdome reindex proved affinity made git chunk
> enrichment ~4x SLOWER (pins git to 1 worker, removing parallelism; per-batch
> cost is `walkCommits`-dominated, not blame, so blame-reuse gave no speedup).
> Correct fix: give git **no `workerDescriptor`** so it dispatches via
> `InlineEnrichmentExecutor` (in-process, single instance, no postMessage
> overhead) — origin/main's model. Live result: streaming overlap restored
> (19567 files vs 9613 under affinity), no false-stall, no regression. Commits:
> a8d2ec49..dd669559 (affinity, superseded) → 42a53a5d (inline revert). NOTE:
> inline does NOT fully restore origin/main's perceived speed — the residual git
> chunk cost (~964s on taxdome) is the intentional iso-git →
> `git cat-file --batch` memory-safety migration (commit 288268a7, fixes the
> 16-40GB OOM). Further speedup tracked in follow-up epic tea-rags-mcp-txmw
> (bulk cat-file walk for post-flush). The affinity-attempt subsections below
> are kept for history.

### (superseded) Pin git enrichment per-collection (collection-affinity)

**Files:**

- Modify: `src/bootstrap/factory.ts` (gitWorkerDescriptor `dispatch`, ~line 199)
- Modify: `src/core/domains/trajectory/git/factory.ts` (correct comment,
  ~line 10)
- Test:
  `tests/core/domains/ingest/pipeline/enrichment/executor/worker-pool.test.ts`

- [ ] **Step 1: Failing routing unit test** — assert
      `routingKeyFor(descriptor, collectionName)` (`worker-pool.ts:53`) returns
      the collection for a `"collection-affinity"` git descriptor. Export the
      helper if needed.

```ts
it("git collection-affinity descriptor routes by collection", () => {
  const git = {
    providerModulePath: "x",
    providerFactoryExport: "createGitEnrichmentProvider",
    dispatch: "collection-affinity" as const,
  };
  expect(routingKeyFor(git, "code_27622aef")).toBe("code_27622aef");
});
```

- [ ] **Step 2: Run — expect FAIL.**
      `npx vitest run tests/core/domains/ingest/pipeline/enrichment/executor/worker-pool.test.ts`
- [ ] **Step 3: Failing behavioral test** — drive `runFileBatch` then
      `runChunkBatch` for the SAME collection through the executor with a mock
      provider whose `buildFileSignals` writes instance state and
      `buildChunkSignals` reads it; assert the chunk call observes the file
      call's state under `"collection-affinity"` (same cached instance). Use the
      existing harness in this test file as the pattern.
- [ ] **Step 4: Run — expect FAIL.**
- [ ] **Step 5: GREEN — flip dispatch** in `src/bootstrap/factory.ts`:
      `dispatch: "stateless"` → `dispatch: "collection-affinity"`.
- [ ] **Step 6: Correct the stale comment** in `git/factory.ts` (~line 10): git
      is **stateful** — `buildChunkSignals` reuses
      `blameByRelPath`/`lastFileResult`/`enrichmentCache` from
      `buildFileSignals` on the same instance, so it pins per-collection
      (`collection-affinity`).
- [ ] **Step 7: Run regression**
      `npx vitest run tests/core/domains/ingest/pipeline/enrichment/` — PASS,
      incl. affinity/drain/release (wy5i/icfj/6fe34902).
- [ ] **Step 8: Sanity** — 2 pins (git+codegraph) ≤ `enrichmentPoolSize` default
      4; no saturation/deadlock (`thread-pool.test.ts`).
- [ ] **Step 9: Commit** (deep-silo `factory.ts` → `Why:` line)

```
fix(ingest): pin git enrichment per-collection to restore blame/churn reuse

Why: git is stateful — buildChunkSignals reuses blameByRelPath/lastFileResult/
enrichmentCache from buildFileSignals on the same instance. Stateless dispatch
scattered file/chunk batches across 4 workers, so chunk ran on an empty-blame
instance and recomputed git blame/log per batch — ~10x slower on deep-history
repos. collection-affinity restores origin/main in-process reuse. Trade-off:
git batches serialize on one worker, but within-batch chunkConcurrency keeps
git-subprocess parallelism; cache reuse dominates.
```

---

## Task 2: Fix false "stalled" status during a healthy long run

**Files:**

- Modify: `marker-store.ts` (run-pointer `lastProgressAt` heartbeat),
  `coordinator.ts` (call from streaming apply, throttled)
- Test: `health-mapper.test.ts`, `marker-store.test.ts`

**Root cause:** `health-mapper.ts:63` derives staleness from
`run.lastProgressAt ?? run.startedAt`; `:72` flags
`elapsed > STALE_THRESHOLD_MS` (2 min) as "stalled". Terminal-only markers never
bump `lastProgressAt` mid-run, so any run >2 min reads "stalled". Reproduced 3×.

- [ ] **Step 1: Failing test** in `health-mapper.test.ts` — run pointer with
      `lastProgressAt` <2 min ago + non-terminal levels → `mapLevelWithRun`
      returns `"Enrichment in progress..."`, NOT the stalled message; inverse
      (>2 min stale) still allowed to report stalled.
- [ ] **Step 2: Failing test** in `marker-store.test.ts` —
      `touchRunProgress(collection)` patches only `_run.lastProgressAt`, leaving
      per-level terminal markers untouched. RED: method absent.
- [ ] **Step 3: GREEN** — add `marker-store.touchRunProgress`; call it from the
      coordinator streaming apply path throttled to ~30 s (track
      `lastHeartbeatAt` in run state), preserving the terminal-only invariant
      (`types.ts:49`).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit**
      `fix(ingest): heartbeat run.lastProgressAt so long enrichment isn't false-flagged stalled`
      (+ Why:).

---

## Task 3: Fix bogus `durationMs` / `chunkChurnDurationMs`

**Files:** `chunk-phase.ts` (`chunkEnrichmentDurationMs`, ~255-341),
`completion-runner.ts` (~114-157); Test: `chunk-phase.test.ts` /
`completion-runner.test.ts`

**Root cause:** surfaced 165 360 838 ms (≈45.9 h) — larger than process uptime →
`state.chunkEnrichmentDurationMs` accumulates across runs on the long-lived
daemon (not reset per run).

- [ ] **Step 1: Failing test** — two sequential runs on the same state; run-2's
      `chunkChurnDurationMs` reflects only run-2 (bounded), not run-1+run-2.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: GREEN** — reset `state.chunkEnrichmentDurationMs` at run start
      (mirror `chunkSymbolByLine.delete(key)` reset in `provider.ts:~1137`), or
      compute from this run's start. Keep `totalDurationMs`
      (`completion-runner.ts:115`) on the same per-run anchor.
- [ ] **Step 4: Run — PASS.** **Step 5: Commit**
      `fix(ingest): reset chunk-enrichment duration per run`.

---

## Task 4: Dedup `matchedFiles` across passes

**Files:** `applier.ts` (~29,111,195,307); Test: `applier.test.ts`

**Root cause:** monotonic counter incremented across streaming + deferred +
finalize passes → taxdome reported 42 378 > 24 595 real files.

- [ ] **Step 1: Failing test** — apply same relPath in two passes; assert
      `matchedFiles` counts it once.
- [ ] **Step 2: Run — FAIL (counts 2).**
- [ ] **Step 3: GREEN** — track `Set<string>` of matched relPaths;
      `matchedFiles = set.size`. Keep `missedFiles` intact.
- [ ] **Step 4: Run — PASS.** **Step 5: Commit**
      `fix(ingest): count matchedFiles as unique paths`.

---

## Task 5: Investigate residual 100 unenriched git chunks (gate on Task 1)

Investigation first — no code until reproduced post-Task-1.

- [ ] **Step 1:** After Tasks 1–4 merged+relinked, run Task 9 verification; if
      git.chunk is `healthy` 0-unenriched → close "resolved by Task 1".
- [ ] **Step 2:** If it persists, scroll `is_empty: git.chunk.enrichedAt`,
      identify which `chunk-phase.ts` `enrichRemaining` (~156-197) pass should
      cover them, add a failing test reproducing the gap, then fix coverage.

---

## Task 6: Repair/remove dead overlap metrics + fix the skill rule

**Files:** `completion-runner.ts` (~110-126), `src/core/types.ts` (~124-144),
`.claude/skills/debug-pipeline-log/SKILL.md`; Test: `completion-runner.test.ts`

**Root cause:** `overlapRatio`/`estimatedSavedMs` hardcoded 0
(`completion-runner.ts:111,120`), `gitLogFileCount` reads
`totalFileMetadataCount` = 0 under streaming — vestigial bulk-prefetch
accounting; `debug-pipeline-log` Rule 7 false-flags "no overlap".

- [ ] **Step 1: Decide (YAGNI)** — prefer REMOVING the dead fields
      (`overlapMs`/`overlapRatio`/`estimatedSavedMs`/`gitLogFileCount`) from
      `EnrichmentMetrics` (`types.ts:124-144`) + the ALL_COMPLETE payload, OR
      replace with a real `streamingOverlapMs`.
- [ ] **Step 2: Failing test** — ALL_COMPLETE no longer emits the dead zero
      fields (or emits the real metric). **Step 3: Run — FAIL.**
- [ ] **Step 4: GREEN** — apply in `completion-runner.ts` + `types.ts`.
- [ ] **Step 5:** Update `debug-pipeline-log/SKILL.md` Rule 7 to match (per
      `feedback_no_silent_skill_patches`: list what/why).
- [ ] **Step 6: Run — PASS. Step 7: Commit**
      `refactor(ingest): drop vestigial overlap metrics; fix debug-pipeline-log Rule 7`.

---

## Task 8: Document codegraph deferred-chunk ordering (verify, likely no code)

**Files:** `chunk-phase.ts` (~229-234, doc comment only)

- [ ] **Step 1:** Confirm deferred codegraph chunk AFTER the git streaming drain
      (`chunk-phase.ts:233`) is intentional (needs finalized DuckDB graph;
      cross-ref `codegraph/symbols/provider.ts` `finalizeSignals`).
- [ ] **Step 2:** If intentional, tighten the comment (WHY: graph readiness;
      post-Task-1 git chunk is fast so serialization is cheap) and record
      "future: incremental codegraph chunk resolve" as a beads note (not a
      task). No behavior change.
- [ ] **Step 3:** Commit docs-only if changed.

---

## Task 9: Whole-plan verification (live MCP)

Follow `.claude/CLAUDE.md` "MCP Integration Testing — npm link workflow".

- [ ] **Step 1:** Worktree `npm run build && npm test` (green, tsc=0, eslint=0).
- [ ] **Step 2:** `npm link`; user reconnects tea-rags MCP.
- [ ] **Step 3:** `force_reindex` tea-rags self-test → all 4 phases terminal
      healthy, status shows real progress (no false-stall).
- [ ] **Step 4:** Live `force_reindex taxdome` **without mid-run reconnect**,
      sampling RSS. Assert: git.chunk wall time drops sharply vs ~700–1000 s; no
      false-stall; `chunkChurnDurationMs` in minutes; `matchedFiles ≤ 24752`;
      all 4 phases terminal healthy (git.chunk degraded-100 resolved or Task 5).
- [ ] **Step 5:** Merge worktree → main; `npm run build && npm link` on main;
      reconnect MCP (link-flip workflow).
- [ ] **Step 6:** `bd close` each Task; `bd sync`; push only on explicit user
      request.

---

## Self-Review

- Tasks 1–6 + 8 map to the six discovered problems + the codegraph observation;
  #7 fragility → `tea-rags-mcp-pd2u` (out of scope); #9 `chunkConcurrency 5→10`
  → user `~/.claude.json` config, separate.
- Deep-silo commits (`factory.ts`) carry `Why:` lines (`silo-pairing.md`).
- Order: Task 1 first (Task 5 gates on it); Task 2 next; 3/4/6 independent; 8
  last; 9 verifies.
