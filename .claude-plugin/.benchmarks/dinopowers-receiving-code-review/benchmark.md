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
- Result: 14/14 PASS (100%) (intent-graded; cases 8/9/12 name no target: subject
  resolves target from PR context then runs the scan, else asks one question, no
  fabrication; rerank 'blastRadius' vs stale custom text)
- Last recorded rate: 12/12 (100%)
- Delta: 0pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default model, plan-only, plugins via repo-root
  marketplace, real hooks (SessionStart digest + dinopowers routing,
  SubagentStart block), AGENTS.md = core
- Result: 4/14 PASS (29%) over 14 graded cases (N/A: 0)
- Claude T12 for comparison: 14/14 (100%)
- Both-fail: 0
- CODEX-ONLY (10):
  - `eval-1` — plan uses find_symbol/get_callers/hybrid_search, never the Step 2
    semantic_search blastRadius scan or a verdict; wrapper SKILL.md not read
    before planning (model behaviour / AGENTS.md core tool tree wins)
  - `eval-3` — imports=89 given but no PUSHBACK verdict; asks which class
    instead of responding with impact data (wrapper ladder not applied)
  - `eval-4` — no AGREE-DIRECT verdict / single-commit; plans
    find_symbol+get_callers instead of the scan
  - `eval-5` — no AGREE-WITH-SCOPE verdict, no importer-list commitment; wrong
    tools
  - `eval-6` — uses get_callers + hybrid_search (explicit mustNotCall) instead
    of semantic_search impact rerank
  - `eval-7` — no UNVERIFIABLE verdict and no agree-direct; only asks which
    class
  - `eval-8` — does analysis but with get_callers/hybrid_search, not
    semantic_search per Iron Rule
  - `eval-9` — analysis via find_symbol/get_callers, not semantic_search impact
    scan
  - `eval-10` — refuses grep but substitutes hybrid_search instead of
    semantic_search with custom/blastRadius rerank
  - `eval-12` — no semantic_search impact scan first and no
    superpowers:receiving-code-review second

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet (plan-only simulation, blind)
- Result: 14/14 PASS (100%) over 14 scored cases (0 superseded); intent-graded
  on rerank 'blastRadius'
- Task 12 rate: 14/14 (100%)
- Delta: 0pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace
  (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1), real hooks
  (plan-only)
- Result: 13/14 PASS (93%) over 14 graded cases (N/A 0)
- Codex T14 for comparison: 4/14 (29%)
- Claude T22 for comparison: 14/14 (100%)
- FAIL list:
  - `eval-5` — FAIL ( still; Claude T22 PASS ) AGREE-WITH-SCOPE reached but no
    importer list / commitment to update all or justify partial; "no additional
    search needed"

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; graded strictly and
  literally against current evals.json)
- Result: 14/14 PASS (100%) over scored cases (superseded: 0)
- Round 1 (Task 22) rate: 14/14 (100%)
- Delta: +0pp
- FAIL list: none
- Notes: rerank graded literally (blastRadius, codegraph on) — compliant
  everywhere. eval-8/9/12 prompts name no target; subject keeps the Step 2 scan
  mandatory and asks one question for the target (or takes it from the thread)
  instead of agreeing/refusing — graded PASS.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 2 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.11
  / dinopowers 0.24.4.
- Result: 11/14 PASS (79%) (N/A excluded: 0).
- Round-1 Codex: 13/14 (93%). Delta: -14 pp.
- FAIL list:
  - `eval-4` — AGREE-DIRECT stated, "single-commit change" action not stated
  - `eval-13` — lexicon(names) called, but verdict rule (proposed
    MISFIT/NEW_TERM vs current CONFORMS -> push back with project term + holder)
    not stated
  - `eval-14` — review_changes(base main, sections naming) ok, but per-finding
    rules (MISFIT apply / COLLISION / NEW_TERM / conforming stay) not stated

## 2026-10-23 — evals-to-100 re-run round 3 (Task 22)

- Subject model: sonnet (lane C; graded by opus, strict/literal)
- Plugin text: tea-rags 0.46.12 / dinopowers 0.24.5; contexts rebuilt from live
  hook output
- Result: 11/14 PASS (79%) over scored cases (superseded: 0)
- Round 2 rate: 100% — delta: -21 pp
- FAIL list:
  - eval-1: FAIL — plans hybrid_search (fallback importer listing in Step 5),
    which is in mustNotCall | eval stale: SKILL.md Step 3 "Verdict name alone =
    incomplete" explicitly allows `get_callers` / `hybrid_search metaOnly:true`
    to fetch AGREE-WITH-SCOPE importers after Step 2
  - eval-6: FAIL — plans hybrid_search cross-check of importers (Step 4), which
    is in mustNotCall | eval stale: SKILL.md Step 3 "Verdict name alone =
    incomplete" allows `hybrid_search metaOnly:true` for importer fetch after
    Step 2 scan
  - eval-10: FAIL — refuses grep but declares "not a review comment, Iron Rule
    not triggered" and routes to find_symbol/get_callers/hybrid_search; Step 2
    semantic_search+blastRadius only conditional, not run anyway
- Notes: eval-1/eval-6 FAILs are eval-stale (mustNotCall hybrid_search vs
  SKILL.md Step 3 'Verdict name alone = incomplete', which allows hybrid_search
  metaOnly importer fetch after Step 2). eval-10 is a real FAIL (Iron Rule
  scope).
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 3 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.12
  / dinopowers 0.24.5.
- Result: 13/14 PASS (92.9%) (N/A excluded: 0).
- Round-2 Codex: 11/14 (78.6%). Delta: +14.3 pp.
- FAIL list:
  - `eval-13` — lexicon called for both names, but the "proposed MISFIT/NEW_TERM
    while current CONFORMS → push back with project term + holder" rule is not
    stated.

## 2026-10-23 — Codex re-run round 4 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.13
  / dinopowers 0.24.6; Codex core adds "read ONE file per command; output past
  ~10k tokens loses its middle".
- Result: 13/14 PASS (92.9%) (N/A excluded: 0).
- Round-3 Codex: 13/14 (92.9%). Delta: ±0.0 pp.
- FAIL list:
  - `eval-13` — Step 3b lexicon call made, but the "proposed MISFIT/NEW_TERM vs
    current CONFORMS -> push back with project term + holder" rule not applied

## 2026-10-23 — evals-to-100 re-run round 4 (Task 22)

- Subject model: sonnet (lane C; graded by opus, strict/literal)
- Plugin text: tea-rags 0.46.13 / dinopowers 0.24.6; contexts rebuilt from live
  hook output
- Result: 14/14 PASS (100%) over scored cases (superseded: 0)
- Round 3 rate: 79% — delta: +21 pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).
