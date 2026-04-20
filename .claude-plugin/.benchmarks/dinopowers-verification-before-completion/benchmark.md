# dinopowers:verification-before-completion Optimization Benchmark

**Date:** 2026-04-20 **Skill created:**
`.claude-plugin/dinopowers/skills/verification-before-completion/SKILL.md`
**Eval cases:** 15

## Metrics

| Metric                | Value             |
| --------------------- | ----------------- |
| Lines (SKILL.md)      | 108               |
| Words (SKILL.md)      | 954               |
| With-rule pass rate   | 100% (15/15)      |
| Without-rule baseline | 13% (2/15)        |
| Delta                 | +87pp             |
| Iterations            | 1 (no fix needed) |

## Context

Seventh skill of `dinopowers`. Adds a collateral-damage scan BEFORE claiming
"done" — queries tea-rags impact signals (imports, churn, ownership) on files
edited in the session to surface high-blast-radius dependents that need
verification too.

**Core value**: same impact idiom as `writing-plans` / `executing-plans`
(`{imports: 0.5, churn: 0.3, ownership: 0.2}` custom rerank, brace-expanded
pathPattern over edited files, `metaOnly: true`), but applied post-edit to
inform the scope of verification. HIGH-BLAST → full suite; LOW-BLAST → targeted
tests.

## Key Design Decisions

1. **Same impact rerank idiom as writing-plans/executing-plans** (Step 2). Keeps
   blast-radius math comparable across plan authoring, plan execution, and
   pre-completion verification. Named presets (`codeReview`, `hotspots`) lack
   `imports` weight.

2. **Three-tier blast verdict** (HIGH/MEDIUM/LOW, Step 3) with concrete
   thresholds (top 10%/30% or >20/5-20/≤5 importers). Different from
   executing-plans' SAFE/CAUTION/UNSAFE: verification verdict informs SCOPE
   (which tests to run), not gating.

3. **Two distinct empty-result contracts** (Step 2+4):
   - Pure additive session (no `M` files) → `SAFE (no existing-file edits)` —
     skip scan
   - Edited files exist but scan returns empty →
     `UNVERIFIABLE (edited files not indexed)` — conservative full suite

4. **`tree-sitter:trace_impact` rejected as primary** (Common Mistakes).
   Structural call-graph analysis is complementary (AST usage), not blast-radius
   by git signals. Both useful; this wrapper is git-first.

5. **Verdict informs, doesn't gate** (Step 4). Unlike `executing-plans` where
   UNSAFE pauses, here HIGH-BLAST widens verification scope but doesn't block.
   The wrapper informs `superpowers:verification-before-completion` WHICH tests
   to run, never substitutes for the verification itself.

6. **Pressure resistance**: eval-9 (small change), eval-10 (isolated private
   method), eval-12 (deadline narrow scope) all tested. Baseline complies with
   all three pressures. Iron Rule at top + explicit "2-line change in high-blast
   = catastrophe" Red Flag resist.

## Delta Interpretation

+87pp is the highest delta among dinopowers wrappers so far. Baseline agents
default to "tests pass → done" without any collateral-damage consideration. Even
in pressure cases (eval-9, 10, 12), baseline complies with scope-narrowing
requests. The skill adds both protocol (run scan) AND resistance (refuse
narrowing).

## Bootstrap Observation

Same idiom lifted from `dinopowers:writing-plans` and
`dinopowers:executing-plans` — impact rerank weights, brace-expanded
pathPattern, aggregation by relativePath. Draft converged on first iteration.

## Iteration Log

**Iteration 0 (bootstrapped draft):** 15/15 PASS with-rule. 2/15 PASS
without-rule. Delta +87pp.

## Risks and follow-ups

- **`imports` signal dependency**: needs static trajectory enabled. Without it,
  all verdicts default to LOW-BLAST (imports=0), defeating the wrapper. Phase 8
  integration check.

- **Scope-narrowing under deadline pressure**: eval-12 passed by refusing
  narrowing. In real-world high-stakes releases, the user may legitimately need
  narrower scope — the skill should surface HIGH-BLAST block + let user decide
  with full information, NOT hold verification hostage. Current wording supports
  this; monitor for false-negative rigidity.

- **git diff detection accuracy**: Step 1 relies on `git status` or session
  tracking. If the agent's state doesn't match the actual working tree (e.g.
  stash-pop between sessions), the `editedFiles` list drifts. Consider requiring
  explicit agent self-report of changes instead of git inspection.
