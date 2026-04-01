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
