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
(`pilot-50` by default, or `dev-5`).

```bash
uv run swe-lite-ab select                     # writes tasks/dev-5.json + tasks/pilot-50.json
uv run swe-lite-ab prepare                    # mirrors + per-task repos (ancestors of base_commit only)
uv run swe-lite-ab index                      # arm 1 index chain, forward-seeded per repo
uv run swe-lite-ab run      --arm arm0
uv run swe-lite-ab collect  --arm arm0
uv run swe-lite-ab run      --arm arm1
uv run swe-lite-ab collect  --arm arm1
uv run swe-lite-ab evaluate --arm arm0
uv run swe-lite-ab evaluate --arm arm1
uv run swe-lite-ab report                     # results/<tasks>-<date>.md + .csv
```

The order matters. Both arms of a task share `runs/repos/<instance_id>`, and
`run` resets that tree to the pristine `swe-base` branch before each agent run.
So `collect` for an arm must follow that arm's `run` immediately, before the
other arm's `run` wipes the working tree.

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
