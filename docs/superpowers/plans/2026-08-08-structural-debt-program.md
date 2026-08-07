# Structural Debt Reduction — Program Plan (preliminary)

> **Status: PRELIMINARY — awaiting scope approval. Not executable yet.** This is
> a program map, not an implementation plan. It decides how the work splits and
> in what order it runs. Each epic below becomes its own
> `superpowers:writing-plans` pass producing a full no-placeholder,
> TDD-decomposed plan document. Do not hand this file to
> `dinopowers:executing-plans`.

**Goal:** Remove the structural debt the 2026-08-08 risk-assessment found — four
god modules/classes, seven god methods, one 1741-line contract file, and two
bug-attractor files — without changing observable behavior.

**Architecture:** Every epic is a behavior-preserving extraction. Oversized
units get decomposed into focused collaborators wired by dependency injection,
behind a facade that keeps the existing public surface intact wherever
`fanIn > 1`. Consumer code changes only where the epic explicitly says so. The
repo has run this exact play twice before — the `EnrichmentCoordinator` split
and the G2 `CodegraphEnrichmentProvider` split (2836 → 1511 LOC into 6
collaborators, 10 commits) — and both are the empirical anchor for scope and
sequencing here.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, Qdrant,
DuckDB (codegraph), tree-sitter, Ollama/Jina embeddings.

## Global Constraints

Every task in every epic inherits these. Values are copied from the repo's own
rule files, not invented here.

- **Behavior-preserving.** No epic in this program may change observable output.
  A decomposition that "improves" a result is out of scope and must be filed
  separately.
- **Refactor test order inverts TDD.** Relocations follow move code → green →
  redistribute tests LAST. Do not write a failing test first for a pure move.
  (`feedback_refactor_migration_test_order`)
- **Business-logic tests are immutable.** Moving a test to a new file is fine.
  Rewriting its assertions during a refactor is not.
  (`feedback_business_logic_tests_immutable`)
- **Never lower coverage thresholds.** Pre-commit enforces the global vitest
  thresholds. A failing gate is delegated to the `coverage-expander` subagent
  (`Agent`, `subagent_type: "coverage-expander"`, `run_in_background: true`),
  never solved by editing the threshold.
- **No `eslint-disable`, no `v8 ignore`.** Fix the code.
- **Silo-pairing rule applies to Epic 6.** `type-propagation.ts` and
  `ruby-dynamic-dispatch.ts` are 100% single-live-line-owner. Every commit
  touching them MUST carry a `Why:` line. (`.claude/rules/silo-pairing.md`)
- **Naming.** Generic suffixes (`Outcome`, `Strategy`, `Metadata`, `Result`,
  `Handler`) must be qualified with domain context and unambiguous at the use
  site. (`.claude/rules/naming.md`)
- **Construction is encapsulated in factories**; worker-thread DI goes through
  an injected module path, never a direct import.
  (`.claude/rules/domains-language.md`)
- **Commits** are conventional, header ≤ 100 chars.
- **One beads epic per plan.** Created on approval, before any execution.
  (`.claude/rules/.local/plan-beads-sync.md`)

---

## Scope Check verdict

The 14 affected files span five independent subsystems: ingest pipeline
enrichment, ingest pipeline chunking, DuckDB adapters, embedding adapters, and
the Ruby language domain — plus the shared contracts file. Per the writing-plans
scope rule this is **not one plan**. It is a program of six plans, each of which
produces working, independently testable software on its own.

Each epic below can ship alone. None of them blocks the others except the one
dependency noted in Epic 5.

---

## tea-rags impact enrichment (rerank: blastRadius, codegraph on)

Paths are relative to `src/core/`; `…` elides an intermediate directory.

