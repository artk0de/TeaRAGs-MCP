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
