# tea-rags:refactoring-scan Optimization Benchmark

**Date:** 2026-04-21 **Eval cases:** 14

| Metric    | Value        |
| --------- | ------------ |
| With-rule | 100% (14/14) |
| Baseline  | 36% (5/14)   |
| Delta     | +64pp        |

## Core Value

Multi-preset breadth-first scan that converges 3 rerank lenses (refactoring +
decomposition + hotspots) on the same scope, merges by symbolId into a 3-tier
ladder (3/3, 2/3, 1/3), enriches Tier 1 only with 5-type classification, and
outputs Tier 3 as count-only to keep the response budget bounded.

## Failure Analysis (baseline 9/14 FAIL)

1. **Multi-preset triangulation** (eval-1) — baseline runs ONE search, misses
   the convergence signal
2. **Tier framework** (eval-2) — baseline merges by eyeballing overlap instead
   of 3/3/2/3/1/3 counting
3. **Tier-1-only enrichment** (eval-3) — baseline "thorough" instinct enriches
   all tiers, blowing budget
4. **Tier 3 count-only output** (eval-6) — baseline shows the data instead of
   collapsing to count
5. **Execute-YOURSELF rule** (eval-7) — baseline delegates broad surveys to
   subagents
6. **metaOnly=false for ENRICH** (eval-9) — baseline defaults to metaOnly=true
   per token-safety rules, missing that classification needs content
7. **Search-cascade stop** (eval-10) — baseline uses round-number top-N cutoff
   instead of gradient-drop
8. **Specific-entity routing** (eval-13) — baseline inspects directly instead of
   routing single-entity to explore skill
9. **Post-search-validation** (eval-14) — baseline skips validation gate, jumps
   search-to-search

## Delta Interpretation

+64pp. Baseline handles obvious classifications (god function eval-4,
duplication eval-5) and some routing (bug-hunt eval-12, scoping eval-11). Skill
adds value specifically on:

- **Multi-signal convergence** protocol (3 presets not 1)
- **Tier ladder** structure (3/3/2/3/1/3 counting)
- **Budget discipline** (Tier 3 count-only, Tier 1-only enrichment)
- **Rule 0 / Rule 1 / Rule 4** — post-search-validation, self-execution,
  MCP-only search

## Iteration Log

**Iteration 0:** 14/14 with-rule, 5/14 baseline (36%), delta +64pp. No fix
needed.

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet (plan-only simulation, blind; graded by sonnet grader)
- Result: 13/15 PASS (87%)
- Last recorded with-skill rate: 100%
- Delta: -13pp
- FAIL:
  - `eval-6` — answer truncated after header; no Tier 1/2 tables or Tier 3
    count-only | REAL
  - `eval-14` — no post-search-validation (no-match detection + disambiguation)
    between presets | STALE
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace,
  real hooks (plan-only)
- Result: 13/15 PASS (87%) over graded cases (N/A excluded: 0)
- Claude T12 rate for comparison: 13/15 (87%)
- CODEX-ONLY: eval-12 (routes 'find bugs in reranker.ts' to explore +
  refactoring-scan instead of bug-hunt - model behaviour: missing-symptom
  reading)
- Both-fail count: 1

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet (plan-only simulation, blind)
- Result: 15/15 PASS (100%) over scored cases (superseded: 0)
- Task 12 rate: 13/15 (87%)
- Delta: +13pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only, plugins (tea-rags
  0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1) via repo-root marketplace,
  real hooks (SessionStart digest + dinopowers routing, SubagentStart block),
  AGENTS.md = core.
- Result: 15/15 PASS (100%) over graded cases (N/A excluded: 0).
- Codex T14: 13/15 (87%). Claude T22: 15/15 (100%).
- FAIL list: none