| File                               | Owner (blame)               | Churn | Age    | bugFixRate\*       | fanIn         | transImpact     |
| ---------------------------------- | --------------------------- | ----- | ------ | ------------------ | ------------- | --------------- |
| `contracts/types/codegraph.ts`     | artk0de 57% (3)             | 57    | 1d     | 18% healthy        | **60 hub**    | **86 systemic** |
| `ingest/…/debug-logger.ts`         | Korochansky 96% (2)         | 7     | 8d     | 14% healthy        | **15 hub**    | 23 regional     |
| `ruby/…/type-propagation.ts`       | **artk0de 100% (1 — silo)** | 17    | 2d     | 29% healthy        | 10 hub        | **30 systemic** |
| `ruby/walker/walker.ts`            | artk0de 70% (3)             | 40    | 2d     | 20% healthy        | 7 hub         | 24 regional     |
| `adapters/duckdb/client.ts`        | artk0de 53% (3)             | 30    | 1d     | 20% healthy        | 2             | 12 systemic     |
| `ingest/…/enrichment/recovery.ts`  | artk0de 59% (3)             | 13    | 1d     | **62% critical**   | 1             | 1 local         |
| `ingest/…/enrichment/applier.ts`   | artk0de 41% (3)             | 19    | **0d** | **53% concerning** | 2             | 2 local         |
| `ingest/…/completion-runner.ts`    | artk0de 54% (3)             | 16    | 1d     | 38% concerning     | 1             | 2 local         |
| `ingest/…/file-phase.ts`           | Korochansky 39% (3)         | 14    | 0d     | 36% healthy        | 1             | 2 local         |
| `ingest/…/file-processor.ts`       | Korochansky 79% (2)         | 14    | 0d     | 14% healthy        | 2             | 3 local         |
| `ingest/…/chunker/tree-sitter.ts`  | Korochansky 82% (4)         | 21    | 8d     | 19% healthy        | 1             | 1 local         |
| `adapters/duckdb/daemon/server.ts` | Korochansky 51% (3)         | 13    | 1d     | 8% healthy         | 1             | 1 local         |
| `ruby/…/ruby-dynamic-dispatch.ts`  | **artk0de 100% (1 — silo)** | 15    | 2d     | 13% healthy        | 1 (fanOut 11) | 1 local         |
| `adapters/embeddings/onnx.ts`      | Korochansky 97% (2)         | 17    | 0d     | 35% healthy        | 1             | 9 local         |

\* `bugFixRate` carried over from the risk-assessment scan — the `blastRadius`
overlay does not expose it. "Korochansky" is Arthur Korochansky.

**Coordinated change candidates: none.** `taskIds` is empty across all 14 files,
so sequencing cannot be derived from ticket coupling. It is derived from blast
radius and defect density instead.

**Proven template** (extract-project-patterns, locality **L1**
`**/domains/ingest/pipeline/**`, quality gate passed with 5 ideal candidates):

- `ingest/pipeline/chunker/base.ts` — `CodeChunker` interface, 15 lines
  (commitCount low, ageDays 59 old, bugFixRate 0% healthy). Reviewer: Martin
  Halder.
- `ingest/pipeline/chunker/character.ts` — `CharacterChunker`, 136 LOC / 6
  members (same labels). Reviewer: Martin Halder.
- Locality L1 → review style _and_ code. This pair is the shape to decompose
  **toward**: narrow interface, small focused implementation, wired by DI.
- **Caveat:** semantic confidence 0.33 (low). The query describes a refactoring
  _act_, which has no direct representation in code. Treat these as a
  target-shape reference, not as an extraction procedure.

---

## Sequencing

Ordered by **value ÷ cost**, not by size. The risk-assessment's "start with the
cheap 243-line methods" is the cheap-win ordering; it is not the highest-value
ordering. Defect density comes first because it is the only group where the debt
is currently costing something.

**Wave 1 — E1 Enrichment defect hardening.** The only genuine quality problem in
the set. Small methods, local blast radius, worst bugFixRate in the project.
Best value ÷ cost by a wide margin.

**Wave 2 — E2 Ingest god-method decomposition, E3 Adapter god-method
decomposition.** Cheapest mass wins: `transitiveImpact ≤ 3`, thick existing
tests. E2 and E3 are parallelizable — no file overlap, different owners.

**Wave 3 — E4 Codegraph contracts split.** Highest `fanIn` in the project (60)
but import-path-neutral via a barrel re-export, so risk is low despite the
number. Unblocks E5.

**Wave 4 — E5 Infrastructure god-class splits.** Two facade-preserving class
splits. Depends on E4 for the `GraphDbClient` half only.

**Wave 5 — E6 Ruby resolver/walker + bus factor.** Highest risk: correctness
here is _measured on corpora_, not asserted by unit tests, and both main files
are silo-owned. Goes last so the extraction pattern is settled before it is
applied to the riskiest area.

