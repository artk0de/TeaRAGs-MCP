# SWE-bench Lite A/B: Claude Code with and without TeaRAGs — design

Date: 2026-10-03. Parent epic: `tea-rags-mcp-evpa` (sibling of `pdpe`, which
stays the git-signal ablation).

## Question

Does TeaRAGs retrieval raise the share of SWE-bench Lite tasks an agent
resolves, and how many input / cache / output tokens does it save, holding the
model, the agent and the task prompt constant?

Headline hypothesis (pre-registered before the first scored run): arm 1 resolves
more tasks than arm 0 and spends fewer tokens per task. Secondary: the gain
concentrates in tasks whose gold file is not named in the issue text.

External reference: JetBrains reported Context on 205 SWE-bench tasks as −68%
agent steps, −59% latency, −48% cost (best case, no breakdown). Our token and
turn columns are directly comparable to that framing; we publish the full
per-task table.

## Arms

|                       | Arm 0 (control)                            | Arm 1 (treatment)                                  |
| --------------------- | ------------------------------------------ | -------------------------------------------------- |
| Agent                 | Claude Code headless, `claude -p`          | same binary, same version                          |
| Model                 | `claude-sonnet-5-5`                        | same                                               |
| Task prompt           | identical                                  | identical                                          |
| MCP                   | none (`--strict-mcp-config`, empty config) | tea-rags only                                      |
| Plugins / `CLAUDE.md` | none — isolated `CLAUDE_CONFIG_DIR`        | tea-rags plugin only, isolated `CLAUDE_CONFIG_DIR` |
| Limits                | timeout, max turns                         | same values                                        |

The arms differ only in the MCP server and the plugin. Arm 0 must not inherit
the operator's global `CLAUDE.md`, rules, skills, plugins or MCP servers — the
isolated config dir is what enforces that.

## Environment: agent on the host, evaluation in Docker

- The agent runs on the host inside a per-task repository. It cannot run the
  project's test suite in either arm; the task prompt says so in both arms. This
  removes per-repo Python environments (astropy, scikit-learn, matplotlib build
  C extensions) as an uncontrolled variable.
- Scoring is the official `swebench.harness.run_evaluation` against
  `princeton-nlp/SWE-bench_Lite` in Docker (`FAIL_TO_PASS` / `PASS_TO_PASS`).
  Fallback when the images do not run on this machine: `sb-cli` cloud
  evaluation.
- Absolute resolve rates will sit below leaderboard numbers (no test feedback
  loop). The measured quantity is the arm delta.

## Location

`evals/swe-bench-lite/` in this repository, Python managed with `uv`, depends on
`swebench`. `package.json#files` is a whitelist that does not list `evals/`, so
nothing here ships in the npm package. `benchmarks/` is not used: it is in the
whitelist and holds the user-facing `tune` scripts.

Committed: code, task lists, pre-registration, the final report and summary
tables. Not committed: mirrors, per-task repos, indexes, raw transcripts (kept
under a gitignored `evals/swe-bench-lite/runs/`, attached to a release when
published).

## Pipeline

| Step            | Responsibility                                                                                                                                                                                                                                                                            | Output                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `select_tasks`  | 50 pilot tasks from Lite, fixed seed, stratified by repo (proportional to Lite) and by "gold file named in `problem_statement`" (computed from the gold `patch`). Plus 5 dev tasks disjoint from the pilot.                                                                               | `tasks/pilot-50.json`, `tasks/dev-5.json`                                        |
| `prepare`       | One bare mirror per repo (12). Per task a separate repository: `git init` + `git fetch <mirror> <base_commit>` + detached checkout. Only ancestors of `base_commit` exist, so `git log --all` cannot reveal the fix.                                                                      | `runs/repos/<instance_id>/`                                                      |
| `index` (arm 1) | Per repo, tasks sorted by `base_commit` date. First task: full index. Each next task: index cloned from the previous (earlier) task with `tea-rags worktree create --from`, then incremental `index-codebase`. Embedding model `brokkai/Muninn-small`; git and codegraph trajectories on. | indexes + `index.jsonl` (wall time per task)                                     |
| `run_agent`     | `claude -p --model claude-sonnet-5-5 --output-format stream-json` in the task repo, per arm config dir.                                                                                                                                                                                   | `runs/<arm>/<instance_id>/transcript.jsonl`, `result.json`                       |
| `collect`       | `git diff <base_commit>` per task.                                                                                                                                                                                                                                                        | `runs/<arm>/predictions.jsonl` (SWE-bench format, `model_name_or_path` = arm id) |
| `evaluate`      | Official harness per arm.                                                                                                                                                                                                                                                                 | harness report per arm                                                           |
| `report`        | Joins everything, computes metrics and tests.                                                                                                                                                                                                                                             | `results/pilot-<date>.md` + CSV                                                  |

