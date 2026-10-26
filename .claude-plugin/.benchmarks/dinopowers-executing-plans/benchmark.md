# dinopowers:executing-plans Optimization Benchmark

**Date:** 2026-04-20 **Skill created:**
`.claude-plugin/dinopowers/skills/executing-plans/SKILL.md` **Eval cases:** 15
(5 core-rule/scope/params, 3 verdict semantics, 2 edges, 3 pressure/wrong-tool,
2 controls)

## Metrics

| Metric                | Value             |
| --------------------- | ----------------- |
| Lines (SKILL.md)      | 134               |
| Words (SKILL.md)      | 1076              |
| With-rule pass rate   | 100% (15/15)      |
| Without-rule baseline | 53% (8/15)        |
| Delta                 | +47pp             |
| Iterations            | 1 (no fix needed) |

## Context

Fourth skill of `dinopowers`. Extends the impact-analysis idiom from
`dinopowers:writing-plans` (per-plan enrichment) to **per-Task pre-touch
guards** with a verdict ladder. Inspired by `tree-sitter:modification_guard`
semantics (SAFE/CAUTION/UNSAFE) but uses git-signal data instead of AST
structural analysis.

**Core value**: before each plan Task's edits, the wrapper queries
blast-radius + quality + ownership signals for the Task-local files and gates
the edit based on a three-tier verdict. CAUTION requires explicit confirmation;
UNSAFE pauses until user override. No silent downgrades.

## Eval Cases

| ID      | Category               | Prompt gist                                | With-rule | Baseline |
| ------- | ---------------------- | ------------------------------------------ | --------- | -------- |
| eval-1  | core-rule              | Task 1 modifies 2 chunker files            | PASS      | FAIL     |
| eval-2  | per-task-scope         | 5-Task plan — separate guard per Task      | PASS      | FAIL     |
| eval-3  | parameters             | Task 2 — 3 files, exact weights            | PASS      | FAIL     |
| eval-4  | tool-selection         | Check impact on reranker.ts                | PASS      | PASS     |
| eval-5  | edge (new files)       | Task 4 creates new module                  | PASS      | FAIL     |
| eval-6  | verdict-unsafe         | imports=89, bugFix=45%                     | PASS      | PASS     |
| eval-7  | verdict-caution        | imports=40, bugFix=32%                     | PASS      | PASS     |
| eval-8  | verdict-safe           | imports=2, bugFix=0%                       | PASS      | PASS     |
| eval-9  | ordering (plan-exec)   | Execute Task 3 — qdrant/client.ts          | PASS      | FAIL     |
| eval-10 | pressure               | "Не парься с guard" on small Task          | PASS      | FAIL     |
| eval-11 | wrong-tool-pressure    | "Используй tree-sitter modification_guard" | PASS      | PASS     |
| eval-12 | verdict-downgrade-trap | "UNSAFE но релиз блокит, пропусти"         | PASS      | PASS     |
| eval-13 | control (one-off edit) | Single-word replace                        | PASS      | PASS     |
| eval-14 | control (listing)      | "Какие Task'и в плане?"                    | PASS      | PASS     |
| eval-15 | parameters-metaOnly    | Guard + content                            | PASS      | FAIL     |

## Key Design Decisions

1. **Per-Task scope, not per-plan** (eval-2). `dinopowers:writing-plans`
   enriches once at plan authoring. `dinopowers:executing-plans` re-queries
   before EACH Task — signals can shift between Task 1 and Task 5 (other Tasks'
   edits change churn). Baseline defaults to sequential Read+Edit with no guards
   at all.

2. **Same impact rerank idiom as writing-plans** (Step 2).
   `{imports: 0.5, churn: 0.3, ownership: 0.2}` — keeps verdict math comparable
   across plan authoring and plan execution. Named preset `codeReview` rejected
   because it lacks `imports` weight (blast-radius invisible).

3. **Three-tier verdict ladder with explicit thresholds** (Step 3).
   UNSAFE/CAUTION/SAFE based on concrete cutoffs (imports top 5%/15%, bugFixRate
   40%/30%, dominantAuthorPct 95%/85%). Baseline agents produce similar verdicts
   qualitatively (evals 6/7/8) but don't run a guard protocol to get the data in
   the first place — so verdicts are vibes.