**Note on E1 timing.** `applier.ts` has `ageDays 0` — it is being actively
edited. Starting E1 while another session is in that file invites conflict.
Confirm the enrichment area is quiet before opening E1, or start with E2/E3 and
swap the wave order.

---

## Epic 1 — Enrichment defect hardening

**Problem class:** D (bug attractors). This is the one epic where decomposition
is a _means_, not the goal. The goal is reducing defect density.

**Files:** `ingest/pipeline/enrichment/recovery.ts` (444 LOC,
`recoverChunkLevel` 76 LOC, bugFixRate **62% critical**),
`ingest/pipeline/enrichment/applier.ts` (580 LOC, `buildFilePayloadOps` 94 LOC,
bugFixRate **53–59% concerning**).

**Approach:** Start with a defect taxonomy pass, not with extraction. Read the
fix commits behind those rates and classify what actually broke — marker
lifecycle, partial-batch state, filter construction, ordering. Only then decide
which seams remove a whole defect class. Blind extraction on a bug attractor
relocates the bugs.

**Blast radius:** local (`transitiveImpact` 1 and 2, `fanIn` 1 and 2). Safe to
change; the risk is behavioral, not structural.

**Exit criteria:** every defect class from the taxonomy has either a regression
test that would have caught it, or a documented reason it cannot recur.

**Scope class:** sub-epic. Add an empirical-iteration buffer — the taxonomy pass
has no fixed length.

---

## Epic 2 — Ingest pipeline god-method decomposition

**Problem class:** B (god methods), ingest half.

**Files and targets:**

| Target                                | File                                                 | Size                     |
| ------------------------------------- | ---------------------------------------------------- | ------------------------ |
| `processFiles()`                      | `ingest/pipeline/file-processor.ts:60`               | 243 LOC, chunk fanOut 29 |
| `TreeSitterChunker#processChildren()` | `ingest/pipeline/chunker/tree-sitter.ts:992`         | 243 LOC, chunk fanOut 21 |
| `CompletionRunner#run()`              | `ingest/pipeline/enrichment/completion-runner.ts:62` | 184 LOC, chunk fanOut 20 |
| `FilePhase#onBatch()`                 | `ingest/pipeline/enrichment/file-phase.ts:181`       | 108 LOC, chunk fanOut 15 |

**Approach:** All four are the same shape — a long orchestration body with high
outgoing call load and no outgoing _dependency_ weight (`transitiveImpact ≤ 3`).
Extract named phase objects, keep the entry-point signature byte-identical. This
is the `CodeChunker` / `CharacterChunker` target shape applied four times.

`CompletionRunner#run` deserves its own read before extraction: its body carries
a deliberate concurrency overlap (backfill kicked off in parallel with the
codegraph finalize) documented in a long inline comment. Extraction must
preserve that overlap, and the plan for it must say so explicitly — an "obvious"
sequential cleanup here reintroduces a tail the team already removed.

**Blast radius:** local across all four. All have dedicated test files.

**Owner review:** Arthur Korochansky (79–82% on the two chunker/processor
files).

**Scope class:** sub-epic.

---

## Epic 3 — Adapter god-method decomposition

**Problem class:** B (god methods), adapter half. Parallelizable with Epic 2 —
no file overlap, different owner.

**Files and targets:**

| Target                             | File                                  | Size    |
| ---------------------------------- | ------------------------------------- | ------- |
| `CodegraphDaemonServer#dispatch()` | `adapters/duckdb/daemon/server.ts:74` | 202 LOC |
| `OnnxEmbeddings#connectToDaemon()` | `adapters/embeddings/onnx.ts:153`     | 110 LOC |

**Approach:** `dispatch` is a long request-type switch — a command table keyed
by protocol op is the natural shape, and it also makes the daemon protocol
surface enumerable, which the current form hides. `connectToDaemon` mixes spawn,
handshake, and retry; split along those three.

**Blast radius:** local (`transitiveImpact` 1 and 9).

**Owner review:** `onnx.ts` is 97% single-owner (Arthur Korochansky) — route the
review there rather than to whoever is free.

**Scope class:** task / small sub-epic. The cheapest epic in the program.

---

## Epic 4 — Codegraph contracts split

