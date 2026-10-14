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

## Iron Rules

1. **Red before code.** No production edit until every new test ran and failed
   for the right reason. Code written first → delete it, start from the test.
2. **Right reason only.** Red = assertion failed, or behaviour/symbol under test
   missing (not-implemented, method absent on an existing object). NOT red:
   import / module-resolution error, compile / type error, syntax error, missing
   fixture or setup file, test-runner config error, test not collected. Harness
   failure → fix the TEST harness (import path, fixture, setup), re-run. Never
   count it as red. CREATE, module / symbol not yet existing → declare it as a
   stub (signature only, body throws not-implemented) so the run reaches the
   assertion; the stub is scaffolding, not implementation.
3. **Source verbatim.** Spec / plan / task gives test code → use it byte-exact
   (adapt only the import path to the real module). Gives acceptance criteria →
   one test per criterion, criterion wording in the test name. Neither → one
   test per behaviour the task names.
4. **Tests immutable after red.** GREEN changes code, never the test. Test
   genuinely wrong (contradicts spec, asserts impossible) → report it to the
   caller with the contradiction; never edit it silently to pass.
5. **Cross-language.** Output names no runner, assertion library or package
   manager — "run the tests for these files", "the project's standard test
   command". Command comes from project context (scripts, Makefile, CI, README).

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
files, `intent` = change description). Run those scenarios + the target's own
test file BEFORE any edit.

- All green → baseline recorded.
- Already red before your edit → pre-existing failure: report it, do not fix it
  silently, do not count it as your red.
- Pin asserts the OLD behaviour this task explicitly changes → that pin becomes
  a red test of the new behaviour (update its expectation to the spec, state
  `PIN-UPDATED <test> — <spec line>`). Any other pin stays untouched.
- SKIP verdict → note "behaviour unpinned", run the target's own tests only.

Refactor / move: baseline is the whole RED output. Done — go to caller.

## Step 2 — Conventions

Before writing a test:

- `tea-rags:tests-as-context` recipe `fixture-lookup` (`intent` = setup you
  need) → reuse existing setup; never invent a mock the project already has.
  SKIP verdict → proceed without.
- Assertion idiom + file placement = the target's sibling test file (or nearest
  test in the same directory): same describe/naming shape, same helpers. Reuse a
  body already in context; else `find_symbol(relativePath=<test file>)`.

## Step 3 — Write + run

1. Write tests per Iron Rule 3, in the placement from Step 2.
2. Run them (the project's standard test command, narrowed to these files).
3. Classify each failure per Iron Rule 2. Harness failure → fix harness, re-run.
   Max 3 harness re-runs, then report the blocker to the caller.
4. A new test PASSES before any code → behaviour already exists or the test
   asserts nothing: tighten the assertion or report "already implemented". Never
   ship a test that was never red.

## Step 4 — Output to caller

```text
RED <mode>/<change kind>
- <test id> — FAIL: <assertion/missing-behaviour line, verbatim excerpt>
BASELINE: <n> pins green | unpinned | pre-existing red: <test ids>
PIN-UPDATED <test> — <spec line>        (only when Step 1 rule fired)
EXCEPTION <kind> — <reason>             (only when Step 0 exception fired)
```

Caller (data-driven-generation 6b GREEN) implements until every listed test and
every baseline pin is green.

## Red flags — STOP

- Production file edited before RED block recorded.
- "Red" whose failure line is `Cannot find module`, `is not defined` at import,
  a type error, `SyntaxError`, `ENOENT` on a fixture → not red; fix harness.
- Spec gave test code, you wrote your own variant.
- Refactor / move, and you wrote a new test instead of running the baseline.
- Bug fix, and code changed before the reproduction failed.
- Test expectation changed during GREEN to match the code.