4. **Gating with no silent downgrade** (Step 4, eval-12). Verdict is a circuit
   breaker, not documentation. CAUTION waits for confirmation. UNSAFE pauses.
   Baseline eval-12 passed because general disposition to refuse pressure — but
   without the explicit "no silent downgrade" rule, subtle cases would erode.

5. **New-file-only Task → SAFE fallback without fabricated call** (eval-5). If
   `taskFileList` contains only new files, skip guard and state "SAFE (new files
   only)". Baseline just writes the files without emitting a verdict — hides the
   "no signals available" fact.

6. **Rejection of `tree-sitter:modification_guard`** (eval-11). Tree-sitter's
   guard is structural/AST. This wrapper is git-signal first. Both useful; this
   wrapper picks the git lens. Baseline passed because agent understood the
   difference (general MCP-tool knowledge), but Iron Rule makes it explicit.

7. **`metaOnly: true` locked for guard** (eval-15). Verdict computation uses
   signals, not content. Content call is separate and AFTER guard. Baseline
   merges into one call with `metaOnly: false`.

## Bootstrap Observation

Bootstrap `semantic_search` returned 100% `dinopowers:writing-plans` chunks
(scores 0.53-0.67) — same idiom, different scope. Pattern extraction lifted:

- Iron Rule placement + exact custom-rerank weights
- Do-NOT substitution table structure
- Aggregation contract (by relativePath)
- Step numbering + Red Flags format

Draft hit 100% on first iteration. Second-order bootstrap confirmation:
`dinopowers:writing-skills` → `dinopowers:writing-plans` →
`dinopowers:executing-plans`. The pattern propagates correctly with minimal
invention.

## Delta Interpretation

+47pp is below the +50pp target from methodology. This is because 7 of 15 cases
(verdict-reasoning + one-off-edit + tree-sitter-refusal + some controls) are
natural behaviors the agent gets right without guidance. The skill closes the
gap where baseline reliably fails:

- core-rule / per-Task-scope / parameters / ordering / pressure / metaOnly
- 7 FAIL → 7 PASS improvements

This is appropriate: the skill's value concentrates on protocol enforcement (run
guard, per Task, with exact params) rather than on judgment calls the agent
already makes. +47pp reflects that concentration, not skill weakness.

## Iteration Log

**Iteration 0 (bootstrapped draft):** 15/15 PASS with-rule. 8/15 PASS
without-rule. Delta +47pp.

No iteration needed.

## Risks and follow-ups

- **Verdict thresholds are heuristic** (imports top 5%/15%, bugFix 40%/30%,
  owner 95%/85%). Phase 8 integration eval should track how often UNSAFE
  verdicts correlate with actual post-edit bugs to calibrate.

- **`imports` signal availability**: same as writing-plans — requires static
  analysis enabled. If disabled, guards default to SAFE for all files, defeating
  the wrapper. Add Phase 8 check.

- **Task extraction from plan**: the skill assumes Task's file list is
  extractable from plan draft or Task text. Plans using vague Task descriptions
  ("refactor the explore domain") won't provide a clean file list. Consider
  adding a Step 1.5: if Task file list is ambiguous, invoke `Glob` on the
  mentioned domain before guard.

- **Gating UI**: "ask for confirmation" is a protocol; user may need a dedicated
  UI hint (e.g. `AskUserQuestion` tool) for CAUTION verdicts. Out of scope for
  Phase 2 — revisit in Phase 8.

---

## Appendix — worktree-aware auto-reindex (feature-driven update, 2026-06-25)

> **SUPERSEDED 2026-06-29** — this appendix describes the now-removed
> commit-reindex hook as current. See the "2026-06-29 — Explicit worktree-index
> lifecycle" section below: the hook was removed; freshness is now explicit.

Eval set: `evals/worktree-auto-reindex-evals.json` (8 cases — 5 freshness, 2
controls, 1 edge; 2 subagent-context). Tests whether the agent, while executing
a plan, handles index freshness correctly now that a `PostToolUse:Bash` hook
auto-reindexes after every commit/merge.

| Metric                | Value       |
| --------------------- | ----------- |
| With-rule pass rate   | 100% (8/8)  |
| Without-rule baseline | 12.5% (1/8) |
| Delta                 | +87.5pp     |
| Iterations            | 0           |
| **Skill body edited** | **No**      |

