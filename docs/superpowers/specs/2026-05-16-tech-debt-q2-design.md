# Tech Debt Q2 2026 — Epic Design

**Date:** 2026-05-16 **Status:** Draft **Scope:** Single epic, 4 milestones
covering error taxonomy split, ingest bug attractors, oversized method
decomposition, and silo mitigation.

## Source signals

Derived from `tea-rags:risk-assessment` re-run on 2026-05-16 (collection
`code_8b243ffe`, 4125 chunks). Three preset lenses (`hotspots`, `ownership`,
`techDebt`) converged on the same set of files; full enrichment captured in the
brainstorm transcript.

Triple-overlap finding: `src/core/contracts/errors.ts` appears in all three
lenses — strongest single brainstorming signal, anchors Milestone 1.

## Problem

The codebase has accumulated four classes of tech debt detectable via git
signals:

- **Centralized contract drift.** `contracts/errors.ts` has grown to a 75-line
  `ErrorCode` string-literal union with `bugFixRate=42 concerning` (file) /
  `56 critical` (chunk), 17 commits, deep-silo ownership, 5 task IDs. Every new
  feature adds a code to one monolithic file — natural pressure for split.
- **Ingest bug attractors.** Four production-critical files in
  `src/core/domains/ingest/` show `bugFixRate concerning+`:
  `sync/deletion-strategy.ts:performDeletion` (70 critical),
  `indexing.ts:120-236` (53 concerning chunk),
  `pipeline/enrichment/applier.ts:applyFileSignals` (50 critical file),
  `pipeline/pipeline-manager.ts:addUpsert` (63 critical, 47-day legacy).
- **Oversized methods.** Three functions exceed reasonable comprehension limits:
  `reindexing.ts:322-509` (158 lines, chunk bugFix 55 critical),
  `git/infra/chunk-reader.ts:buildChunkChurnMapUncached` (341 lines),
  `mcp/tools/code.ts:registerCodeTools` (272 lines).
- **Knowledge silos.** Seven files have `blameDominantAuthorPct=100% deep-silo`
  with single live-line owner — bus-factor 1 for critical paths.

Real-world impact: `bugFixRate concerning+` means >38% of commits to these files
are bug-fix commits. Each new feature touching them carries elevated regression
risk.

## Solution

Single beads epic `tea-rags-mcp-techdebt-q2` with four milestones executed in
hard order M1 → (M2 || M3 || M4). Each milestone owns its own test strategy
appropriate to its risk profile.

### Milestone 1 — Error Taxonomy Split

**Goal:** Reduce `contracts/errors.ts` `ErrorCode` union from 75 lines to a
≤15-line aggregation by relocating per-domain codes to their existing
`*errors.ts` files. Existing typed-error class hierarchy
(`TeaRagsError → IngestError/ExploreError/...`) stays intact.

**Risk profile:** Low. Type-only change. String literals
(`"INFRA_QDRANT_UNAVAILABLE"` etc.) are preserved verbatim — only their
declaration moves. All `instanceof` checks and `error.code === "..."`
discriminations continue to work because TypeScript union resolution is
structural, not nominal.

**Tasks (6):**

| Task | Action                                                                                                                                                                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1.1 | Create `UnknownErrorCode` in `core/contracts/errors.ts` (root fallback stays at contracts level)                                                                                                                                                                                                              |
| M1.2 | Create `InputErrorCode` in `core/api/errors.ts` (lives next to `InputValidationError`)                                                                                                                                                                                                                        |
| M1.3 | Create `InfraErrorCode` in `core/adapters/errors.ts`                                                                                                                                                                                                                                                          |
| M1.4 | Create `IngestErrorCode` in `core/domains/ingest/errors.ts`                                                                                                                                                                                                                                                   |
| M1.5 | Create `ExploreErrorCode` in `core/domains/explore/errors.ts` and `TrajectoryErrorCode` in `core/domains/trajectory/errors.ts`                                                                                                                                                                                |
| M1.6 | Create `ConfigErrorCode` in `core/bootstrap/errors.ts`, then collapse `core/contracts/errors.ts` to aggregation `type ErrorCode = UnknownErrorCode \| InputErrorCode \| InfraErrorCode \| IngestErrorCode \| ExploreErrorCode \| TrajectoryErrorCode \| ConfigErrorCode`. Update all relevant barrel exports. |

**Test strategy:** TypeScript compile + existing typed-error tests in
`tests/core/contracts/`. No new tests required.

**Labels:** `api`, `architecture`.

### Milestone 2 — Ingest Bug Attractors (TDD-strict)

**Goal:** Lower `bugFixRate` for four files in `domains/ingest/` below the
`concerning` threshold (38) by extracting cohesive helpers behind failing tests
written first.

**Risk profile:** High. Production-critical paths. TDD non-optional.

**Tasks (12):**

