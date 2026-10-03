# SWE-bench Lite A/B — pre-registration

Date: 2026-10-03. Committed before the first scored run. Design:
`docs/superpowers/specs/2026-10-03-swe-bench-lite-ab-design.md`.

## Setup

- Arm 0: Claude Code headless (`claude -p`), model `claude-sonnet-5-5`, no MCP
  servers, no plugins, isolated `CLAUDE_CONFIG_DIR`.
- Arm 1: identical, plus the tea-rags MCP server and the tea-rags plugin.
- Tasks: `tasks/pilot-50.json` (50 tasks from `SWE-bench/SWE-bench_Lite`,
  stratified by repository and by "gold file named in the issue", seed
  20261003). Plugin tuning used only `tasks/dev-5.json`, which is disjoint from
  the pilot.
- One run per task per arm. Scoring: the official
  `swebench.harness.run_evaluation`.

## Hypotheses

- **H1.** Arm 1 resolves more pilot tasks than arm 0.
- **H2.** The median total input tokens per task (input + cache write + cache
  read) is lower in arm 1 than in arm 0.
- **H3.** The arm 1 − arm 0 effect on resolve rate and on tokens is larger in
  the "gold file not named in the issue" stratum than in the "gold file named"
  stratum.

## Analysis plan

- Resolve rate: exact McNemar test on the paired per-task outcomes, two-sided.
- Tokens (input, cache write, cache read, output), `total_cost_usd`, turns, tool
  calls, search/read calls: Wilcoxon signed-rank test on the paired per-task
  values, two-sided, plus a bootstrap 95% CI (10 000 resamples, seed 0) of the
  mean paired difference (arm 1 − arm 0).
- File recall (gold file touched): McNemar on paired outcomes.
- Each metric is reported for all tasks and separately for each stratum. H3 is
  judged by comparing the per-stratum deltas; with n = 50 it is descriptive.
- The arm 1 TeaRAGs share (tea-rags calls / all search+read calls) is reported
  next to every arm 1 number. A low share means arm 1 did not exercise TeaRAGs.
- Power: with 50 pairs only a resolve delta of roughly 15–20 pp is detectable.
  The token comparison (paired continuous data) is the primary quantitative
  read-out of the pilot.

## Exclusion rule

No task is dropped after the run. A run that ends with `is_error` or hits the
timeout counts as unresolved and stays in the token analysis with the partial
usage recorded in its transcript.
