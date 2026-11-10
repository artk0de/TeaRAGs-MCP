# dinopowers:requesting-code-review Optimization Benchmark

**Date:** 2026-04-20 **Eval cases:** 12

| Metric    | Value        |
| --------- | ------------ |
| With-rule | 100% (12/12) |
| Baseline  | 25% (3/12)   |
| Delta     | +75pp        |

## Core Value

Before composing a review request, runs tea-rags bundle query on diff files and
constructs reviewer-context: per-file
ownership+contributors+commits+taskIds+bugFixRate + suggested reviewers by
expertise + coordinated-change context (shared taskIds) + risk flags. Distinct
from `receiving-code-review`: that computes a verdict; this builds metadata.

## Key Design

1. Custom `{imports, churn, ownership}` rerank (not named `ownership` preset
   alone) — single call returns all bundle inputs.
2. Bundle format is STRUCTURED metadata, not verdict; reviewers read it, they
   don't follow it.
3. taskIds are the highest-value signal for reviewers — never omit.
4. Large diff truncation at top-10 by imports (eval-12) keeps bundle readable.
5. Pure-deletion / empty / unindexed cases skip bundle with honest note — don't
   fabricate.

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet
- Result: 14/14 PASS (100%) (eval-13/14 re-asked once because the case context
  line was omitted from the subject prompt; after supplying it both passed.
  Note: the first answers were vague 'Flow F in full' without naming step)
- Last recorded rate: 12/12 (100%)
- Delta: 0pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace,
  real hooks (plan-only)
- Result: 14/14 PASS (100%) over graded cases (N/A excluded: 0)
- Claude T12 rate for comparison: 14/14 (100%)
- CODEX-ONLY: none
- Both-fail count: 0

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet (plan-only simulation, blind)
- Result: 13/13 PASS (100%) over scored cases (eval-13 superseded, not scored)
- Task 12 rate: 14/14 (100%)
- Delta: +0pp
- FAIL:
  - none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace
  (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1), real hooks
  (plan-only)
- Result: 12/13 PASS (92%) over 13 graded cases (eval-13 superseded, N/A 0)
- Codex T14 for comparison: 14/14 (100%)
- Claude T22 for comparison: 13/13 (100%)
- FAIL list:
  - `eval-3` — FAIL ( new (T14 PASS); Claude T22 PASS ) bundle omits "risk flags
    for reviewer attention" (has table, reviewers, coordinated-change); also no
    contributors column named

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; graded strictly and
  literally against current evals.json)
- Result: 13/13 PASS (100%) over scored cases (superseded: 1 — eval-13, not
  given, not scored)
- Round 1 (Task 22) rate: 13/13 (100%)
- Delta: +0pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 2 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.11
  / dinopowers 0.24.4.
- Result: 11/13 PASS (84.6%) (N/A excluded: 0).
- Round-1 Codex: 12/13 (92.3%). Delta: -7.7 pp.
- FAIL list:
  - `eval-3` — bundle sections named (owners/contributors, reviewers, task
    context, risk flags) but per-file table omits commits+age and taskIds
    columns
  - `eval-14` — review_changes call + MISFIT/COLLISION/NEW_TERM handling right,
    but bundle findings not listed with relPath:line and novel count not given
    (only conforming 11)

## 2026-10-23 — evals-to-100 re-run round 3 (Task 22)

- Subject model: sonnet (lane C; graded by opus, strict/literal)
- Plugin text: tea-rags 0.46.12 / dinopowers 0.24.5; contexts rebuilt from live
  hook output
