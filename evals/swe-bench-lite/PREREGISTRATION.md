# SWE-bench Lite A/B — pre-registration

Date: 2026-10-03. Committed before the first scored run. Design:
`docs/superpowers/specs/2026-10-03-swe-bench-lite-ab-design.md`.

## Setup

- Arm 0: Claude Code headless (`claude -p`), model `claude-sonnet-5-5`, no MCP
  servers, no plugins, isolated `CLAUDE_CONFIG_DIR`.
- Arm 1: identical, plus the tea-rags MCP server and the tea-rags plugin.
- Arms run interleaved per task, arm order randomised per task (seed 20261003).
- Tasks (first scored run): `tasks/django-focus-50.json`, all from
  `django/django` in `SWE-bench/SWE-bench_Lite`, seed 20261003:
  - **not named** — 30 of the 94 tasks whose gold file is not named in the
    issue text;
  - **named** — all 20 tasks whose gold file is named in the issue text.
- Plugin tuning used only `tasks/dev-django-5.json` (django, disjoint from the
  scored set).
- One run per task per arm. Scoring: the official
  `swebench.harness.run_evaluation`.

Why django first: it is the largest Lite repository (114 of 300 tasks) and has
many layers (ORM, forms, admin, migrations), so locating the code to change is
a real search problem when the issue does not name the file. The named stratum
is the control: there retrieval has little to add.

## Confirmatory hypotheses

- **H1.** In the not-named stratum, arm 1 resolves more tasks than arm 0, and
  spends fewer total input tokens per task (input + cache write + cache read,
  median).
- **H2.** In the not-named stratum, arm 1 needs fewer tool calls and less solve
  time (agent wall clock excluding in-run reindexing) per task than arm 0.
- **H3.** The arm 1 − arm 0 effect on resolve rate, tokens, tool calls and solve
  time is larger in the not-named stratum than in the named stratum.

## Analysis plan

- Resolve rate: exact McNemar test on the paired per-task outcomes, two-sided.
- Tokens (input, cache write, cache read, output), `total_cost_usd`, turns, tool
  calls, search/read calls, solve time: Wilcoxon signed-rank test on the paired
  per-task values, two-sided, plus a bootstrap 95% CI (10 000 resamples, seed
  0) of the mean paired difference (arm 1 − arm 0).
- File recall (gold file touched): McNemar on paired outcomes.
- Every metric is reported per stratum and for all 50 tasks. H3 is judged by
  comparing the per-stratum deltas and their CIs; with 30 and 20 pairs it is
  descriptive for resolve rate and quantitative for the continuous metrics.
- The arm 1 TeaRAGs share (tea-rags calls / all search+read calls) is reported
  next to every arm 1 number. A low share means arm 1 did not exercise TeaRAGs.
- Power: with 30 pairs only a resolve delta of roughly 20–25 pp is detectable.
  The continuous metrics are the primary quantitative read-out.

## Exploratory (not confirmatory)

- **Memorised location.** Pairs where arm 0 opened the gold file before any
  search tool (`gold_before_search`) measure how often the model already knew
  where the code lives. The effect is reported separately for pairs where arm 0
  did NOT do that, i.e. where it had to search.
- Per repository × stratum table (one repository here).
- Prior expectations, recorded for calibration, not tested: a true resolve
  effect of ≥ +5 pp overall ~30–40 %; H3 holding ~65–75 %; H1 resolve delta
  significant at this n ~7–12 %.

## Exclusion rule

No task is dropped after the run. A run that ends with `is_error` or hits the
timeout counts as unresolved and stays in the token analysis with the partial
usage recorded in its transcript.

## Later runs

`tasks/pilot-50.json` (mixed repositories, stratified by repository and
stratum) is the second scored run, under the same analysis plan with the strata
pooled across repositories.
