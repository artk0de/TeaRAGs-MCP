# mr-review benchmark

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet (plan-only simulation, blind; graded by sonnet grader)
- Result: 2/3 PASS (67%)
- Last recorded with-skill rate: none recorded
- Delta: n/a (no prior with-skill run)
- FAIL:
  - `naming-diff-misfit` — uses review_changes sections naming, not get_naming_lexicon with names[] of diff identifiers | STALE
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).
