# tea-rags:force-reindex Optimization Benchmark

**Date:** 2026-04-21 **Eval cases:** 10

| Metric    | Value        |
| --------- | ------------ |
| With-rule | 100% (10/10) |
| Baseline  | 80% (8/10)   |
| Delta     | +20pp        |

## Core Value

Destructive-op protocol wrapper. Requires explicit user confirmation via
AskUserQuestion, dispatches via background subagent (run_in_background=true)
because full reindex takes minutes, reports FULL result.

## Why Delta is Low (+20pp — Honest)

Baseline already handles 8/10 cases correctly because destructive-op caution is
a general agent instinct. Refusing auto-invocation on stale markers / schema
drift / corrupt-index heuristics, requiring confirmation even under time
pressure, stopping on Cancel, not confusing with incremental `/tea-rags:index` —
all these emerge from general safety culture without skill-specific guidance.

The skill's unique value concentrates on **2 technical protocol details** that
baseline doesn't know:

1. **Background subagent dispatch** (eval-2) — baseline calls
   `index_codebase(forceReindex=true)` directly in foreground; skill requires
   `Agent(run_in_background=true)` because full reindex takes minutes
2. **Foreground refusal** (eval-7) — baseline obliges user's "run in foreground"
   request; skill refuses because foreground blocks session for minutes while
   alias-switching achieves zero-downtime

These are technical protocol details (how to use the zero-downtime
alias-switching feature), not safety discipline.

## Delta Interpretation

+20pp is LESS than methodology target (+50pp), but matches the pattern of skills
that ride on top of already-strong baseline defaults. Comparable to
`dinopowers:executing-plans` (+47pp) where most safety was already present.
**This is not a weakness — it documents that the skill's marginal value is
narrow but specific.**

If the technical protocol changes (e.g. tea-rags drops zero-downtime
alias-switching, or foreground becomes acceptable), this skill becomes
redundant. The eval set flags exactly that risk.

## Failure Analysis (baseline, 2 FAIL)

| Case   | Failure mode                                          | Skill adds                                        |
| ------ | ----------------------------------------------------- | ------------------------------------------------- |
| eval-2 | Calls index_codebase(forceReindex=true) in foreground | Agent+run_in_background=true dispatch pattern     |
| eval-7 | Complies with user's "foreground" request             | Zero-downtime protocol + background-only dispatch |

## Iteration Log

**Iteration 0:** 10/10 with-rule, 8/10 baseline (80%), delta +20pp. No fix
needed — delta reflects the skill's narrow unique contribution.
