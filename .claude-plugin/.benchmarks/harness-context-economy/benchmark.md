# harness-context-economy — Task 12 eval gate (2026-10-23)

Full re-run of every suite with runnable cases against the rewritten plugin
text: rules split into `rules/core.md` + `tea-rags://guide/*`, slim prime digest

- `tea-rags://project/<alias>/metrics`, subagent block ≤ 3 KB, dinopowers
  routing on SessionStart, skills decomposed into `references/`.

## Always-on context (bytes)

| Surface                              | Before (main 9a9a9e4ad)        | After                |
| ------------------------------------ | ------------------------------ | -------------------- |
| Session start + every compaction     | ~82 KB (rules 69.9 KB + prime) | 6.5 KB               |
| Rules injection                      | 69,484 B / 9 parts             | 3,680 chars / 1 part |
| `tea-rags prime` on taxdome          | 9,270 B (cut to 2,000 preview) | 1,918 B              |
| Per subagent (tea-rags + dinopowers) | 11.7 KB                        | 5.0 KB               |
| Per user prompt (dinopowers routing) | 1,669 B                        | 0                    |
| `resources/list` + templates         | 15 + per-collection rows       | 19                   |

## Method

`/optimize-skill` Phase 4 protocol: one blind sonnet subject per suite, all
cases in one prompt, plan only (no tool execution), graded against `expected` +
`failure_mode`. Subject context = the bundles the NEW hooks emit
(`inject-rules.sh`, `tea-rags prime`, SubagentStart scripts). Limitation: the
installed (old) plugin's hook text was present in subject context, declared
void. Load-time `` !`tea-rags resource …` `` lines were not executed in the
first pass; the A/B pass executed them.

## Results

- 41 suites; 39 runnable, ~620 cases. Per-suite rows are in each
  `<suite>/benchmark.md` section "2026-10-23 — harness-context-economy re-run".
- dinopowers 187/189; search/addressing/analysis 11/13 suites at 100% (`explore`
  27/27, `bug-hunt` 21/21, `wave1-triggering` 30/30).
- Genuine regressions found: `index-lag-overlay` E1/E7/E13/E15,
  `addressing-consistency` C12 — own-checkout reindex, `collection=` and
  manual-read rules lived only in `guide/freshness`. Fixed in `81a49819e` (rules
  back in core; `pagination` promoted to a guide with a core trigger).
- A/B triage (OLD = main text + 78.6 KB context, NEW = fixed text + 6.5 KB) over
  the 34 remaining failures: 0 unintended regressions; 9 cases FIXED vs OLD; 21
  STALE-both + 2 PRE-EXISTING (expectations predate current skill contracts —
  bead tea-rags-mcp-9lynw.24); 2 by-design changes (tests-as-context T11: probe
  replaced by metrics resource; filter-building E9: `guide/filters` inlined at
  load instead of a read).

Gate: passed — no case fails on NEW that passes on OLD except the two intended
contract changes.

## 2026-11-10 — Codex full eval run (Task 14, current package)

Subject: Codex CLI **0.167.0**, default model **gpt-6.1-sol**, plan-only, one
run per suite, all case prompts per suite in one prompt; plugins via repo-root
marketplace in a scratch `CODEX_HOME`: tea-rags **0.55.12** + the core-hook
token-cap fix (3fa4a4a42: read discipline rides codex-rules.txt; all three
SessionStart payloads verified delivered whole), dinopowers 0.25.3, superpowers
7.0.2. Real hooks fired (3× SessionStart, per-turn routing, dinopowers routing).
Graders: independent subagents, strict against `expected` + `failure_mode` +
assertions, Codex tool-name mapping (read_mcp_resource ≙ ReadMcpResourceTool, $x
≙ Skill(x), bare ≙ mcp**tea-rags**x).

- **Total: 478/665 PASS (72%)** over 39 runnable suites / 665 graded cases;
  NA 0. Regression candidates (pass Claude T12, fail Codex today): **179**.
- Claude T12 (2026-10-23) overall ≈ 604/620 (98%); 2026-10-23 Codex run
  (0.162.1, plugin 0.46.8) per-suite rates in the table for drift.
- Dominant failure pattern (verdict FAIL digests, per-suite sections): the model
  substitutes bundled shell rg/sed + find_symbol for the tea-rags steps the
  dinopowers wrappers and discovery contracts mandate (semantic_search pattern
  discovery, blastRadius impact scans, PUSHBACK/ AGREE verdicts). Suites that
  are pure tea-rags tool routing hold up (search-cascade 69/70,
  codegraph-presence-fallback 17/17, addressing 12/12, facade-discipline 12/12,
  working-tree-skills 16/16, chaining-rule 8/8).
