# SWE-bench Lite A/B — Claude Code with vs without TeaRAGs

Runs Claude Code headless on SWE-bench Lite tasks in two arms that differ only
in the tea-rags MCP server and plugin, scores the patches with the official
harness, and reports resolve rate, tokens, turns, tool use and file recall per
arm. Design: `docs/superpowers/specs/2026-10-03-swe-bench-lite-ab-design.md`.
Hypotheses: `PREREGISTRATION.md`.

Nothing here ships in the npm package. Artefacts (mirrors, per-task repos,
indexes, transcripts, harness reports) go to the gitignored `runs/`.

## Prerequisites

- `uv` and Python 3.11+; run `uv sync` in this directory.
- Claude Code CLI (`claude`) on `PATH`.
- OAuth token in `~/.config/swe-lite-ab/oauth-token` (never committed, never
  printed). Each arm runs with its own empty `CLAUDE_CONFIG_DIR` under `runs/`
  and authenticates via `CLAUDE_CODE_OAUTH_TOKEN` read from that file.
- Docker for the evaluation harness (OrbStack: `orb start`).
- Arm 1: `tea-rags` CLI on `PATH` (1.45.1 or later), and the Muninn-small
  embedding endpoints on the nucbox (`http://192.168.1.71:8091`–`8094`, provider
  `llama-server`, model `brokkai/Muninn-small`). The env lives in
  `src/swe_lite_ab/config.py#EMBEDDING_ENV`.

## Stage order

Every stage is `uv run swe-lite-ab <stage>`. `--tasks` picks the task list
(`pilot-50` by default).

The first scored run is `--tasks django-focus-50`: django only, 30 sampled
tasks whose issue does not name the gold file plus all 20 that do (the named
control). Plugin tuning uses `dev-django-5` (5 other not-named django tasks).
The mixed-repo `pilot-50` (with `dev-5`) is the second run.

```bash
uv run swe-lite-ab select --profile django-focus   # tasks/dev-django-5.json + tasks/django-focus-50.json
uv run swe-lite-ab prepare  --tasks django-focus-50  # mirrors + per-task repos (ancestors of base_commit only)
uv run swe-lite-ab index    --tasks django-focus-50  # arm 1 index chain, forward-seeded per repo
uv run swe-lite-ab run-paired --tasks django-focus-50 --parallel 2 --seed 20261003   # both arms, interleaved
uv run swe-lite-ab collect  --tasks django-focus-50 --arm arm0
uv run swe-lite-ab collect  --tasks django-focus-50 --arm arm1
uv run swe-lite-ab evaluate --tasks django-focus-50 --arm arm0
uv run swe-lite-ab evaluate --tasks django-focus-50 --arm arm1
uv run swe-lite-ab report   --tasks django-focus-50  # results/<tasks>-<date>.md + .csv
```

For the second run, `uv run swe-lite-ab select` (profile `pilot`) writes
`tasks/dev-5.json` + `tasks/pilot-50.json`; repeat the stages with
`--tasks pilot-50`.

`run-paired` runs both arms of a task back to back in a per-task random order
(seeded), so API latency and embedder load drift over hours hit both arms
alike instead of confounding the solve-time delta. Both arms of a task share
`runs/repos/<instance_id>` and each agent run resets it to the pristine
`swe-base` branch, so `run-paired` saves each arm's patch to
`runs/<arm>/patches/<instance_id>.diff` before the other arm runs; `collect`
prefers those saved patches.

The single-arm `run --arm <arm>` stage remains for dev tuning (arm 1 only on
`dev-django-5`, or `dev-5` for the second run). With it, `collect` for an arm must follow that arm's `run`
immediately, before another `run` wipes the working tree.

## Layout

| Path                           | What                                              |
| ------------------------------ | ------------------------------------------------- |
| `src/swe_lite_ab/`             | one module per stage, `cli.py` entry point        |
| `tests/`                       | `uv run pytest -q`                                |
| `tasks/`                       | committed task lists                              |
| `results/`                     | committed reports                                 |
| `runs/`                        | gitignored artefacts                              |
| `runs/<arm>/<id>/`             | `transcript.jsonl`, `status.json`, `mcp.json`     |
| `runs/<arm>/predictions.jsonl` | SWE-bench predictions, `model_name_or_path` = arm |
| `runs/reports/`                | harness reports `<arm>.<arm>-<tasks>.json`        |
| `runs/index.jsonl`             | per-task index wall time (arm 1)                  |