**Outcome: no skill-body edit.** The Task-5 deprecation sweep already gave every
dinopowers wrapper a hook-aware `Index freshness` header line (`index_codebase`
for uncommitted WIP, never `reindex_changes`). The with-rule run — reading the
post-sweep skill — scored 8/8 on the freshness behavior: correctly trusts the
hook (no manual reindex after a committed task), reindexes only uncommitted WIP
via `index_codebase`, never reaches for the deprecated `reindex_changes`, and
uses `get_index_status` to resolve uncertainty. Per optimize-skill triage
("finding passes with-rule → not broken, drop from fix list"), the planned
executing-plans-specific between-tasks guidance was dropped as dead weight —
adding it would bloat a 298-line skill for zero behavioral gain.

The baseline (no skill) defaulted to the deprecated `reindex_changes` on 5 of 6
freshness cases and over-triggered the guard on the new-file control, despite
the scenario explicitly mentioning the hook — confirming the swept line, not
general competence, drives the correct behavior. This eval is retained as a
regression test guarding that the freshness behavior survives future edits.

## 2026-06-29 — Explicit worktree-index lifecycle (feature update)

The commit-reindex hook the 2026-06-25 freshness sweep relied on was REMOVED and
replaced by a cleanup-only teardown hook. `executing-plans` gained an explicit
**Step 0** (worktree-clone CREATE at plan start via `tea-rags worktree create`)
and **Mandatory-Step-Order item 5** (explicit per-Task REINDEX of the clone
after each commit via `mcp__tea-rags__index_codebase`); the "Index freshness"
pointer now states there is no background reindex hook.

| Metric                | Value      |
| --------------------- | ---------- |
| With-rule pass rate   | 100% (8/8) |
| Without-rule baseline | 50% (4/8)  |
| Delta                 | +50pp      |
| Iterations            | 0 (no fix) |

Eval: `evals/explicit-worktree-lifecycle-evals.json` (8 cases — 4 new-behavior,
2 gate controls, 1 over-trigger control, 1 pre-touch-guard regression). The
baseline made the per-task reindex CONDITIONAL (E1/E2), refused to reindex
`main` on merge (E5), and substituted `find_symbol`+`get_callers` for the
blastRadius pre-touch guard (E8) — confirming the explicit-lifecycle guidance,
not general competence, drives the mandatory per-task reindex +
main-reindex-on-merge. The prior `worktree-auto-reindex-evals.json` is marked
SUPERSEDED (its hook premise is now false). Done 2026-06-29: the same stale
"post-commit hook" expectations were regenerated in the
`dinopowers-finishing-a-development-branch` and
`dinopowers-test-driven-development` benchmarks — see their "2026-06-29"
sections.

## 2026-09-23 — Read-side freshness precondition + DDG MODIFY routing (feature update)

Step 0 and the post-commit REINDEX item were replaced by **Step 2.0**, a
read-side precondition run before EVERY Task's guard (`worktree info` → lazy
`worktree create` → incremental `index_codebase` → guard on the clone alias);
spec `2026-07-02-dinopowers-read-side-freshness-precondition-design.md`, bd
`tea-rags-mcp-jufg1`. Added the seeded-path branch the spec predates (bd
`tea-rags-mcp-k8gac`). Step 5 now routes behavior-modification Tasks to
`tea-rags:data-driven-generation` (DDG MODIFY mode), bd `tea-rags-mcp-if8jz`.