- Result: 11/13 PASS (85%) over scored cases (superseded: 1)
- Round 2 rate: 100% — delta: -15 pp
- FAIL list:
  - eval-1: FAIL — mustNotCall 'hybrid_search' hit: plan inherits the
    common-preamble Step 2.5 conditional "cross-check with
    hybrid_search(metaOnly) if resolve rate low" | eval stale: context-main.md
    (line 46, "Empty get_callers at low resolve rate ≠ no callers — cross-check
    hybrid_search") now mandates that caller cross-check; the eval's ban targets
    hybrid_search as the bundle query, not the Step 2.5 caller fallback
  - eval-4: FAIL — mustNotCall 'hybrid_search' hit: "Steps 2.5/2.6/3a as common"
    pulls in the conditional hybrid_search caller cross-check | eval stale: same
    as eval-1 (context-main.md line 46 cross-check rule vs. eval's blanket
    hybrid_search ban)
- Notes: Both FAILs eval-stale: blanket mustNotCall hybrid_search vs
  context-main.md caller cross-check rule ('Empty get_callers at low resolve
  rate != no callers - cross-check hybrid_search'); the eval targets
  hybrid_search as the bundle query. Superseded eval-13 not given/scored.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 3 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.12
  / dinopowers 0.24.5.
- Result: 11/13 PASS (84.6%) (N/A excluded: 0).
- Round-2 Codex: 11/13 (84.6%). Delta: ±0.0 pp.
- FAIL list:
  - `eval-3` — lists data fields only; no per-file table, suggested reviewers,
    coordinated-change context or risk flags.
  - `eval-14` — skips the Step 2.6 review_changes call (treats findings as
    supplied); findings not grouped by verdict with relPath:line.

## 2026-10-23 — Codex re-run round 4 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.13
  / dinopowers 0.24.6; Codex core adds "read ONE file per command; output past
  ~10k tokens loses its middle".
- Result: 12/13 PASS (92.3%) (N/A excluded: 0).
- Round-3 Codex: 11/13 (84.6%). Delta: +7.7 pp.
- FAIL list:
  - `eval-14` — skips the Step 2.6 review_changes {base: main} sections
    ["naming"] call (treats findings as supplied); findings not listed with
    relPath:line

## 2026-10-23 — evals-to-100 re-run round 4 (Task 22)

- Subject model: sonnet (lane C; graded by opus, strict/literal)
- Plugin text: tea-rags 0.46.13 / dinopowers 0.24.6; contexts rebuilt from live
  hook output
- Result: 13/13 PASS (100%) over scored cases (superseded: 1)
- Round 3 rate: 85% — delta: +15 pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-11-10 — Codex run (Task 14, current package)

- Subject: Codex CLI 0.167.0, default model (gpt-6.1-sol), plan-only, plugins
  (tea-rags 0.55.12 + core-hook fix 3fa4a4a42 + dinopowers 0.25.3 + superpowers
  7.0.2) via repo-root marketplace, real hooks; one run, all cases in one
  prompt; graded by subagent strict against expected/failure_mode with Codex
  tool-name mapping.
- Result: 3/14 PASS (21%) over graded cases (N/A excluded: 0).
- Claude T12 for comparison: Result: 14/14 PASS.
- 2026-10-23 Codex run (0.162.1, plugin 0.46.8): 14/14 (100%).
- REGRESSION CANDIDATES (pass Claude T12, fail Codex; 11): eval-2, eval-3,
  eval-4, eval-5, eval-6, eval-7, eval-8, eval-9, eval-11, eval-12, eval-13.
- FAIL digest:
  - `eval-2` — git-bundle parameters entirely absent: no codegraph-dependent
    rerank (blastRadius/custom), no pathPattern bracing the 5 files, no
  - `eval-3` — Bundle format not described: no per-file
    owner/contributors/commits+age/taskIds table, no suggested reviewers, no
    taskId coordinat
  - `eval-4` — Plans rank_chunks rerank='ownership'+'hotspots' instead of the
    semantic_search impact rerank; rerank='ownership' alone is the name
  - `eval-5` — Loads the dino wrapper for an empty diff instead of skipping it;
    no direct superpowers:requesting-code-review invocation (bundle f
  - `eval-6` — Builds a bundle for the three deleted files (explicit mustNotDo)
    instead of skipping the wrapper and invoking superpowers:requesti
  - `eval-7` — Builds a partial bundle (plus incremental reindex) instead of
    skipping the bundle and invoking superpowers:requesting-code-review
  - `eval-8` — Complies with the skip-bundle pressure: enrichment/bundle
    omitted, no semantic_search anyway (bundle enables pair-matching)
  - `eval-9` — Refuses git blame but substitutes rank_chunks(rerank:ownership) /
    semantic_search(rerank:bugHunt) instead of the Step-2 impact rer
  - … 3 more in verdicts file
