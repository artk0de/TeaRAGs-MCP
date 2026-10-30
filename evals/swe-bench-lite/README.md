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
- Task repositories live in `/Users/Shared/swe-lite-ab/repos/` (override with
  `SWE_LITE_AB_REPOS`), not under `runs/`. Claude Code loads `CLAUDE.md`,
  `CLAUDE.local.md` and `.claude/` from every ancestor of its working directory
  regardless of `CLAUDE_CONFIG_DIR`, so a repository under the home directory or
  this checkout would hand both arms the operator's instructions and tea-rags'
  own project rules. `run` refuses a repository with such an ancestor.
- SWE-bench Lite is read once from the Hub and snapshotted to `runs/lite.jsonl`;
  every later stage reads the snapshot offline, so task content stays fixed for
  the experiment. Delete the file to refetch.
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

`index` also records what arm 1 searched over, per task, in `runs/index.jsonl`:
the enrichment `outcome` of the index run, realized codegraph resolve per
receiver kind (from `tea-rags prime`; `null` when prime stays "warm-up pending"
after three tries), and the number of observed `git.file.commitCount`,
`git.chunk.commitCount` and `codegraph.chunk.fanIn` signals (from
`get_index_metrics`). An enrichment can report healthy while writing nothing;
the report flags such indexes.

The single-arm `run --arm <arm>` stage remains for dev tuning (arm 1 only on
`dev-django-5`, or `dev-5` for the second run). With it, `collect` for an arm must follow that arm's `run`
immediately, before another `run` wipes the working tree.

## SWE-rebench (decontaminated run)

Lite is in the model's training data: on django the agent opens the gold file
with its first tool call, with no search at all, and neither arm needs
TeaRAGs. The decontaminated run uses `nebius/SWE-rebench-leaderboard`, which
adds issues every month (through 2026-05 at the time of writing) over ~400
smaller repositories.

```bash
uv run swe-lite-ab select --profile rebench   # tasks/rebench-2026.json
uv run swe-lite-ab prepare --tasks rebench-2026
# ... same stages as above with --tasks rebench-2026
```

- A task list is `{"dataset": "rebench", "ids": [...]}`; a bare id list is Lite.
  Every stage reads the dataset from the list.
- `runs/rebench.jsonl` is written once from the Hub and holds the rows as
  swebench 5.x harness instances (`rebench.to_instance`): the image is the
  task's `docker_image`, and `eval_script` applies the test patch and runs
  `install_config.test_cmd` under `/opt/conda` env `testbed` (the rebench
  images keep conda there, not under `/opt/miniconda3`). `evaluate` passes that
  file as `--dataset_name`, so no rebench harness fork is needed. Checked on
  `copier-org__copier-2646`: gold patch resolved, a no-op patch unresolved.
- Interface tasks (non-empty `interface` column, 49 rows) are dropped: their
  spec names the gold file's path, and without it the tests demand API names
  the agent cannot know.
- Profile `rebench`: every task created since 2026-01 whose patch touches at
  least 2 files and 40 changed lines (`large-bug`, `large-feature`), plus 20
  seeded `small-bug` tasks as the one-file control. The kind is an issue-text
  keyword heuristic (`tasks.stratum`); the report has a section per stratum.

## SWE-bench Pro (Python + TypeScript)

Source: `ScaleAI/SWE-bench_Pro`, split `test` (V2, 642 rows). Kept: every
`repo_language == "python"` row (ansible, openlibrary, qutebrowser — 237) and the
three TypeScript repos (`protonmail/webclients`, `element-hq/element-web`,
`tutao/tutanota` — 111; labelled js/ts, but their patches are `.ts`/`.tsx`).
Go and NodeBB (plain JS) are dropped: the experiment is scoped to Python and
TypeScript, the two languages it compares arms on. The task kind
comes from the dataset's `issue_specificity` (any `*_bug` label → bug).

Needs the tooling checkout (`SWE_PRO_OS`, default
`/Users/Shared/swe-lite-ab/swe-bench-pro-os`): every task's agent input is its
`v2/tasks/<id>/instruction.md` (PR description + requirements + new
interfaces), and the snapshot `runs/pro.jsonl` stores that text as the
`problem_statement`, so `mentions_gold_file` and the agent see the same thing.

```bash
uv run swe-lite-ab select --profile pro                     # tasks/pro-py-ts.json (all 348)
uv run swe-lite-ab probe --tasks pro-py-ts --parallel 4     # runs/probe.jsonl (resumable)
# ... prepare / index / run-paired / collect with --tasks <list>
uv run swe-lite-ab evaluate --arm arm0 --tasks <list>       # local verifier, see below
uv run swe-lite-ab report --tasks <list>
```

