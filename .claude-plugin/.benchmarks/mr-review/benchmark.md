# mr-review benchmark

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet (plan-only simulation, blind; graded by sonnet grader)
- Result: 2/3 PASS (67%)
- Last recorded with-skill rate: none recorded
- Delta: n/a (no prior with-skill run)
- FAIL:
  - `naming-diff-misfit` — uses review_changes sections naming, not get_naming_lexicon with names[] of diff identifiers | STALE
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default model, plan-only, plugins via repo-root marketplace, real hooks (SessionStart digest + dinopowers routing, SubagentStart block), AGENTS.md = core
- Result: 1/3 PASS (33%) over 3 graded cases (N/A: 0)
- Claude T12 for comparison: 2/3 (67%)
- Both-fail: 1 (naming-diff-misfit)
- CODEX-ONLY (1):
  - `naming-external-names` — calls review_changes with changes={base:main} on the main checkout for an external MR (mustNotDo), no names[] built from MR added lines; used $dino-requesting-code-review, could not read mr-review skill (skill naming / sandbox read failure)

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet (plan-only)
- Result: 2/2 PASS (100%) over 2 scored cases (superseded 1)
- Task 12 rate: 2/3 (67%); delta +33pp
- FAIL: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plugins (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1) via repo-root marketplace, real hooks (plan-only)
- Result: 0/2 PASS (0%) (N/A: 0)
- Codex T14 rate: 33% (1/3)
- Claude T22 rate: 100% (2/2)
- FAIL list: 
  - `naming-diff-changes` — naming not reported grouped by verdict, no conforming/novel summary line, naming section only implicit — new (borderline)
  - `naming-external-names` — review_changes changes={base} on main checkout for external MR, no names[] from added lines — still
