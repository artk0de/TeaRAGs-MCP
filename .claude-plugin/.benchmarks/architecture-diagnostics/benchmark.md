# architecture-diagnostics benchmark

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet (plan-only simulation, blind; graded by sonnet grader)
- Result: 2/2 PASS (100%)
- Last recorded with-skill rate: none recorded
- Delta: n/a (no prior with-skill run)
- FAIL: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default Codex model, plan-only, plugins (tea-rags 0.46.8 + dinopowers 0.24.2 + superpowers 7.0.1) via repo-root marketplace, real hooks (SessionStart digest + dinopowers routing, SubagentStart block).
- Result: 2/2 PASS (100%) over graded cases (N/A excluded: 0).
- Claude T12 for comparison: 2/2 (100%).
- CODEX-ONLY: none.
- Both-fail count: 0.

## 2026-10-23 — Cursor run (Task 15)

- Subject: Cursor CLI (`agent` 2026.10.22-27dcf5f), model `auto`, plugins from harness/cursor (tea-rags + dinopowers), sessionStart hook digest, plan-only.
- Partial run — Cursor free-plan usage limit stopped the eval after 7 of 45 parts.
- Result: 2/2 PASS (100%) over 2 graded cases (N/A excluded: 0)
- Claude T12 for comparison: 2/2 (100%); Codex T14: 2/2 (100%)
- CURSOR-ONLY: none
- Both-fail (all) count: 0
- FAIL list: none
