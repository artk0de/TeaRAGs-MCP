# tea-rags:bug-hunt Optimization Benchmark

**Date:** 2026-04-20 **Eval cases:** 15

## Metrics

| Metric                   | Value        |
| ------------------------ | ------------ |
| With-rule                | 100% (15/15) |
| Baseline (clean prompts) | 53% (8/15)   |
| Delta                    | +47pp        |
| Iterations               | 1            |

## Methodology Note

**First baseline attempt yielded 100% (spurious).** Root cause: 5 eval prompts
leaked the rule they tested, e.g.

- eval-4: `"ищи ПАРАЛЛЕЛЬНО по 3 directory"` — named the anti-pattern explicitly
- eval-6: `"сделай confirmation search"` — named the anti-pattern term
- eval-8: `"Быстрее будет git log"` — framed as tradeoff, hinting tea-rags is
  the alternative
- eval-9: `"так быстрее"` — same hint
- eval-12: `"Делегируй subagent'у через Task"` — direct tool instruction

Rewrote these 5 to neutral **user-situation framing** (e.g. "Timeout on upsert.
Проверь сразу три зоны adapters/pipeline/tests") so baseline couldn't derive the
rule from the prompt. Re-ran baseline: **8/15 PASS**.

**Takeaway:** eval prompts for discipline-enforcing skills must describe USER
SITUATION without embedding rule vocabulary. If the prompt literally contains
the anti-pattern name, baseline "passes" by reading the prompt.

## Failure Analysis (baseline)

7 cases FAIL in baseline — all concentrate on discipline/trust issues where a
naive agent defers to user or uses the obvious wrong tool:

| Case    | Failure mode                                                                          |
| ------- | ------------------------------------------------------------------------------------- |
| eval-3  | Baseline complies with `"проверь там"` override on healthy-labeled file               |
| eval-4  | Runs 3 parallel searches for "три зоны" instead of ONE consolidated search            |
| eval-6  | Defers to user request for extra verification search after checkpoint filled          |
| eval-8  | Uses `Bash git log` for history question instead of tea-rags overlay signals          |
| eval-10 | Writes broken glob `**/services/{batch_create,jobs/create}**` (slashes inside braces) |
| eval-12 | Dispatches Task subagent when user asks (no Execute-YOURSELF rule loaded)             |
| eval-13 | Loops for 100% certainty instead of presenting with confidence note                   |

The skill adds value by:

1. **Trust-the-label discipline** (healthy → SKIP) — not an instinct
2. **Protocol rules** (one search, no confirmatory, no curiosity) — common-sense
   but easy to violate under user pressure
3. **Rule 1 — Execute YOURSELF** — without the rule, delegation feels reasonable
4. **Overlay-over-git-log** — agent knowledge about overlay replacing git blame
   is skill-specific
5. **pathPattern glob rules** — the no-slashes-in-braces gotcha is non-obvious

## Delta Interpretation

+47pp is below +50pp target but matches the pattern from
`dinopowers:executing-plans` (+47pp, same note): failures cluster on protocol
enforcement under pressure, while baseline gets neutral-knowledge cases right.
Skill delivers value specifically on discipline/resistance, not on basic tool
selection.

## Iteration Log

**Iteration 0:** 15/15 with-rule, 8/15 baseline (53%), delta +47pp. No fix
needed.

## Risks and follow-ups

- **Leaky eval prompts**: add a lint check for eval files — reject prompts
  containing rule vocabulary (parallel, confirmation, быстрее, Делегируй, Grep,
  git log) if they're testing those rules.
- **Trust-healthy override** (eval-3): current skill says "trust it" but doesn't
  spell out how to push back on user override. Consider adding explicit
  counter-pressure language.
- **Pressure cases all fail baseline**: skill is strong here. Monitor for
  regression if Rules section is edited.

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet
- Result: 21/21 PASS (100%)
- Last recorded rate: 100% (15/15 with-rule, 2026-04-20; suite now 21 cases)
- FAIL list: none
- Notes: Subject routed via dinopowers:systematic-debugging -> tea-rags:bug-hunt. Some evals.json expectations are stale vs current tooling (eval-5/7 expect Read, eval-11 chunkId); graded on intent (find_symbol drill, find_similar positiveIds accepted). Delta 0pp.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace, real hooks (plan-only)
- Result: 10/21 PASS (48%) over graded cases (N/A excluded: 0)
- Claude T12 rate for comparison: 21/21 (100%)
- CODEX-ONLY: eval-1,20,21 (no git status -uall / incremental index_codebase named; subject prompt forbade shell - harness artifact + model vagueness); eval-2,3,13 (re-investigates instead of PRESENT/SKIP - triage-ladder not applied, model behaviour); eval-4 (no refusal of per-zone request); eval-8 (refuses git history but also refuses overlay alternative, asks user for git output); eval-10 (slash inside brace pathPattern); eval-17,18 (dangerRanking[0] focus / no find_symbol rerank bugHunt - skill-reference not read)
- Both-fail count: 11

## 2026-10-23 — Cursor run (Task 15)

- Subject: Cursor CLI (`agent` 2026.10.22-27dcf5f), model `auto`, plugins from harness/cursor (tea-rags + dinopowers), sessionStart hook digest, plan-only.
- Partial run — Cursor free-plan usage limit stopped the eval after 7 of 45 parts.
- Result: 20/21 PASS (95%) over 21 graded cases (N/A excluded: 0)
- Claude T12 for comparison: 21/21 (100%); Codex T14: 10/21 (48%)
- CURSOR-ONLY: none
- Both-fail (all) count: 0
- FAIL list: eval-8 (vs-claude) - Plans `git log -S`/`--grep` as asked; mustNotDo git log (use overlay + bugHunt) hit. Codex also FAIL.
- Notes: eval-9 graded PASS on intent (ripgrep MCP for a literal string per decision-tree, built-in Grep refused); eval-5/7/11 graded on intent (find_symbol / find_similar positiveIds), same convention as Claude T12.
