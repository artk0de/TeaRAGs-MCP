# tea-rags:data-driven-generation Optimization Benchmark

**Date:** 2026-04-21 **Eval cases:** 15

## Metrics

| Metric     | Value        |
| ---------- | ------------ |
| With-rule  | 100% (15/15) |
| Baseline   | 20% (3/15)   |
| Delta      | +80pp        |
| Iterations | 1            |

## Why this skill matters

`data-driven-generation` owns **the impact-analysis idiom**
`{imports:0.5, churn:0.3, ownership:0.2}` that propagates to 5 dinopowers
wrappers (writing-plans, executing-plans, verification-before-completion,
receiving-code-review, requesting-code-review). Eval-12 explicitly tests the
exact weights — if they drift here, downstream wrappers silently lose their
calibration.

Similarly, Step 2's proven-template weights
`{similarity:0.2, stability:0.3, age:0.3, bugFix:-0.15, ownership:-0.05}` are
the template-discovery idiom referenced by `dinopowers:test-driven-development`
(+80pp delta) and future skills.

## Failure Analysis (baseline, 12/15 FAIL)

Baseline agent handles 3 cases correctly (eval-5 autonomous judgment, eval-7
reject bad template, eval-10 shared-style). Fails on everything requiring:

1. **Named strategies** (eval-2, 3, 4) — general "be careful" vs protocol-named
   DEFENSIVE/STABILIZATION/CONSERVATIVE mapping from overlay labels
2. **Exact custom-rerank weights** (eval-6, 12) — baseline picks closest named
   preset (`proven`, `hotspots`) instead of constructing
   `{similarity:0.2, stability:0.3, age:0.3, bugFix:-0.15, ownership:-0.05}`
   with negative coefficients
3. **Non-intuitive quality gates** (eval-8) — baseline bias `new=good` defeats
   the `recent+low-commits=unproven` rule
4. **Mandatory Step 5 hallucination protocol** (eval-11, 13, 14) — baseline
   trusts tests+tsc, skips find_symbol-per-identifier verification as overkill
5. **Project-aware custom-strategy discovery** (eval-15) — baseline applies hard
   rules directly, misses `.claude/skills/strategy-*` scan
6. **Prerequisites/explore-first** (eval-1) — baseline starts with
   semantic_search instead of invoking the explore skill as formal
   area-gathering step
7. **Silo-style protocol** (eval-9) — baseline understands silo but doesn't
   invoke exact-match convention

## Delta Interpretation

+80pp is strong. The skill adds value specifically on:

- **Formalized protocol** (named strategies + numbered steps) — not derivable
  from general competence
- **Exact weights** — project idiom cannot be guessed
- **Mandatory Step 5** — overcomes the "tests pass = done" default
- **Custom-strategy discovery** — project-aware extension point

## Iteration Log

**Iteration 0:** 15/15 with-rule, 3/15 baseline (20%), delta +80pp. No fix
needed.

## Risks and follow-ups

- **Idiom weights drift**: evals 6 and 12 are regression tests for the two idiom
  weight sets. Any SKILL.md edit that touches Step 2 or Step 6 weights must
  re-run these eval cases.
- **Strategy files coverage**: 4 strategies (DEFENSIVE, STABILIZATION,
  CONSERVATIVE, STANDARD) live in `strategies/*.md` — each could have its own
  eval for signal-mapping behavior inside the strategy. Out of scope for
  Phase 2.
- **Step 5 MANDATORY under pressure**: eval-13 passes with-rule but real-world
  pressure ("hotfix, be fast") may erode. Consider adding a hotfix-pressure eval
  case.