**Problem class:** C (contracts).

**File:** `contracts/types/codegraph.ts` — 1741 LOC, `fanIn` **60**,
`transitiveImpact` **86**, `fanOut` 0, `isLeaf` true. The only true
architectural hub in the project. Three oversized interfaces inside it:
`GraphDbClient` (260 lines), `FileExtraction` (234), `CallContext` (216).

**Approach:** This is type-only with zero runtime. Split by concern — extraction
contracts, resolution contracts, storage/client contracts, graph value types —
and keep `codegraph.ts` as a barrel that re-exports everything. Consumer imports
do not change at all, which is why the highest `fanIn` in the repo is also the
_safest_ large change here. High fan-in only means high risk when the change is
import-path-visible; this one is not.

**Why before Epic 5:** `GraphDbClient` is the contract that `DuckDbGraphClient`
(1589 LOC) and `DaemonGraphDbClient` (428 LOC, 51 methods) both implement.
Splitting the interface first gives Epic 5 a seam to split the implementations
along. Doing it in the other order means splitting the implementations twice.

**Blast radius:** 60 importers, but import-path-neutral. Type-check is the gate.

**Scope class:** sub-epic, mechanical.

---

## Epic 5 — Infrastructure god-class splits behind facades

**Problem class:** A (god classes), non-Ruby half. **Depends on Epic 4** for the
`GraphDbClient` half only; the `DebugLogger` half is independent and can start
immediately.

### 5a — `DebugLogger`

`ingest/pipeline/infra/debug-logger.ts` — 622 LOC, 36 callables, `fanIn` **15
(hub)**, `transitiveImpact` 23, churn low (7 commits, 8 days).

The file already contains three of its own collaborators — `StageProfiler`,
`SlowFileTracker`, `FileIngestRecord` — alongside a `DebugLogger` class carrying
~28 members. The split is largely already designed; it just was never finished.
Keep the `pipelineLog` singleton surface intact so none of the 15 call sites
move.

Low churn plus an already-visible seam makes this the cheapest of the class
splits.

### 5b — `DuckDbGraphClient`

`adapters/duckdb/client.ts` — 1589 LOC, 69 callables, ~60 of them members of one
class, `transitiveImpact` 12 systemic.

Split the _implementation_ into collaborators behind the existing
`GraphDbClient` interface, with `DuckDbGraphClient` remaining as the facade.
Zero consumer churn. Candidate seams visible in the outline: node/symbol writes,
adjacency and cycle reads, hierarchy, run-stats, and the free-function SQL
helpers at the bottom (`bindParams`, `parseScope`, `splitMethodSymbol`,
`escapeLikeLiteral`, `roundEdgeWeightSum`) which do not belong to the class at
all.

**Mirror warning:** `DaemonGraphDbClient` implements the same interface over
IPC. Any interface-level change doubles the work. Keeping the split behind the
existing interface avoids that entirely — which is the argument for the facade
approach over an interface redesign.

**Anchor:** the G2 `CodegraphEnrichmentProvider` split — 2836 → 1511 LOC into 6
collaborators — landed in 10 commits. Both halves here are smaller than that.

**Scope class:** epic.

---

## Epic 6 — Ruby resolver/walker decomposition + bus-factor mitigation

**Problem class:** A (god modules), Ruby half, plus E (bus factor). The
highest-risk epic in the program and the reason it runs last.

**Files:**

| File                              | Size                               | Signals                                                  |
| --------------------------------- | ---------------------------------- | -------------------------------------------------------- |
| `ruby/walker/walker.ts`           | **2380 LOC, 59 callables**         | fanIn 7 hub, transImpact 24                              |
| `ruby/…/type-propagation.ts`      | 886 LOC, 30 callables              | fanIn 10 hub, transImpact **30 systemic**, **silo 100%** |
| `ruby/…/ruby-dynamic-dispatch.ts` | 248 LOC, `resolveDispatch` 122 LOC | fanOut **11 heavy**, **silo 100%**                       |

**Approach:** `walker.ts` has clear seams already visible in its own outline —
signature collection, inheritance/ancestor collection, call collection, DSL edge
emitters, local-binding collection, constant and dispatch-table collection. It
reads as six modules that were never separated, not as one cohesive unit.
`type-propagation.ts` splits along its resolution channels (declared,
association, ancestor MRO, flat YARD, ActiveRecord vocabulary) — the
`returnTypeOf` cascade already names them in comments.

