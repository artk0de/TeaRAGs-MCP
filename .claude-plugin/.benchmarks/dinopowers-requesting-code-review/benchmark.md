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
- Result: 14/14 PASS (100%) (eval-13/14 re-asked once because the case context line was omitted from the subject prompt; after supplying it both passed. Note: the first answers were vague 'Flow F in full' without naming step)
- Last recorded rate: 12/12 (100%)
- Delta: 0pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace, real hooks (plan-only)
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
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1), real hooks (plan-only)
- Result: 12/13 PASS (92%) over 13 graded cases (eval-13 superseded, N/A 0)
- Codex T14 for comparison: 14/14 (100%)
- Claude T22 for comparison: 13/13 (100%)
- FAIL list:
  - ` eval-3 ` — FAIL ( new (T14 PASS); Claude T22 PASS ) bundle omits "risk flags for reviewer attention" (has table, reviewers, coordinated-change); also no contributors column named 

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; graded strictly and literally against current evals.json)
- Result: 13/13 PASS (100%) over scored cases (superseded: 1 — eval-13, not given, not scored)
- Round 1 (Task 22) rate: 13/13 (100%)
- Delta: +0pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 2 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.11 / dinopowers 0.24.4.
- Result: 11/13 PASS (84.6%) (N/A excluded: 0).
- Round-1 Codex: 12/13 (92.3%). Delta: -7.7 pp.
- FAIL list:
  - `eval-3` — bundle sections named (owners/contributors, reviewers, task context, risk flags) but per-file table omits commits+age and taskIds columns
  - `eval-14` — review_changes call + MISFIT/COLLISION/NEW_TERM handling right, but bundle findings not listed with relPath:line and novel count not given (only conforming 11)
