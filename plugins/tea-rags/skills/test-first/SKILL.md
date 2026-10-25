---
name: test-first
user-invocable: false
description:
  Agentic-only RED-phase skill — writes failing tests BEFORE implementation,
  from spec/plan acceptance criteria or given test code verbatim, else one test
  per behaviour of the task. Conventions from tests-as-context (fixture-lookup,
  assertion idioms of sibling tests). Runs them; each must fail for the RIGHT
  reason (assertion / missing behaviour) — import, compile, syntax,
  missing-fixture failures are not red. Modes CREATE/EXTEND, MODIFY behaviour
  (tests-at-risk green baseline first), refactor/move (baseline only, no new
  test), bug fix (reproduction first). Invoked by data-driven-generation Step
  6a. NOT user-invocable.
---

# test-first

RED phase. Output = recorded red, the gate GENERATE needs. No production code
here.

Lag / drift ≠ licence to leave tea-rags (core). Own checkout, `changedFiles` > 0
→ incremental `index_codebase`; subagent / linked worktree → never reindex. →
`tea-rags://guide/freshness`.

## Iron Rules

1. **Red before code.** No production edit until every new test ran + failed for
   right reason (bug fix: reproduction first). Code written first → delete,
   start from test.
2. **Right reason only.** Red = assertion failed, or behaviour/symbol under test
   missing (not-implemented, method absent on existing object). NOT red: import
   / module-resolution, compile / type, syntax error, missing fixture / setup
   file, runner config error, test not collected — e.g. `Cannot find module`,
   `is not defined` at import, `SyntaxError`, `ENOENT` on fixture. Harness
   failure → fix TEST harness (import path, fixture, setup), re-run; never count
   as red. CREATE, module / symbol not yet existing → stub (signature only, body
   throws not-implemented) so run reaches assertion; stub = scaffolding, not
   implementation.
3. **Source verbatim.** Spec / plan / task gives test code → byte-exact (adapt
   only import path), never own variant. Gives acceptance criteria → one test
   per criterion, criterion wording in test name. Neither → one test per
   behaviour task names.
4. **Tests immutable after red.** GREEN changes code, never test. Test genuinely
   wrong (contradicts spec, asserts impossible) → report contradiction to
   caller; never silently edit to pass.
5. **Cross-language.** Output names no runner, assertion library, package
   manager — "run the tests for these files", "the project's standard test
   command". Command from project context (scripts, Makefile, CI, README).

## Step 0 — Mode

Caller passes mode (data-driven-generation Step 0) + change kind:

| Change kind                         | New test                                        | Baseline                                                        |
| ----------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| CREATE / EXTEND                     | yes — one per behaviour, red                    | —                                                               |
| MODIFY, behaviour change            | yes — the new behaviour, red                    | `tests-at-risk` pins run FIRST, must be GREEN                   |
| refactor / move (behaviour-neutral) | NO                                              | `tests-at-risk` pins + target's own tests GREEN = the invariant |
| bug fix                             | yes — reproduction, red on the reported symptom | `tests-at-risk` pins GREEN                                      |

**Named exceptions only** (state ONE line, then skip RED):
`EXCEPTION no-tests — <language> has no recognised test files in this project`
or `EXCEPTION config-docs — change touches only config / docs, no behaviour`.
"Too small", "trivial", "hotfix", "time" are not exceptions.

## Step 1 — Baseline (MODIFY, refactor, bug fix)

`tea-rags:tests-as-context` recipe `tests-at-risk` (`affectedFiles` = target
files, `intent` = change description). Run those scenarios + target's own test
file BEFORE any edit.

- All green → baseline recorded.
- Red before your edit → pre-existing failure: report, don't fix silently, don't
  count as your red.
- Pin asserts OLD behaviour this task explicitly changes → becomes red test of
  new behaviour (expectation → spec, state `PIN-UPDATED <test> — <spec line>`).
  Other pins untouched.
- SKIP verdict → note "behaviour unpinned", run target's own tests only.

Refactor / move: baseline = whole RED output, no new test. Done → caller.

## Step 2 — Conventions

Before writing a test:

- `tea-rags:tests-as-context` recipe `fixture-lookup` (`intent` = setup needed)
  → reuse existing setup; never invent mock project already has. SKIP → proceed
  without.
- Assertion idiom + placement = target's sibling test file (or nearest test in
  same dir): same describe/naming shape, helpers. Reuse body in context; else
  `find_symbol(relativePath=<test file>)`.

## Step 3 — Write + run

1. Write tests per Iron Rule 3, placement from Step 2.
2. Run (project's standard test command, narrowed to these files).
3. Classify per Iron Rule 2. Harness failure → fix, re-run; max 3, then report
   blocker to caller.
4. New test PASSES before code → behaviour exists or test asserts nothing:
   tighten assertion or report "already implemented". Never ship never-red test.

## Step 4 — Output to caller

```text
RED <mode>/<change kind>
RED <test> — FAIL: <failure excerpt | [planned; not run]> — right reason: <assertion | stub>
BASELINE: <n> pins green | unpinned | pre-existing red: <test ids>
PIN-UPDATED <test> — <spec line>        (only when Step 1 rule fired)
EXCEPTION <kind> — <reason>             (only when Step 0 exception fired)
```

One `RED` line per new test — the only definition of that line. Plan-only /
not-yet-run answer still prints it, excerpt `[planned; not run]`, right reason =
the one the run must show; "I would run the test" without the line = RED not
done.

Caller (data-driven-generation 6b GREEN) implements until every listed test and
every baseline pin is green.
