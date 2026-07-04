---
name: expand-coverage
user-invocable: false
description:
  Agent-only. Raise test coverage above a failed pre-commit threshold: locate the
  EXACT uncovered branches via tea-rags, write high-level behavioral tests, never
  chase lines. Invoked by the `coverage-expander` sub-agent on pre-commit
  "Coverage for <metric> (X%) does not meet global threshold (Y%)".
  Reindex-if-stale local main before search so corner-case discovery sees current
  source. NOT for general test authoring — only closing a measured coverage gap.
---

# Expand Coverage

Raise coverage above threshold via high-level behavioral tests hitting the exact
uncovered branches. Never chase lines. tea-rags finds WHAT is untested; you
write scenarios.

Runs in a **background agent** — fully autonomous, no interactive questions; the
final report (below) is the handoff.

## Early exit

Coverage above ALL thresholds → report, stop.

## Hard rules (NON-NEGOTIABLE)

1. Coverage runs ≤ 2 (baseline + verify). Cap 3 (one retry). Past cap → stop,
   report. Full run 30–90s = top slowness source.
2. NEVER `grep`/`awk`/`sed` coverage stdout. Parse the coverage JSON.
3. NEVER `Read` `src/`. Use `find_symbol` (full body) + `hybrid_search`. `Read`
   ONLY: `coverage/coverage-summary.json`, `coverage/coverage-final.json`,
   `vitest.config.ts`, `package.json`, test files you extend.
4. Write test files under `tests/` ONLY. Never touch prod code, configs,
   thresholds.
5. MIRROR `src/`→`tests/` EXACT.
   `src/core/foo/bar.ts`→`tests/core/foo/bar.test.ts`. No bucket dirs
   (`tests/coverage-fill/`, `tests/gaps/`, `tests/uncovered/`). Existing test
   file → `Edit` append.
6. NEVER add `v8 ignore`/`eslint-disable`/`c8 ignore` to prod.
7. NEVER rewrite passing tests. Append only.
8. NEVER lower a threshold.
9. NEVER commit — parent commits.

## Step 0: Freshness gate (before ANY tea-rags call)

Commit under test just changed `src/` → local-main index lags → search misses
new code, corner-case discovery fails silently.

- Target local main alias (`list_projects`/prime). Never a stale worktree clone.
- `index_codebase` incremental, `project: <main-alias>` — silent, no consent
  (see `.claude-plugin/tea-rags/rules/index-freshness.md`).
- Skip ONLY if prime shows index fresh AND no `src/` written this session.

## Step 1: Baseline (ONE coverage run)

Config emits `json`/`lcov`/`html` only — request summary + final maps:

```bash
npm run test:coverage -- --run \
  --coverage.reporter=json-summary --coverage.reporter=json 2>&1 | tail -25
```

- `json-summary` → `coverage/coverage-summary.json` (per-file %).
- `json` → `coverage/coverage-final.json` (hit maps = exact uncovered lines).

`Read` summary → `total.*.pct`. `Read` `vitest.config.ts` `coverage.thresholds`
(they drift — statements overridden below 96.9).

## Step 2: Pick targets (JSON, no grep)

One `jq` over summary (NEVER a grep pipeline):

```bash
jq '[to_entries[] | select(.key != "total")
  | select(.value.statements.pct < 100)
  | {file: .key,
     impact: (.value.statements.total - .value.statements.covered),
     pct: .value.statements.pct}]
  | sort_by(-.impact) | .[0:4]' coverage/coverage-summary.json
```

Top 2–4 below-threshold files by `impact` (uncovered statements).

## Step 3: Locate uncovered branches, understand them (tea-rags only)

Find the EXACT untested behavior — never guess from the whole file.

1. **Uncovered map** — `Read` `coverage/coverage-final.json`, find target by
   path. `statementMap`+`s`, `branchMap`+`b`, `fnMap`+`f` with hit `0` → exact
   uncovered ranges = the corner cases.
2. **Understand** — `find_symbol` enclosing fn/class → full body. Map each range
   to the behavior it guards: error path, null/empty guard, boundary, `catch`,
   early return.
3. **Patterns** — `hybrid_search` `pathPattern: "tests/**/*.test.ts"`, `query` =
   module → existing test, mocks, assertion style.
4. **Neighbors** — `find_similar` target symbolId → how nearby modules test the
   same branch shape; lift proven scenarios.
5. **Callers** — `get_callers` target → real inputs reaching the branch (a
   corner case often reachable through one caller only).

Each uncovered branch → one behavioral scenario. Dead/unreachable branch →
report it, do NOT fabricate a test.

## Step 4: Write tests

- One behavioral scenario per test. End-to-end, not single-line drills.
- Mirror `src/`→`tests/` EXACT (rule 5). Existing file → `Edit` append.
- Reuse Step-3 mocks/helpers.
- `import { describe, expect, it, vi, beforeEach } from "vitest"`.

**Good**: `"should propagate ConnectionRefused through the ingest pipeline"`
**Bad**: `"should execute line 142"`

## Step 5: Verify (ONE coverage run)

Re-run the Step 1 command once. `Read` summary, compare `total.*.pct` to
thresholds.

- Pass → done.
- Below → ONE retry (different target, Steps 3–4, re-run). Cap 3 runs. Past cap
  → stop, report. Never lower thresholds.

## Output

```text
Coverage before: statements=X.XX% functions=Y.YY% lines=Z.ZZ% branches=W.WW%
Coverage after:  statements=X.XX% functions=Y.YY% lines=Z.ZZ% branches=W.WW%
Thresholds:      statements=A.AA% functions=B.BB% lines=C.CC% branches=D.DD%
Status:          PASS | FAIL

Files added/modified:
- tests/path/to/file.test.ts — N new tests (scenarios: X, Y, Z)
- ...

Reindex: <incremental | skipped-fresh>
Coverage runs: 2 (or 3 if retry used)
```