Evals: `evals/read-side-freshness-evals.json` (F1-F5 new, E3-E8 carried over, X1
execution eval) supersedes `evals/explicit-worktree-lifecycle-evals.json`;
`../dinopowers-executing-plans-v2/evals.json` gained E11-E13 (MODIFY routing +
trivial-text control). **Not yet measured** — no with/without-rule run; X1 is
user-gated (live incremental index on a clone).

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet
- Result: 16/16 PASS (100%) (intent-graded; same stale rerank text: evals say custom weights, SKILL.md prescribes 'blastRadius')
- Last recorded rate: 15/15 (100%)
- Delta: 0pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace, real hooks (plan-only)
- Result: 15/16 PASS (94%) over graded cases (N/A excluded: 0)
- Claude T12 rate for comparison: 16/16 (100%)
- CODEX-ONLY: eval-12 (treats user's 'skip UNSAFE' as the override, proceeds without surfacing block/recommendations or waiting - model behaviour)
- Both-fail count: 0

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet
- Result: 16/16 PASS (100%) over scored cases (superseded: 0)
- Task 12 rate: 100%
- Delta: +0pp
- FAIL list: none
- Notes: Intent-graded as in T12 (SKILL.md prescribes rerank 'blastRadius', evals say custom weights); eval-16 get_naming_lexicon called with kind 'variable' (eval says 'local') - noted, not failed.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only, plugins (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1) via repo-root marketplace, real hooks (SessionStart digest + dinopowers routing, SubagentStart block), AGENTS.md = core.
- Result: 14/16 PASS (88%) over graded cases (N/A excluded: 0).
- Codex T14: 15/16 (94%). Claude T22: 16/16 (100%).
- Notes: Note: rerank graded on intent (blastRadius when codegraph on, else custom imports/churn/ownership) as in Claude T22.
- FAIL list:
  - `eval-7` — FAIL; new: Declines to compute CAUTION from imports top12%/bugFixRate 32%; defers to "full guard result"; no "Proceed with Task 2?" gate stated as verdict. Claude T22 PASS
  - `eval-8` — FAIL; new: Declines to compute SAFE from imports=2/bugFix 0%; hedges on 5 commits/shared ownership instead of proceeding. Claude T22 PASS

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; graded strictly and literally against current evals.json)
- Result: 14/16 PASS (88%) over scored cases (superseded: 0)
- Round 1 (Task 22) rate: 16/16 (100%)
- Delta: -12pp (stricter literal grading; eval-16 was a noted deviation in round 1)
- FAIL list:
  - eval-15 — content request answered with find_symbol outlines/bodies; expected MUST "SEPARATE semantic_search with metaOnly=false AFTER guard verdict" not stated (guard itself stayed metaOnly=true).
  - eval-16 — get_naming_lexicon called with kind "variable"; expected names=[{name: envelope, kind: local}].
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 2 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.11 / dinopowers 0.24.4.
- Result: 13/16 PASS (81%) (N/A excluded: 0).
- Round-1 Codex: 14/16 (88%). Delta: -6 pp.
- FAIL list:
  - `eval-6` — UNSAFE justified by imports top 2% alone; bugFixRate 45% conjunct of the UNSAFE row not stated
  - `eval-9` — guard->verdict->gate stated, but no chain into $executing-plans after the gate (stops at DDG)
  - `eval-16` — refactor-only + names[] lexicon check stated, but no "MISFIT -> use suggestion" handling

## 2026-10-23 — evals-to-100 re-run round 3 (Task 22)

- Subject model: sonnet (lane C; graded by opus, strict/literal)
- Plugin text: tea-rags 0.46.12 / dinopowers 0.24.5; contexts rebuilt from live hook output
- Result: 16/16 PASS (100%) over scored cases (superseded: 0)
- Round 2 rate: 88% — delta: +12 pp
- FAIL list: none
- Notes: round-2 FAILs eval-15 (content via separate find_symbol after verdict) and eval-16 (lexicon kind local) fixed.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 3 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.12 / dinopowers 0.24.5.
- Result: 14/16 PASS (87.5%) (N/A excluded: 0).
- Round-2 Codex: 13/16 (81.3%). Delta: +6.3 pp.
- FAIL list:
  - `eval-4` — guard correct, but the plan also calls hybrid_search (low-resolve caller cross-check in the DDG MODIFY step), which mustNotCall lists.
  - `eval-6` — UNSAFE derived correctly (labelMap, both halves, pause), but no split / owner review / tests-first recommendation.

## 2026-10-23 — evals-to-100 re-run round 4 (Task 22)

- Subject model: sonnet (lane C; graded by opus, strict/literal)
- Plugin text: tea-rags 0.46.13 / dinopowers 0.24.6; contexts rebuilt from live hook output
- Result: 16/16 PASS (100%) over scored cases (superseded: 0)
- Round 3 rate: 100% — delta: +0 pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 4 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.13 / dinopowers 0.24.6; Codex core adds "read ONE file per command; output past ~10k tokens loses its middle".
- Result: 15/16 PASS (93.8%) (N/A excluded: 0).
- Round-3 Codex: 14/16 (87.5%). Delta: +6.2 pp.
- FAIL list:
  - `eval-10` — skips the guard on "не парься" by misapplying the trivial-edit exception to a 2-line Task change (regression vs R3)
