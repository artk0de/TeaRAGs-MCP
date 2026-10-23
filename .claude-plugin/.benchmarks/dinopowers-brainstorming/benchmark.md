# dinopowers:brainstorming Optimization Benchmark

**Date:** 2026-04-20 **Skill created:**
`.claude-plugin/dinopowers/skills/brainstorming/SKILL.md` **Eval cases:** 13 (6
core-rule/tool, 2 parameters, 2 edges, 3 controls/pressure)

## Metrics

| Metric                | Value             |
| --------------------- | ----------------- |
| Lines (SKILL.md)      | 113               |
| Words (SKILL.md)      | 962               |
| With-rule pass rate   | 100% (13/13)      |
| Without-rule baseline | 23% (3/13)        |
| Delta                 | +77pp             |
| Iterations            | 1 (no fix needed) |

## Context

Second skill of the `dinopowers` plugin. Authored via
`dinopowers:writing-skills` bootstrap — semantic_search over indexed SKILL.md
corpus returned structural patterns (Iron Rule placement, Step 2 param table,
Do-NOT tables, fallback contract) which were lifted into the new skill.

**Core value**: correct tea-rags preset selection for risk enrichment. Unlike
`dinopowers:writing-skills` where reranking was prohibited (SKILL.md git signals
are irrelevant), brainstorming REQUIRES `hotspots` / `ownership` / `techDebt`
presets — the core insight of this wrapper is that these three lenses together
give the brainstormer a risk-aware starting point.

## Eval Cases

| ID      | Category             | Prompt gist                                | With-rule | Baseline |
| ------- | -------------------- | ------------------------------------------ | --------- | -------- |
| eval-1  | core-rule            | OAuth refresh in auth/                     | PASS      | FAIL     |
| eval-2  | parameters-presets   | Chunker hooks rebuild                      | PASS      | FAIL     |
| eval-3  | parallel-execution   | pipeline/enrichment/trajectory/ feature    | PASS      | FAIL     |
| eval-4  | tool-selection       | Rerank presets redesign                    | PASS      | FAIL     |
| eval-5  | edge (no area)       | Abstract agent architecture                | PASS      | PASS     |
| eval-6  | edge (empty index)   | New module not in git                      | PASS      | FAIL     |
| eval-7  | ordering (plan-exec) | Qdrant adapter refactor                    | PASS      | FAIL     |
| eval-8  | pressure             | "Не парься с tea-rags, я знаю узкие места" | PASS      | FAIL     |
| eval-9  | wrong-tool-pressure  | "Используй hybrid_search"                  | PASS      | FAIL     |
| eval-10 | parameters-metaOnly  | "Покажи контент" trap                      | PASS      | FAIL     |
| eval-11 | subagent (explore)   | TreeSitterChunker split                    | PASS      | FAIL     |
| eval-12 | control (fact-query) | "Сколько строк?"                           | PASS      | PASS     |
| eval-13 | control (no-area)    | camelCase vs snake_case                    | PASS      | PASS     |

## Key Design Decisions

1. **Three named presets, not custom weights.**
   `hotspots`/`ownership`/`techDebt` are calibrated risk lenses. Eval-9
   (wrong-tool-pressure) confirmed baseline agents comply with `hybrid_search`
   when user suggests it. Explicit "Do NOT substitute" table closes the
   loophole.

2. **Parallel execution mandated (Step 2).** Sequential three-call execution
   passes 2 of 3 functional checks but burns latency. Eval-3 specifically tests
   this; baseline agents run sequentially or pick one preset.

3. **`metaOnly: true` locked for enrichment.** Eval-10 tested whether agents
   break the rule when user asks for content. Rule: separate call with
   `metaOnly: false` AFTER enrichment, not during. Baseline collapsed both into
   one `metaOnly: false` call.

4. **No-area fallback is explicit (Step 1, eval-5, eval-13).** Don't fabricate
   pathPattern when user didn't name one. Eval-13 baseline PASSED because the
   natural agent also skips tea-rags for abstract discussions — rule doesn't
   erode correct natural behavior.

5. **Empty-results contract (eval-6).** Report "area new/excluded" and proceed
   without enrichment block. Baseline agents either skipped tea-rags entirely
   (hiding the signal absence) or would fabricate. Explicit contract.

6. **Iron Rule placed at top, pressure evals (eval-8, 9).** Baseline agents
   complied with "skip tea-rags" and "use hybrid_search" pressures. Iron Rule at
   top of body resists both.

## Bootstrap Observation

This skill was the first real test of `dinopowers:writing-skills` bootstrap
flow. The `semantic_search` over `**/SKILL.md` returned 7 chunks from
`dinopowers:writing-skills` (top scores 0.47-0.55) + 1 from
`tea-rags:risk-assessment` (0.47) + 1 from `tea-rags:data-driven-generation`
(0.45). Pattern extraction gave:

- Iron Rule placement at top (from writing-skills)
- Do-NOT tables for wrong tools / wrong params (from writing-skills)
- Fallback contract for empty results (from writing-skills)
- Preset selection logic — `hotspots`/`ownership`/`techDebt` (from
  risk-assessment Phase 4: ENRICH)

