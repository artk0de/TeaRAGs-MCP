# coverage-expander optimization — 2026-04-01

## Summary

The coverage-expander agent was actively hurting agent behavior — hardcoded
`npx vitest` commands, awk/grep pipelines for file discovery, Read-based code
exploration, and double test runs. After optimization, all operations use
`npm run test:coverage` and tea-rags MCP tools.

## Changes

| #   | Change                                                                      | Why                                                   | Eval      |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------- | --------- |
| 1   | `npx vitest run --coverage` → `npm run test:coverage`                       | Project has npm script; raw npx is fragile            | 1,3,8,10  |
| 2   | Removed awk/grep pipeline for file discovery                                | tea-rags hybrid_search replaces shell parsing         | 1,5,8,9   |
| 3   | Read source/test files → tea-rags find_symbol + hybrid_search               | Search results contain code, Read is redundant        | 2,4,5,8,9 |
| 4   | Two verification runs → single `npm run test:coverage`                      | One command checks pass/fail AND coverage             | 3,5,8     |
| 5   | Added `hybrid_search` with `pathPattern: "**/*.test.ts"` for test discovery | Finds existing tests, mocks, patterns in one call     | 4,5,8,9   |
| 6   | Added early exit guard                                                      | Agent should stop if coverage already above threshold | 7         |
| 7   | Removed "Test patterns" section                                             | Duplicated CLAUDE.md test-patterns.md rule            | —         |

## Metrics

- **Lines**: 101 → 68 (-33%)
- **Iterations**: 1 (all cases passed on first fix)

## Eval results

| Iteration  | With-rule    | Baseline     | Delta |
| ---------- | ------------ | ------------ | ----- |
| 0 (before) | 1/10 (10%)   | 10/10 (100%) | -90pp |
| 1 (after)  | 10/10 (100%) | 10/10 (100%) | 0pp   |

## Per-eval detail

| Eval | Type     | Before | After | Finding    |
| ---- | -------- | ------ | ----- | ---------- |
| 1    | audit    | FAIL   | PASS  | 1, 2       |
| 2    | audit    | FAIL   | PASS  | 3          |
| 3    | audit    | FAIL   | PASS  | 4          |
| 4    | audit    | FAIL   | PASS  | 5          |
| 5    | audit    | FAIL   | PASS  | 2, 3, 4    |
| 6    | control  | PASS   | PASS  | —          |
| 7    | control  | FAIL   | PASS  | early exit |
| 8    | subagent | FAIL   | PASS  | 1-5        |
| 9    | subagent | FAIL   | PASS  | 2, 3, 5    |
| 10   | edge     | FAIL   | PASS  | —          |

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet (plan-only simulation, blind; graded by sonnet grader)
- Result: 7/10 PASS (70%)
- Last recorded with-skill rate: 100%
- Delta: -30pp
- FAIL:
  - `eval-3` — plan does baseline run + verify run (two coverage runs) where
    expectation demands a single run | STALE
  - `eval-5` — plan uses baseline run + run 2 (+ possible run 3) where
    expectation demands a single coverage run | STALE
  - `eval-9` — plan uses baseline run + verify run where expectation says single
    npm run test:coverage | STALE
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default Codex model, plan-only, plugins (tea-rags
  0.46.8 + dinopowers 0.24.2 + superpowers 7.0.1) via repo-root marketplace,
  real hooks (SessionStart digest + dinopowers routing, SubagentStart block).
- Result: N/A — all 10 cases not graded: coverage-expander is an agent, not a
  skill shipped to Codex. Graded 0 (N/A 10).
- Claude T12 for comparison: 7/10 (70%).
- CODEX-ONLY: none.
- Both-fail count: 0.

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet (plan-only; agent def + expand-coverage skill)
- Result: 9/10 PASS (90%) over 10 scored cases (superseded 0)
- Task 12 rate: 7/10 (70%); delta +20pp
- FAIL:
  - `eval-9` — plan keeps coverage JSON as the source for uncovered areas and
    uses semantic_search only as a fallback; expected semantic_search scoped by
    pathPattern to the trajectory domain (borderline, graded FAIL)
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plugins (tea-rags 0.46.10 +
  dinopowers 0.24.3 + superpowers 7.0.1) via repo-root marketplace, real hooks
  (plan-only)
- Result: not graded — 10/10 N/A (agent/expand-coverage not shipped to Codex)
- Codex T14 rate: N/A (10/10)
- Claude T22 rate: 90% (9/10)
- FAIL list: none

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only; agent def + expand-coverage skill; graded
  strict-literal)
- Result: 8/10 PASS (80%) over 10 scored cases (superseded 0)
- Baseline (round 1, Task 22): 9/10 (90%)
- Delta: -10pp
- FAIL list:
  - `eval-3` — plan runs baseline + verify coverage but states no targeted
    vitest run of the changed test files between them (expected MUST step); the
    skill's flow, which the subject treats as overriding the agent def, has no
    such step
  - `eval-9` — plan follows the prompt and issues semantic_search ("untested
    error/empty/boundary paths") to map uncovered areas; expected explicitly
    rejects semantic_search for uncovered-area discovery (it cannot see
    coverage)
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — evals-to-100 re-run round 3 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; no per-case length cap;
  graded strict-literal against the current evals.json); agent def +
  expand-coverage skill
- Result: 9/10 PASS (90%) over 10 scored cases (superseded 0)
- Baseline (round 2, Task 22): 80% (8/10)
- Delta: +10pp
- FAIL list:
  - `eval-5` — named 0%-coverage file treated as "prime target" but the plan
    still runs the Step 2 project-wide jq worst-offender ranking ("I confirm via
    the jq/summary") instead of targeting the named file directly;
    expand-coverage SKILL.md Step 2 has no named-target branch
- Note: eval-3 (targeted vitest run between baseline and verify) and eval-9
  (semantic_search rejected for uncovered-area discovery) now pass.
- Context: new SessionStart core+digest / SubagentStart block (rebuilt from live
  hook output); plugins tea-rags 0.46.12 / dinopowers 0.24.5; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — evals-to-100 re-run round 4 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; no per-case length cap;
  graded strict-literal against the current evals.json); agent def +
  expand-coverage skill
- Result: 10/10 PASS (100%) over 10 scored cases (superseded 0)
- Baseline (round 3): 9/10 (90%)
- Delta: +10pp (eval-5 fixed — named target taken directly, jq ranking skipped)
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block (tea-rags 0.46.13
  / dinopowers 0.24.6, rebuilt from live hook output); old plugin hook text
  present in subject context but declared void (limitation).