#### M2.A — `deletion-strategy.ts:performDeletion` (file bugFix 70 critical)

| Task   | Action                                                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M2.A.1 | Failing test: partial deletion outcome (some chunks succeed, some fail). Use existing `MockQdrantManager` from `tests/core/domains/ingest/__helpers__/test-helpers.ts`. |
| M2.A.2 | Failing test: retry exhaustion produces correct `DeletionOutcome` shape.                                                                                                |
| M2.A.3 | Extract `DeletionRetryHelper` (backoff + outcome accumulation). Tests pass.                                                                                             |
| M2.A.4 | Extract `BatchDeleteExecutor` (qdrant client invocation per batch). Tests pass.                                                                                         |

#### M2.B — `IndexPipeline.processAndTrack` block (chunk bugFix 53 concerning, methodLines 97)

| Task   | Action                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------- |
| M2.B.1 | Failing test: heartbeat lifecycle survives `processAndTrack` exception.                                              |
| M2.B.2 | Failing test: `pauseOptimizer` / `resumeOptimizer` invariant — resume must run in `finally` even when caller throws. |
| M2.B.3 | Extract `OptimizerLifecycle` helper (pause/resume + finally guard).                                                  |
| M2.B.4 | Extract `HeartbeatGuard` helper (start/stop with cleanup contract).                                                  |

#### M2.C — `EnrichmentApplier.applyFileSignals` (file bugFix 50 critical, methodLines 95)

| Task   | Action                                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M2.C.1 | Failing test: missed-file path (`fileMetadata.get(relativePath)` returns undefined) populates `_missedFileChunks` and emits chunk-level `enrichedAt` stamps. |
| M2.C.2 | Extract `MissedFileTracker` (accumulate missedFiles + samples + chunk stamps). Happy path stays in `applyFileSignals`.                                       |

#### M2.D — `pipeline-manager.ts:addUpsert` (bugFix 63 critical, 47d legacy)

| Task                 | Action                                                                                                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M2.D.1               | **Investigation only.** Read commit history and bug-fix messages for `addUpsert`. Document findings in beads task notes. Reason: legacy + critical bugFix is the "fragile legacy" pattern in `signal-confidence.md` — refactoring without root-cause understanding is regression bait. |
| M2.D.2 (conditional) | Refactor only if M2.D.1 surfaces a concrete cause. Otherwise close M2.D as `reason="root cause elsewhere, deferred"`.                                                                                                                                                                  |

#### M2.E — `reindexing.ts:322-509` (chunk bugFix 55 critical, methodLines 158)

Hybrid: oversized AND bug attractor. Lives in M2 (not M3) because TDD is
required.

| Task   | Action                                                                                     |
| ------ | ------------------------------------------------------------------------------------------ |
| M2.E.1 | Investigation: read commits referencing this block to identify the historical bug class.   |
| M2.E.2 | Failing test for the identified edge case.                                                 |
| M2.E.3 | Decompose the block into ≤3 cohesive functions (exact decomposition decided after M2.E.1). |

**Test strategy:** Strict TDD per `superpowers:test-driven-development`.
Existing helpers in `tests/core/domains/ingest/__helpers__/test-helpers.ts`
provide `MockQdrantManager`, filesystem mocks, and config defaults.

**Labels:** `bugfix`, `architecture`.

### Milestone 3 — Oversized Method Decomposition

**Goal:** Reduce two large functions to ≤80 lines each. Behavior-preserving
refactor only — no new tests, ride existing.

**Risk profile:** Medium. Diff size makes review harder, but no behavior change.

**Tasks (5):**

#### M3.A — `chunk-reader.ts:buildChunkChurnMapUncached` (341 lines)

| Task   | Action                                                                                     |
| ------ | ------------------------------------------------------------------------------------------ |
| M3.A.1 | Extract `buildAccumulators` (initialize per-chunk accumulator state).                      |
| M3.A.2 | Extract `walkCommits` (commit iteration + accumulator updates).                            |
| M3.A.3 | Extract `assembleOverlays` (final reduce → `Map<string, Map<string, ChunkChurnOverlay>>`). |

#### M3.B — `mcp/tools/code.ts:registerCodeTools` (272 lines, 28 commits)

| Task   | Action                                                                                                                                                   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M3.B.1 | Group tool registrations by family: search (`semantic_search`, `hybrid_search`), symbol (`find_symbol`), rank (`rank_chunks`), similar (`find_similar`). |
| M3.B.2 | Extract per-family functions: `registerSearchTools`, `registerSymbolTools`, `registerRankTools`, `registerSimilarTools`. Each ≤80 lines.                 |

**Test strategy:** Existing tests in `tests/core/domains/trajectory/git/` and
`tests/mcp/tools/` cover both surfaces. Manual MCP reconnect spot-check before
commit per `.claude/rules/.local/mcp-testing.md`.

