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
