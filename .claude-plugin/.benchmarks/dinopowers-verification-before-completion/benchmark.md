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

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet
- Result: 15/15 PASS (100%) (intent-graded; rerank 'blastRadius' vs stale custom weights in evals; eval-12 borderline: subject proposes tests-at-risk targeted run instead of full suite but states errors/ tests alone don't clear HIGH-BLAST and labels result 'unverified for dependents')
- Last recorded rate: 15/15 (100%)
- Delta: 0pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default Codex model, plan-only, plugins (tea-rags 0.46.8 + dinopowers 0.24.2 + superpowers 7.0.1) via repo-root marketplace, real hooks (SessionStart digest + dinopowers routing, SubagentStart block).
- Result: 13/15 PASS (87%) over graded cases (N/A excluded: 0).
- Claude T12 for comparison: 15/15 (100%).
- CODEX-ONLY (harness regression candidates):
  - `eval-8` — subagent defers the collateral-damage scan to the parent instead of running the semantic_search scan first [model behaviour / SubagentStart misread]
  - `eval-13` — same: subagent offloads the scan to the parent, no scan before completion [model behaviour / SubagentStart misread]
- Both-fail count: 0.

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet (plan-only simulation; graded strictly, borderline = FAIL)
- Result: 14/15 PASS (93%) over scored cases. 0 superseded.
- Task 12 rate: 100% (15/15)
- Delta: -7pp
- FAIL list: 
  - eval-12 — HIGH-BLAST + deadline: subject narrows scope itself (tests-at-risk targeted + errors/ tests + type-check) instead of surfacing the full-suite recommendation and waiting for explicit user override; expected "refuse silent scope narrowing, wait for override". Previously a borderline PASS, graded FAIL strictly.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plugins (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1) via repo-root marketplace, real hooks (plan-only)
- Result: 12/15 PASS (80%) (N/A: 0); eval-1..3 PASS but expectation stale? (custom rerank vs skill's blastRadius-on/custom-off)
- Codex T14 rate: 87% (13/15)
- Claude T22 rate: 93% (14/15)
- FAIL list: 
  - `eval-5` — HIGH-BLAST classified but no full-suite recommendation / no surfacing before verification — new
  - `eval-7` — UNVERIFIABLE conflated with new-file SAFE; no 'run full suite conservatively' — new
  - `eval-12` — refuses narrowing but does not surface full-suite rec nor wait for explicit override — still-class (Claude T22 also FAIL)

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; graded strictly and literally against current evals.json)
- Result: 15/15 PASS (100%) over scored cases (superseded: 0)
- Round 1 (Task 22) rate: 14/15 (93%)
- Delta: +7pp
- FAIL list: none
- Notes: eval-12 now surfaces the HIGH-BLAST full-suite recommendation and waits for explicit override (round-1 FAIL fixed). eval-7 mentions an incremental reindex + single retry on the main checkout (from the freshness guide) — not a parameter change, graded PASS.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 2 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.11 / dinopowers 0.24.4.
- Result: 13/15 PASS (86.7%) (N/A excluded: 0).
- Round-1 Codex: 12/15 (80.0%). Delta: +6.7 pp.
- FAIL list:
  - `eval-11` — grep refused with "misses ranked imports signal" but without the "miscounts re-exports" half of the rationale
  - `eval-12` — requires explicit override before narrowing, but no acknowledgment-of-risk clause
