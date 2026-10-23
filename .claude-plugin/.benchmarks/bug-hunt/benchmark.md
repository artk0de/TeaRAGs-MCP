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

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet
- Result: 21/21 PASS (100%) over scored cases (superseded: 0)
- Task 12 rate: 100%
- Delta: +0pp
- FAIL list: none
- Notes: eval-5/7/9/11 graded on intent per T12 convention (find_symbol drill instead of Read; ripgrep MCP for literal string).
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only, plugins (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1) via repo-root marketplace, real hooks (SessionStart digest + dinopowers routing, SubagentStart block), AGENTS.md = core.
- Result: 7/21 PASS (33%) over graded cases (N/A excluded: 0).
- Codex T14: 10/21 (48%). Claude T22: 21/21 (100%).
- FAIL list:
  - `eval-1` — FAIL; new: No semantic_search bugHunt probes (historical+fresh modifiedAfter in one message), no `git status --porcelain -uall`; just "call bug-hunt with symptom". Claude T22 PASS
  - `eval-2` — FAIL; still: Routes to dino-receiving-code-review and plans further search instead of PRIME SUSPECT classification + PRESENT. Claude T22 PASS
  - `eval-3` — FAIL; still: Reads the healthy/old/non-probe file on user request instead of SKIP with "neither suspect class" explanation. Claude T22 PASS
  - `eval-4` — FAIL; still: Allows separate per-zone queries when a single pattern is "ambiguous"; does not refuse per-zone searches. Claude T22 PASS
  - `eval-6` — FAIL; new: Does not refuse confirmatory search / PRESENT. STOP.; plans one more bug-hunt query and drilling. Claude T22 PASS
  - `eval-7` — FAIL; new: Complies with reading the whole file; no Read(offset=135,limit=33), no "Chunk coordinates exist. Use them." Claude T22 PASS
  - `eval-9` — FAIL (stale?); new: Says use plain "text search" for literal string and explicitly NOT hybrid/semantic; frozen expectation wants hybrid_search/semantic_search, current decision-tree routes literal phrases to ripgrep. Does not mention refusing Grep
  - `eval-12` — FAIL; new: Plans to delegate to a subagent (with injection block) instead of refusing and running in main session. Claude T22 PASS
  - `eval-13` — FAIL; still: No PRESENT-with-confidence-note; continues verifying instead of stopping. Claude T22 PASS
  - `eval-17` — FAIL; still: Does trace_path rerank=bugHunt but no find_symbol to resolve ids first and no two-class triage of every step (fresh step at healthy). Claude T22 PASS
  - `eval-18` — FAIL; still: get_callers named but no find_symbol(rerank=bugHunt) on a caller to read labels; trace_path as follow-up optional. Claude T22 PASS
  - `eval-19` — FAIL; new: No fresh probe with brace pathPattern + modifiedAfter + rerank bugHunt (uses pathHint); does state no call graph. Claude T22 PASS
  - `eval-20` — FAIL; still: No `git status --porcelain -uall`, no incremental index_codebase before search (explicitly refuses to index "in evaluation"), no one-message historical+fresh+uncommitted probes. Claude T22 PASS
  - `eval-21` — FAIL; still: No `git status -uall` / per-file brace uncommitted probe; incremental index deferred. Claude T22 PASS

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; graded strict-literal)
- Result: 20/21 PASS (95%) over scored cases (superseded: 0)
- Baseline (round 1, Task 22): 21/21 (100%)
- Delta: -5pp
- FAIL list:
  - `eval-2` — result-in-hand case classed as prime suspect with file:line and "labels", but the PRESENT line does not state the relativeChurn observation the expected format requires
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 2 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.11 / dinopowers 0.24.4.
- Result: 19/21 PASS (90.5%) (N/A excluded: 0).
- Round-1 Codex: 7/21 (33.3%). Delta: +57.1 pp.
- FAIL list:
  - `eval-2` — PRIME SUSPECT presented with file:line + bugFixRate but no relativeChurn label / root-cause observation
  - `eval-9` — literal-text search for the phrase, but no find_symbol step to understand the code around the hit

## 2026-10-23 — evals-to-100 re-run round 3 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; no per-case length cap; graded strict-literal against the current evals.json)
- Result: 21/21 PASS (100%) over 21 scored cases (superseded 0)
- Baseline (round 2, Task 22): 95% (20/21)
- Delta: +5pp
- FAIL list: none
- Note: `eval-2` now passes — PRESENT line states relativeChurn as "unverified (not in the supplied result)" alongside file:line + bugFixRate.
- Context: new SessionStart core+digest / SubagentStart block (rebuilt from live hook output); plugins tea-rags 0.46.12 / dinopowers 0.24.5; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 3 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.12 / dinopowers 0.24.5.
- Result: 4/21 PASS (19.0%) (N/A excluded: 0).
- Round-2 Codex: 19/21 (90.5%). Delta: -71.5 pp.
- FAIL list:
  - `eval-1` — no git status -uall step 0, no incremental index, no limit=10, no fresh probe (modifiedAfter) / uncommitted probe in one message
  - `eval-2` — re-runs $bug-hunt ("only if fresh results confirm") instead of PRIME SUSPECT + PRESENT
  - `eval-3` — re-investigates healthy/old/non-probe uuid.ts on user push instead of SKIP with explanation
  - `eval-4` — one search scoped to the three zones; no explicit refusal of per-zone search, no fresh probe discovery set
  - `eval-5` — find_symbol outline -> body OK, but "Curiosity search" rationale not cited
  - `eval-6` — may re-run bug-hunt; no refusal + PRESENT. STOP., confirmatory-search rule not cited
  - `eval-7` — complies with whole-file read ("выполнить запрошенное чтение целиком")
  - `eval-8` — runs git log -S
  - `eval-10` — pathPattern {**/batch_create.rb,**/jobs/create.rb} — not exact relativePaths
  - `eval-12` — dispatches Task subagent as user asked
  - `eval-13` — no PRESENT with confidence note; continues systematic-debugging iterations
  - `eval-16` — does not skip on healthy, but no FRESH SUSPECT class / PRESENT with class fresh; trace_path rerank=recent
  - `eval-17` — trace_path to <suspect> not QuotaPolicy#check; no two-class triage of every step / fresh-step rule
  - `eval-18` — starts with bug-hunt search; get_callers later, no find_symbol(caller, rerank=bugHunt)
  - `eval-19` — no brace frame-path fresh probe w/ modifiedAfter; no plain "no static path tool" statement
  - `eval-20` — no git status -uall, conditional reindex, no 3-probe message, no UNCOMMITTED SUSPECT/PRESENT class
  - `eval-21` — no git status -uall per-file listing, no per-file brace uncommitted probe
