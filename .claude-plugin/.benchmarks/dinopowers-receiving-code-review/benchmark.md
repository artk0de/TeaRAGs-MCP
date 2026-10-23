# dinopowers:receiving-code-review Optimization Benchmark

**Date:** 2026-04-20 **Eval cases:** 12

## Metrics

| Metric     | Value        |
| ---------- | ------------ |
| With-rule  | 100% (12/12) |
| Baseline   | 33% (4/12)   |
| Delta      | +67pp        |
| Iterations | 1            |

## Core Value

Before agreeing/pushing back on a review comment proposing structural change,
run tea-rags impact analysis with same `{imports:0.5, churn:0.3, ownership:0.2}`
idiom. Verdict ladder
AGREE-DIRECT/AGREE-WITH-SCOPE/PUSHBACK/PASS-THROUGH/UNVERIFIABLE. Replaces
performative agreement with data-backed response.

## Key Design

1. Stylistic nits pass through without scan (eval-2, eval-11) — keep the wrapper
   scoped to structural changes.
2. Defensive "no" needs data just like performative "yes" (eval-9) — both are
   rationalizations without impact analysis.
3. PUSHBACK verdict at imports>50 — mass renames warrant alternative proposals,
   not blind implementation.
4. AGREE-WITH-SCOPE mandates enumerating importers (eval-5) — agreement includes
   explicit scope commitment.

## Delta

+67pp. Baseline: pass-through nits (evals 2, 4, 7, 11) come naturally. Agent
fails at: data-backed pushback (3), scope enumeration (5), tool selection (1, 6,
10), pressure resistance (8, 9, 12).

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet
- Result: 14/14 PASS (100%) (intent-graded; cases 8/9/12 name no target: subject resolves target from PR context then runs the scan, else asks one question, no fabrication; rerank 'blastRadius' vs stale custom text)
- Last recorded rate: 12/12 (100%)
- Delta: 0pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default model, plan-only, plugins via repo-root marketplace, real hooks (SessionStart digest + dinopowers routing, SubagentStart block), AGENTS.md = core
- Result: 4/14 PASS (29%) over 14 graded cases (N/A: 0)
- Claude T12 for comparison: 14/14 (100%)
- Both-fail: 0
- CODEX-ONLY (10):
  - `eval-1` — plan uses find_symbol/get_callers/hybrid_search, never the Step 2 semantic_search blastRadius scan or a verdict; wrapper SKILL.md not read before planning (model behaviour / AGENTS.md core tool tree wins)
  - `eval-3` — imports=89 given but no PUSHBACK verdict; asks which class instead of responding with impact data (wrapper ladder not applied)
  - `eval-4` — no AGREE-DIRECT verdict / single-commit; plans find_symbol+get_callers instead of the scan
  - `eval-5` — no AGREE-WITH-SCOPE verdict, no importer-list commitment; wrong tools
  - `eval-6` — uses get_callers + hybrid_search (explicit mustNotCall) instead of semantic_search impact rerank
  - `eval-7` — no UNVERIFIABLE verdict and no agree-direct; only asks which class
  - `eval-8` — does analysis but with get_callers/hybrid_search, not semantic_search per Iron Rule
  - `eval-9` — analysis via find_symbol/get_callers, not semantic_search impact scan
  - `eval-10` — refuses grep but substitutes hybrid_search instead of semantic_search with custom/blastRadius rerank
  - `eval-12` — no semantic_search impact scan first and no superpowers:receiving-code-review second
