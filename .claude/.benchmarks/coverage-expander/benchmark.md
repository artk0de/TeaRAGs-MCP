# Coverage-Expander Benchmark — 2026-05-13

## Why this was run

User complaint: the `coverage-expander` subagent was slow, grep-heavy, and
ignored tea-rags. A real-session trace showed 4+ full `vitest run --coverage`
runs (≈30–90s each) + 8+ `Read` calls on `src/**/*.ts` + 6+ `bash | grep` /
`awk` pipelines parsing pretty-printed coverage tables. Zero `mcp__tea-rags__*`
calls.

Root cause: two divergent `coverage-expander.md` files existed
(`~/.claude/agents/` global vs `tea-rags-mcp/.claude/agents/` project), and the
global one was the older, grep-and-Read-heavy version. Neither version
hard-capped coverage runs or unambiguously banned `Read` on `src/`.

## Changes

| Area                                   | Before                                                          | After                                                                                  |
| -------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Coverage runs/invocation               | 3–4 (no cap; "go back to Step 2")                               | Exactly 2 (3 with one retry round, hard-capped)                                        |
| Parse coverage output                  | `\| grep "All files"` + `\| grep -E … \| awk … \| sort \| head` | `Read coverage/coverage-summary.json` (json-summary reporter) + optional one `jq` call |
| Understand source files                | `Read src/**/*.ts` for each target                              | `mcp__tea-rags__find_symbol` + `mcp__tea-rags__hybrid_search`                          |
| Early exit when already passing        | absent                                                          | first rule, before any coverage run                                                    |
| Hard cap on retries                    | none (unbounded loop)                                           | "Hard cap: 3 coverage runs total" stated twice                                         |
| Self-sufficient under subagent context | partial (relies on project CLAUDE.md "use tea-rags")            | yes — Hard rules 1–7 are stated inline                                                 |
| Lines                                  | 88 (project) / 100 (global)                                     | 141                                                                                    |

The skill grew (+~50 lines) because the new constraints needed explicit verbiage
— terse rules failed in subagent context where there is no CLAUDE.md fallback.
Eval (Case 5) confirms self-sufficiency.

## Key design decisions

1. **Two coverage runs, period.** The #1 source of latency was unnecessary
   coverage runs. Old skill prescribed a separate run for "find the gap" and
   another for "find worst offenders" — both produced the same data. New skill
   merges into one baseline run, parsed from JSON.
2. **JSON over grep.** `--coverage.reporter=json-summary` writes
   `coverage/coverage-summary.json` — a typed numeric shape. `Read` + in-head
   filter (or one `jq` call) replaces a 3-stage `grep|awk|sort` pipeline.
3. **tea-rags is mandatory for source comprehension.** Old skill never mentioned
   tea-rags. New skill enumerates exactly which tools to call (`find_symbol` for
   full body, `hybrid_search` with `pathPattern: "tests/**/*.test.ts"` for
   sibling patterns) and lists the four files where `Read` is still permitted
   (`coverage-summary.json`, `coverage-final.json`, `vitest.config.ts`, existing
   test files).
4. **Early-exit FIRST.** Moved before "Hard rules" so a passing-coverage caller
   triggers zero work, not "always run Step 1 anyway".
5. **Hard cap explicit, twice.** Once in Hard rules (#1), once at end of Step 5.
   Old skill's "go back to Step 2 and pick more files" had no cap — agents loop
   indefinitely.

## Eval results (5 cases × multiple assertions = 14 datapoints)

| Variant             | Pass  | %          | Δ vs baseline |
| ------------------- | ----- | ---------- | ------------- |
| NEW skill           | 14/14 | **100.0%** | **+100pp**    |
| OLD skill           | 1/14  | 7.1%       | +7pp          |
| Baseline (no skill) | 0/14  | 0.0%       | —             |

Per-case detail in `evals.json`. Subagent reports in
`workspace/iteration-1/{with_new_skill,with_old_skill,baseline_no_skill}_report.md`.

### Iteration table

| Iteration | NEW pass-rate | Notes                                              |
| --------- | ------------: | -------------------------------------------------- |
| 1         |  100% (14/14) | Reached target on first attempt; no Phase 5 needed |

## Files touched

- `.claude/agents/coverage-expander.md` — rewritten (88 → 141 lines)
- `.claude/CLAUDE.md` — added "## Automation Agents" section pointing parent
  sessions at this subagent for failing coverage hooks
- `.claude/.benchmarks/coverage-expander/{benchmark.md,evals.json,workspace/}` —
  this artefact set

## Follow-up (out of scope, noted)

- `~/.claude/agents/coverage-expander.md` (user-global) is still the stale,
  grep-heavy version. The project copy now takes precedence per Claude Code's
  agent-resolution order, but the global copy should be synced after the merge
  lands. Manual `cp` is sufficient — it is user-level, not git-managed.
- A future Phase 8 (end-to-end integration eval that actually runs the agent on
  a failing repo) could verify that the wall-clock improvement matches the
  static plan (predicted ~50% reduction in coverage-run time + elimination of
  src-file reads). Not run here because Phase 2 tool-selection eval already
  produces 100%.