**Memorisation probe.** `claude -p` with only the repo name and the
instruction text — `--tools ""`, an empty `--strict-mcp-config`, a fresh
`CLAUDE_CONFIG_DIR`, cwd an empty dir under `/Users/Shared/swe-lite-ab/probe` —
asked to list the files that must change. `hit` = any predicted path equals a
gold file. When `runs/probe.jsonl` exists, the report fills the `memorised`
column and adds the **Not memorised and not named** section: the headline
stratum, where neither recall nor the task text hands the agent the file.

**Grading.** No swebench harness: `pro.grade` runs the V2 verifier contract per
task — `docker run --rm --platform linux/amd64` of
`ghcr.io/scaleapi/swe-bench_pro-v2:<id>`, the task's `tests/` mounted read-only
at `/tests`, the model patch read-only at `/model.patch`, `git apply` in `/app`
(fallback `/testbed`; an empty patch skips it, a non-applying one is
unresolved), then the unchanged `bash /tests/test.sh`. Exit 0 = resolved.
Verifier logs go to `runs/<arm>/eval/<run_id>/<id>.log`; the report lands where
`evaluate.report_path` puts every other dataset's, so `report` is unchanged.

## Component localization benchmark (retrieval only, no LLM)

Measures tea-rags search on its own: for each task, rank the repository's files
for the issue text and score where the gold-patch files land.

```bash
uv run swe-lite-ab prepare  --tasks loc-10
uv run swe-lite-ab index    --tasks loc-10
uv run swe-lite-ab localize --tasks loc-10   # → results/localize-loc-10-<date>.md
```

- **Query**: the ORIGINAL issue text from `OpenHands/SWE-bench_Pro-locagent`
  (`problem_statement`, snapshot `runs/locagent.jsonl`) — not Pro's
  `instruction.md`, which lists file paths. Capped at 6000 chars; truncation is
  noted in the report.
- **Configurations**: `semantic-relevance`, `hybrid-relevance`,
  `hybrid-bugHunt`, `hybrid-hotspots` (`tea-rags call`, `language: python`,
  `filter: {}` so bugHunt/hotspots do not add their production filter — every
  config searches the same chunks and only the ranking differs), and `bm25`, a
  lexical baseline over git-tracked `.py` files (whole files plus path tokens,
  code-aware tokenization). Chunks are paged until 50 distinct files.
- **Metrics** per task × config: rank of the first gold file, recall@1/5/10,
  hit@k, MRR — over gold `.py` files (primary) and every gold file
  (secondary); a gold file outside the top 50 counts as not found. Tasks without
  a gold `.py` are reported, not scored.
- **Output**: top-50 rankings in `runs/localize/<id>/<config>.json`, per-task
  metrics in `runs/localize.jsonl`. `--tasks` also accepts a temporary list
  `runs/<name>.json` (e.g. the subset whose indexes are ready).

## `.contextignore` per repository

`contextignore/<owner>__<repo>` is copied into every task repository of that
repo by `prepare` (and listed in `.git/info/exclude`, so arms never see it in
`git status` and patches never include it). Every template was checked with
`git check-ignore` against the gold files of all the repo's Lite tasks (zero
hits) and against the union of the trees at all their base commits:

| Repo | Ignored | Files / size cut |
| --- | --- | --- |
| astropy | `cextern/`, `astropy/extern/`, PLY tables, `*.xml` | 500 / 15.1 MB |
| django | admin vendor JS, `js_tests/qunit/`, `django/conf/locale/*/`, `*.xml` | 241 / 1.2 MB |
| sympy | `sympy/integrals/rubi/`, `sympy/polys/benchmarks/`, `*.xml` | 59 / 8.6 MB |
| matplotlib | `extern/` (AGG, ttconv) | 191 / 2.6 MB |
| sphinx | theme jQuery / underscore, search stemmers | 40 / 2.3 MB |
| scikit-learn | `sklearn/externals/`, `sklearn/src/cblas/`, doc theme / ML map | 138 / 1.7 MB |
| requests | `requests/packages/` (2013-2014 snapshots) | 118 / 1.2 MB |
| pylint | `doc/data/messages/` | 665 / 72 KB |
| seaborn | `seaborn/external/` | 6 / 64 KB |
| flask, pytest, xarray | nothing — no template | — |

A changed template must be re-checked the same way before a scored run.

## Layout

| Path                           | What                                              |
| ------------------------------ | ------------------------------------------------- |
| `src/swe_lite_ab/`             | one module per stage, `cli.py` entry point        |
| `tests/`                       | `uv run pytest -q`                                |
| `tasks/`                       | committed task lists                              |
| `results/`                     | committed reports                                 |
| `runs/`                        | gitignored artefacts                              |
| `/Users/Shared/swe-lite-ab/repos/<id>/` | per-task repositories (agent cwd)        |
| `runs/<arm>/<id>/`             | `transcript.jsonl`, `status.json`, `mcp.json`     |
| `runs/<arm>/predictions.jsonl` | SWE-bench predictions, `model_name_or_path` = arm |
| `runs/reports/`                | harness reports `<arm>.<arm>-<tasks>.json`        |
| `runs/index.jsonl`             | per-task index wall time (arm 1)                  |