**Labels:** `architecture`, `dx`.

### Milestone 4 — Silo Mitigation

**Goal:** Reduce silo concentration where structurally possible (`createApp`
decomposition) and document a pairing process for the rest.

**Risk profile:** Low. One small refactor + documentation.

**Tasks (3):**

| Task | Action                                                                                                                                                                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M4.1 | Decompose `api/public/app.ts:createApp` (62-line block, deep-silo, 11 commits) into `wireFacades` (facade instantiation) and `wireOps` (Ops registration). Reduces silo concentration through explicit layer separation.                                                                        |
| M4.2 | Create `.claude/rules/silo-pairing.md` listing remaining deep-silo files after M1: `indexing-ops.ts`, `project-registry-ops.ts`, `pipeline/enrichment/recovery.ts`, `adapters/qdrant/errors.ts`. Rule: when touching a deep-silo file, commit message must include intent + trade-offs context. |
| M4.3 | Add reference to `silo-pairing.md` in `CLAUDE.md` rules section.                                                                                                                                                                                                                                |

**Test strategy:** `markdownlint` for new `.md` files. Existing
`tests/core/api/public/` covers `createApp` wiring.

**Labels:** `dx`, `docs`.

## Execution order

```
M1.1 .. M1.5 (parallel)
        |
        v
       M1.6  (collapse contracts/errors.ts)
        |
        +-----> M2.* (depends on M1 — uses new typed error codes)
        |
        +-----> M3.* (independent of M1, can start in parallel with M1)
        |
        +-----> M4.1, M4.2, M4.3 (independent, any order)
```

Hard order: M1.6 must complete before M2 starts (M2 tasks add new typed errors
that reference the new `IngestErrorCode` etc.).

Soft order inside M2: M2.A → M2.B → M2.C → M2.D → M2.E. One person at a time
through the ingest pipeline avoids merge conflicts.

M3 and M4 are fully independent of each other and of M2.

## Definition of Done

### Per milestone

- All beads tasks closed
- Pre-commit hook (vitest + type-check + commitlint) green
- `dinopowers:verification-before-completion` returns SAFE or CAUTION verdict
  (not UNSAFE)
- Coverage threshold not lowered (`feedback_never_lower_thresholds` rule)

### Per epic

- `mcp__tea-rags__force_reindex project=tea-rags` succeeds without payload
  schema errors (validates that signal descriptors still resolve)
- Re-run `tea-rags:risk-assessment` one week post-merge:
  - `contracts/errors.ts` no longer appears in any of the three lenses
  - `bugFixRate` for the four ingest hotspot files trends below `concerning`
    threshold (requires git log accumulation — measure at +30 days)
- All commits follow `commit-rules.md`: type + scope (`feat`, `improve`, `fix`,
  `refactor`, `chore`, etc. with appropriate scope)

## Risks and mitigations

| Risk                                                                                                           | Mitigation                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 split breaks downstream consumers relying on `code` shape (Claude clients, MCP error responses)             | M1 does not change string literals — only their declaration site. `errorHandlerMiddleware` unchanged. End-to-end MCP smoke test via reconnect after M1.6. |
| M2 TDD adds 12+ tasks of failing-test-then-extract; milestone overruns                                         | Parallelize via `superpowers:subagent-driven-development` after M1 unblocks. M2.A/B/C/E touch independent files.                                          |
| M2.D investigation reveals root cause is in caller, not `pipeline-manager.ts`                                  | Acceptable outcome. Close M2.D with `reason="root cause elsewhere, deferred"`. Document findings — they become input for a future epic.                   |
| M3.B `registerCodeTools` decomposition breaks MCP tool schemas silently (tests pass but Claude client rejects) | Existing tests in `tests/mcp/tools/` cover registration. Mandatory manual reconnect spot-check per `.claude/rules/.local/mcp-testing.md` before commit.   |
| Force re-index on `code_8b243ffe` (verification step) takes hours and blocks the developer                     | The self-test index is small (~4100 chunks). Force reindex should complete in <2 minutes. Run only at epic close, not per milestone.                      |
| Beads tasks accumulate >30 — overhead dominates execution time                                                 | Acceptable for an epic of this size. `bd ready` filters by dependency unblocking, so working set stays small.                                             |

## Out of scope

Deferred to separate tracks (not part of this epic):

- `adapters/embeddings/onnx/worker.ts` (intense changeDensity 13.54) —
  embedding-perf track
- `adapters/embeddings/ollama.ts:embedBatch` (chunk bugFix 79 critical) —
  embedding-perf track (requires rate-limit domain knowledge)
- `website/docusaurus.config.ts` (chunk bugFix 90 critical) — outside `core/`,
  not codebase tech debt
- Documentation regeneration for already-closed enrichment refactoring epic
  (`tea-rags-mcp-4zh`)
- General test coverage expansion outside the M2 hotspot scope