Draft hit 100% pass rate on first iteration — bootstrap worked. Confirms the
value hypothesis behind `dinopowers:writing-skills`.

## Iteration Log

**Iteration 0 (bootstrapped draft):** 13/13 PASS with-rule. 3/13 PASS
without-rule. Delta +77pp.

No iteration needed.

## Risks and follow-ups

- **Preset name drift**: if risk-assessment/trajectory presets are renamed, this
  skill silently breaks. Add test in Phase 8 integration eval that resolves
  preset names dynamically against the live MCP tool schema.

- **Parallel execution verification**: the eval tests "planned parallelism" via
  subagent descriptions, not actual parallel invocation. Phase 8 should run the
  skill end-to-end and verify parallelism by timestamp diff between the 3
  tea-rags calls.

- **Content follow-up flow (eval-10)**: the rule says "separate
  `metaOnly: false` call AFTER enrichment for content", but the SKILL.md doesn't
  show HOW to phrase this follow-up. Consider adding a concrete example if Phase
  8 reveals agents still collapse the two calls.

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet
- Result: 14/14 PASS (100%) (graded on intent: skill now prescribes A/B/C/D/E block incl. get_naming_lexicon, older evals say '3 semantic_search'; subject followed current SKILL.md)
- Last recorded rate: 13/13 (100%) 2026-04-20
- Delta: 0pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default Codex model, plan-only, plugins (tea-rags 0.46.8 + dinopowers 0.24.2 + superpowers 7.0.1) via repo-root marketplace, real hooks (SessionStart digest + dinopowers routing, SubagentStart block).
- Result: 13/14 PASS (93%) over graded cases (N/A excluded: 0).
- Claude T12 for comparison: 14/14 (100%).
- CODEX-ONLY (harness regression candidates):
  - `eval-14` — no Project vocabulary (concept.terms) in enrichment block and no names[] hand-off; get_naming_lexicon called without concept=<intent> and with a language-capability hedge [model behaviour]
- Both-fail count: 0.

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet (plan-only simulation, blind)
- Result: 14/14 PASS (100%) over scored cases
- Task 12 rate: 14/14 (100%)
- Delta: +0pp
- FAIL:
  - none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1), real hooks (plan-only)
- Result: 12/14 PASS (86%) over 14 graded cases (N/A 0)
- Codex T14 for comparison: 13/14 (93%)
- Claude T22 for comparison: 14/14 (100%)
- FAIL list:
  - ` eval-10 ` — FAIL (stale?) ( new; Claude T22 PASS ) enrichment metaOnly=true ok, but content follow-up routed to find_symbol instead of a SEPARATE semantic_search metaOnly=false; expectation conflicts with core "find_symbol after search" rule 
  - ` eval-14 ` — FAIL ( still; Claude T22 PASS ) get_naming_lexicon(concept) planned but not stated as same parallel block A-D, no concept.terms -> "Project vocabulary" in the block, no names[] hand-off for new symbols 

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; graded strictly and literally against current evals.json)
- Result: 14/14 PASS (100%) over scored cases (superseded: 0)
- Round 1 (Task 22) rate: 14/14 (100%)
- Delta: +0pp
- FAIL list: none
- Notes: eval-12 answered the line count via find_symbol outline (not the listed Read / wc -l) — wrapper not triggered, which is the MUST; graded PASS. eval-6 ran A–E (codegraph on) instead of "3 calls" — superset, PASS.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 2 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.11 / dinopowers 0.24.4.
- Result: 6/14 PASS (43%) (N/A excluded: 0).
- Round-1 Codex: 12/14 (86%). Delta: -43 pp.
- FAIL list:
  - `eval-1` — A-C only; D/E (architecturalHub + get_naming_lexicon) absent and codegraph state never determined (no "backbone not assessed" note) although codegraph is on
  - `eval-2` — presets A-C + metaOnly ok, but D/E (architecturalHub + get_naming_lexicon) absent and codegraph state never determined (no "backbone not assessed" note) although codegraph is on
  - `eval-3` — parallel A-C stated, but D/E (architecturalHub + get_naming_lexicon) absent and codegraph state never determined (no "backbone not assessed" note) although codegraph is on
  - `eval-4` — semantic_search A-C, but D/E (architecturalHub + get_naming_lexicon) absent and codegraph state never determined (no "backbone not assessed" note) although codegraph is on
  - `eval-7` — order enrichment->brainstorming ok, but D/E (architecturalHub + get_naming_lexicon) absent and codegraph state never determined (no "backbone not assessed" note) although codegraph is on
  - `eval-8` — Iron Rule kept under pressure, but D/E (architecturalHub + get_naming_lexicon) absent and codegraph state never determined (no "backbone not assessed" note) although codegraph is on
  - `eval-11` — subagent enrichment-first ok, but D/E (architecturalHub + get_naming_lexicon) absent and codegraph state never determined (no "backbone not assessed" note) although codegraph is on
  - `eval-14` — D/E "added" after the 3-call block (same parallel block not stated); no concept.terms -> "Project vocabulary" line