- Skills list budget observed: 9,653 chars combined (tea-rags 5,165 + dinopowers
  4,488), under the 8,000-char list default clip per-description cap 440
  (harness/codex/README.md).

| suite                                     | Codex 2026-11-10 | Codex 2026-10-23 | reg-candidates |
| ----------------------------------------- | ---------------- | ---------------- | -------------- |
| dinopowers-writing-skills                 | 2/12 (17%)       | 2/12 (17%)       | 10             |
| dinopowers-receiving-code-review          | 3/14 (21%)       | 4/14 (29%)       | 11             |
| dinopowers-requesting-code-review         | 3/14 (21%)       | 14/14 (100%)     | 11             |
| dinopowers-writing-plans                  | 4/17 (24%)       | 2/15 (13%)       | 13             |
| dinopowers-verification-before-completion | 5/15 (33%)       | 13/15 (87%)      | 10             |
| filter-building                           | 5/12 (42%)       | 14/14 (100%)     | 7              |
| analytics-rerank                          | 6/13 (46%)       | 10/12 (83%)      | 6              |
| dinopowers-brainstorming                  | 7/15 (47%)       | 13/14 (93%)      | 7              |
| mr-review                                 | 2/4 (50%)        | 1/3 (33%)        | 0              |
| pattern-search                            | 7/14 (50%)       | 4/14 (29%)       | 7              |
| expand-coverage                           | 8/15 (53%)       | 15/15 (100%)     | 7              |
| explore                                   | 15/28 (54%)      | 19/27 (70%)      | 13             |
| dinopowers-systematic-debugging           | 10/18 (56%)      | 16/17 (94%)      | 7              |
| architecture-diagnostics                  | 4/7 (57%)        | 2/2 (100%)       | 3              |
| coverage-expander                         | 6/10 (60%)       | 9/10 (90%)       | 4              |
| wave1-triggering                          | 19/30 (63%)      | 19/20 (95%)      | 11             |
| bug-hunt                                  | 14/22 (64%)      | 10/21 (48%)      | 8              |
| index                                     | 7/11 (64%)       | 5/10 (50%)       | 3              |
| dinopowers-test-driven-development        | 10/15 (67%)      | 13/15 (87%)      | 5              |
| tests-as-context                          | 8/12 (67%)       | 12/12 (100%)     | 4              |
| force-reindex                             | 7/10 (70%)       | 8/10 (80%)       | 3              |
| risk-assessment                           | 11/15 (73%)      | 9/14 (64%)       | 4              |
| dinopowers-executing-plans                | 12/16 (75%)      | 15/16 (94%)      | 4              |
| extract-project-patterns                  | 6/8 (75%)        | 6/8 (75%)        | 1              |
| refactoring-planning                      | 6/8 (75%)        | 7/8 (88%)        | 2              |
| dinopowers-finishing-a-development-branch | 10/13 (77%)      | 12/13 (92%)      | 3              |
| index-lag-overlay                         | 15/19 (79%)      | 15/15 (100%)     | 3              |
| research-merge                            | 12/15 (80%)      | 14/15 (93%)      | 3              |
| working-tree-injection                    | 15/17 (88%)      | 14/17 (82%)      | 2              |
| dinopowers-wrappers                       | 14/15 (93%)      | 15/15 (100%)     | 1              |
| refactoring-scan                          | 14/15 (93%)      | 13/15 (87%)      | 1              |
| data-driven-generation                    | 64/68 (94%)      | 42/67 (63%)      | 4              |
| search-cascade                            | 69/70 (99%)      | 11/12 (92%)      | 1              |
| addressing-consistency                    | 12/12 (100%)     | 10/12 (83%)      | 0              |
| codegraph-presence-fallback               | 17/17 (100%)     | 13/13 (100%)     | 0              |
| dinopowers-chaining-rule                  | 8/8 (100%)       | 8/8 (100%)       | 0              |
| dinopowers-executing-plans-v2             | 13/13 (100%)     | 12/13 (92%)      | 0              |
| facade-discipline                         | 12/12 (100%)     | 16/19 (84%)      | 0              |
| working-tree-skills                       | 16/16 (100%)     | 15/16 (94%)      | 0              |

Limitations: single run per case (no repetition, quota); grader model = session
subagent, not sonnet as the plan named; plan-only (no live tool execution except
the five scripted checks in
harness-context-economy/codex-live-test-2026-11-10.md (moved out of
harness/codex — regeneration wipes the dir)); raw transcripts and verdict JSONs
session-local (/tmp/codex-eval), not committed — per-suite sections carry the
graded results. Two data-driven- generation case prompts carry committed prose
references to a taxdome-like fixture (fixture area
`app/services/tax_preparation/`, fictional); no taxdome code or index was read
by any run (all runs `-C` this repo, plan-only).
