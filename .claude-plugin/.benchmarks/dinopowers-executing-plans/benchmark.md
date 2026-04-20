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