### Leakage controls

- Repository content and git history: only ancestors of `base_commit`.
- Index seeding goes forward in time only. A seed from a later commit would
  carry git signals (churn, recency, bugFixRate) computed with the fix in the
  history; seeding from an earlier commit can only make unchanged files' signals
  older than `base_commit`, never newer.
- The model may have seen these repositories in training. That affects both arms
  equally; the delta is what we report. SWE-bench Live is the later
  contamination check (out of scope for the pilot).

## Prompt parity and the "TeaRAGs is actually used" requirement

The task prompt is fixed text: the issue, the repository path, "make the minimal
change that resolves the issue, do not edit tests, no test environment is
available". Nothing in it mentions TeaRAGs.

Arm 1 steers the agent through the plugin's own surface (SessionStart prime,
search cascade, subagent injection — the WorkingTreeOverlay wave already rewrote
the injection to address the index by the agent's own working directory and to
name the Bash channel). Any plugin prompt change needed to make the agent prefer
TeaRAGs is tuned **only on the 5 dev tasks**, before the scored run. Tuning on
the pilot tasks would fit the treatment to the test set. Plugin edits follow the
local-marketplace update + reinstall path into the arm 1 config dir.

## Metrics

Per arm, per stratum (gold file named / not named), per repo:

| Metric                                                                                | Source                       | Test                                   |
| ------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------- |
| Resolved %                                                                            | harness report               | McNemar on paired outcomes             |
| Input, cache write, cache read, output tokens; `total_cost_usd`                       | `stream-json` result `usage` | Wilcoxon signed-rank, bootstrap 95% CI |
| Turns; tool calls by tool                                                             | transcript                   | Wilcoxon                               |
| File recall: gold file opened (y/n), turns until first touch, patch touches gold file | transcript + gold patch      | McNemar / Wilcoxon                     |
| TeaRAGs share (arm 1): tea-rags calls / all search+read calls                         | transcript                   | descriptive                            |
| Index wall time (arm 1)                                                               | `index.jsonl`                | descriptive, not added to agent cost   |

Power: with n = 50 paired tasks only a resolve delta of roughly 15–20 pp is
detectable; the pilot validates the pipeline and measures the token delta, where
paired continuous data has enough power. Full run: 300 tasks × 3 runs per arm.

A low TeaRAGs share in arm 1 means arm 1 did not test TeaRAGs. The report states
the share next to every arm-1 number.

## Spikes that gate the plan

1. `tea-rags worktree create --from` against a standalone (non-linked)
   repository, followed by an incremental index — works, or which addressing the
   forward-seed chain needs instead.
2. Whether subagent usage is included in the `stream-json` result `usage`. If
   not, sum it from the transcript; otherwise the arms are not comparable.
3. SWE-bench evaluation images run on this machine (Apple Silicon); otherwise
   `sb-cli`.

## Out of scope

- Agent-side test execution (variants B/C, rejected).
- Second model / model-strength curve.
- SWE-bench Pro, SWE-bench Live, the code-localization benchmark (step two:
  Rails + Django bug-fix commits, accuracy@k, analogue of JetBrains' 1953
  localization tasks).
- Git-signal ablation inside TeaRAGs (`pdpe`).