**What makes this different from every other epic:** correctness in the Ruby
resolver is _measured_, not asserted. Unit tests passing does not prove a
decomposition was behavior-neutral. The proof is re-measuring
`resolveSuccessRate` and `inProjectEdgeRecall` on the real corpora (mastodon,
taxdome) before and after, and getting identical numbers.

**Non-negotiable gates:**

1. Record baseline corpus metrics **before** the first extraction. No baseline,
   no epic.
2. Reindex + re-measure after each extraction step, not once at the end. A drift
   found after six extractions cannot be bisected cheaply.
3. Reindex is **user-gated** — it rewrites the shared Qdrant index and depends
   on Ollama embeddings. Never chain it off a build.
   (`feedback_no_auto_build_worktree`)
4. Every commit carries a `Why:` line (silo-pairing rule).

**Bus-factor mitigation is a deliverable, not a side effect.**
`type-propagation.ts` is 100% one live-line owner sitting on
`transitiveImpact 30`. The decomposition — named modules with stated
responsibilities — is what transfers the knowledge. A second reviewer must be
routed onto these commits deliberately.

**Scope class:** epic, with an empirical-iteration buffer per measurement phase.

---

## Cross-cutting guardrails

- **Worktree per epic**, not per program. Six epics running in one branch makes
  bisection useless when a corpus metric drifts.
- **Do not batch merges.** Each epic merges on its own green suite and its own
  coverage gate.
- **Index freshness.** After any merge that touches payload shape or enrichment,
  the tea-rags self-index is stale. Reindex is user-gated; do not assume search
  results reflect merged code.
- **Beads lifecycle.** Every epic's beads must be settled — closed with
  evidence, reset to `open`, or handed to a named live worktree — before its
  worktree is torn down. (`.claude/rules/worktree-beads-lifecycle.md`)

---

## Scope estimate

Anchored to the **G2 `CodegraphEnrichmentProvider` split** (2836 → 1511 LOC into
6 collaborators, 10 commits) — the closest historical operation to Epics 4/5/6 —
with the substrate-exists discount applied, because the extraction pattern is
already established in this codebase twice over.

| Epic                                   | Burst days (P50)                  |
| -------------------------------------- | --------------------------------- |
| E1 enrichment defect hardening         | 2.0 (includes taxonomy buffer)    |
| E2 ingest god-methods                  | 1.5                               |
| E3 adapter god-methods                 | 0.75                              |
| E4 contracts split                     | 1.0                               |
| E5 infra god-classes                   | 2.0                               |
| E6 Ruby + bus factor                   | 4.0 (includes measurement buffer) |
| **Total (raw)**                        | **11.25**                         |
| After substrate-exists discount (×0.7) | **≈ 8**                           |

Converted at 2.5–3.5 burst days/week with the parallel-epic multiplier (×1.3):

- **P25 — 2.8 weeks**
- **P50 — 3.4 weeks**
- **P75 — 4.5 weeks**

Spread is slightly wider than this repo's usual ±15% because epic internals have
not been read yet — scope certainty, not execution certainty, is what widens it.

**First slice option:** E1 through E4 alone (everything except the two
class-split epics) is ≈ 3.7 burst days after discount → **≈ 1.3 weeks
calendar**, and clears the entire defect-density problem plus all seven god
methods. E5 and E6 are pure mass reduction and can wait.

---

## What this document deliberately does not contain

Per the writing-plans contract, a real plan carries no placeholders: exact file
paths, actual test code, actual implementation code, per-step commands. This one
carries none of that on purpose, because the scope covers five independent
subsystems and the scope rule says each gets its own plan.

Missing by design, produced in the next iteration:

- Per-task TDD step decomposition (write failing test → verify fail → implement
  → verify pass → commit)
- Exact collaborator names and interfaces — Epic 5 and 6 seams above are
  candidates read from symbol outlines, not from the code bodies
- Exact test file paths and test bodies
- Per-epic beads epic and tasks

**Next step:** approve the six-epic split and the wave order, pick the starting
epic, then run `dinopowers:writing-plans` against that epic alone to produce its
executable plan.
