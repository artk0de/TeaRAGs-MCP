# SWE-bench Lite A/B Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dinopowers:executing-plans
> (wraps superpowers:executing-plans) to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reproducible harness that runs Claude Code headless on SWE-bench
Lite tasks with and without TeaRAGs, scores the patches with the official
harness, and reports resolve rate, tokens, turns, tool use and file recall per
arm.

**Architecture:** A small Python package under `evals/swe-bench-lite/`
(`swe_lite_ab`) with one module per pipeline stage and a `cli.py` entry point.
Pure logic (task selection, transcript parsing, statistics, command
construction) is unit-tested with pytest; the side-effecting stages (git,
tea-rags CLI, `claude -p`, Docker) are thin wrappers around `subprocess` that
build their argv with tested pure functions.

**Tech Stack:** Python 3.13, `uv`, `swebench`, `datasets`, `scipy`, `pytest`;
Claude Code 2.1.287 (`claude -p`); tea-rags 1.45.1 CLI; Docker via OrbStack.

**Spec:** `docs/superpowers/specs/2026-10-03-swe-bench-lite-ab-design.md`

## Global Constraints

- Agent model: `claude-sonnet-5-5`, identical in both arms.
- Pilot: 50 tasks × 2 arms × 1 run; 5 dev tasks disjoint from the pilot.
- Dataset: `princeton-nlp/SWE-bench_Lite`, split `test`.
- Arm 1 embedding: `EMBEDDING_PROVIDER=llama-server`,
  `EMBEDDING_MODEL=brokkai/Muninn-small`,
  `EMBEDDING_BASE_URL=http://192.168.1.71:8091,8092,8093,8094`.
- Arms differ only in tea-rags MCP + tea-rags plugin. Each arm runs with its own
  empty `CLAUDE_CONFIG_DIR`; auth via `CLAUDE_CODE_OAUTH_TOKEN` read from
  `~/.config/swe-lite-ab/oauth-token` (never committed, never printed).
- Per-task repositories contain only ancestors of `base_commit`.
- Index seeding goes forward in time only (earlier `base_commit` → later).
- Plugin prompt changes are tuned on the 5 dev tasks only.
- Nothing under `evals/` ships in the npm package (`package.json#files` is a
  whitelist without `evals/`); `evals/swe-bench-lite/runs/` is gitignored.
- Commit scope: `scripts` (non-release).

## File Structure

```
evals/swe-bench-lite/
  pyproject.toml            uv project, deps, pytest config
  README.md                 how to reproduce
  PREREGISTRATION.md        hypotheses, dated before the first scored run
  src/swe_lite_ab/
    __init__.py
    config.py               paths, arm definitions, constants
    tasks.py                dataset load, gold files, stratified selection
    repos.py                mirrors + per-task repositories
    indexing.py             forward-seed index chain (arm 1)
    agent.py                claude -p command construction + run
    transcript.py           stream-json parsing → per-run metrics
    collect.py              git diff → predictions.jsonl
    evaluate.py             official harness invocation
    stats.py                McNemar, Wilcoxon, bootstrap CI
    report.py               join + markdown/CSV report
    cli.py                  `swe-lite-ab <stage>` entry point
  tests/
    conftest.py
    fixtures/stream-sample.jsonl
    test_tasks.py test_repos.py test_indexing.py test_agent.py
    test_transcript.py test_collect.py test_stats.py test_report.py
  tasks/                    committed task lists
  results/                  committed reports
  runs/                     gitignored artefacts
```

Modify: `.gitignore` (add `evals/swe-bench-lite/runs/` and
`evals/swe-bench-lite/.venv/`).

---

### Task 1: Spikes — auth isolation, subagent usage, index seeding, Docker

Findings decide three switches in `config.py` (Task 2). Record every result in
`evals/swe-bench-lite/SPIKES.md`.

**Files:**

- Create: `evals/swe-bench-lite/SPIKES.md`

- [ ] **Step 1: Auth isolation (needs the user's token file).** With an empty
      dir `D` and the token:

```bash
mkdir -p /tmp/swe-iso && CLAUDE_CONFIG_DIR=/tmp/swe-iso \
CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.config/swe-lite-ab/oauth-token)" \
claude -p "Reply with the single word ok" --model claude-sonnet-5-5 \
  --output-format json --strict-mcp-config --no-session-persistence
```

Expected: `"is_error":false`, non-zero `usage.input_tokens`. Then ask the same
session "What instructions from CLAUDE.md files do you have? Answer none if
none." — expected: none (proves the global `CLAUDE.md` is not loaded).

- [ ] **Step 2: Subagent usage.** Same env, prompt: "Use the Agent tool to spawn
      one subagent that replies 'hi', then reply done." with
      `--output-format stream-json --verbose`. Compare the final `result`
      event's `usage` / `modelUsage` against the sum of `message.usage` over all
      assistant events (deduplicated by `message.id`, including events with
      non-null `parent_tool_use_id`). Record whether `result.usage` includes the
      subagent. Decision: `USAGE_SOURCE = "result"` if it does, else `"sum"`.
- [ ] **Step 3: Index seeding on standalone repos.** Build two standalone repos
      of `psf/requests` at two commits A < B (`git init` +
      `git fetch <mirror> <sha>`), then:

```bash
EMBEDDING_PROVIDER=llama-server EMBEDDING_MODEL=brokkai/Muninn-small \
EMBEDDING_BASE_URL=http://192.168.1.71:8091,8092,8093,8094 \
tea-rags index-codebase /tmp/spike/A --name swe-spike-a --no-worktree-seed --wait-enrichments --json
tea-rags worktree create swe-spike-b --from swe-spike-a --path /tmp/spike/B --no-git --json
tea-rags index-codebase --project <alias printed above> --wait-enrichments --json
```

Record: the alias key in `worktree create --json` output, whether the second
index embedded only the diff (`filesIndexed` small), and the registry model for
the clone (`brokkai/Muninn-small`). Decision: `SEED_MODE = "worktree-create"` if
it works, else `"full"` (index every task from scratch). Clean up with
`tea-rags worktree remove` / `unregister_project`.

- [ ] **Step 4: Docker evaluation.** Start OrbStack (`orb start`), then run the
      official harness on the gold patch of one task:

```bash
uv run python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite --predictions_path gold \
  --instance_ids psf__requests-2317 --max_workers 1 --run_id spike-gold \
  --namespace ''
```

Expected: 1 resolved. `--namespace ''` builds images locally (arm64). If it
fails, try `sb-cli submit swe-bench_lite test --predictions_path ...`. Decision:
`EVAL_BACKEND = "local"` or `"sb-cli"`.

- [ ] **Step 5: Commit**

```bash
git add evals/swe-bench-lite/SPIKES.md
git commit -m "docs(scripts): SWE-bench Lite A/B spike findings"
```

### Task 2: Package scaffold, config, task selection

**Files:**

- Create: `evals/swe-bench-lite/pyproject.toml`,
  `src/swe_lite_ab/{__init__,config,tasks}.py`, `tests/{conftest,test_tasks}.py`
- Modify: `.gitignore`

**Interfaces:**

- Produces: `config.ArmConfig(name: str, tea_rags: bool)`, `config.ARMS`,
  `config.EVAL_ROOT: Path`, `config.RUNS: Path`, `config.USAGE_SOURCE`,
  `config.SEED_MODE`, `config.EVAL_BACKEND`; `tasks.Task` (dataclass:
  `instance_id, repo, base_commit, problem_statement, patch, created_at`),
  `tasks.gold_files(patch: str) -> list[str]`,
  `tasks.mentions_gold_file(task: Task) -> bool`,
  `tasks.select_stratified(tasks, n, seed, exclude=frozenset()) -> list[Task]`,
  `tasks.load_lite() -> list[Task]`, `tasks.save_ids / load_ids`.

- [ ] **Step 1: Scaffold**

```toml
# evals/swe-bench-lite/pyproject.toml
[project]
name = "swe-lite-ab"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["swebench>=4", "datasets>=3", "scipy>=1.13"]

[project.scripts]
swe-lite-ab = "swe_lite_ab.cli:main"

[dependency-groups]
dev = ["pytest>=8"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/swe_lite_ab"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

`.gitignore` additions:

```
# SWE-bench Lite A/B artefacts (repos, indexes, transcripts)
evals/swe-bench-lite/runs/
evals/swe-bench-lite/.venv/
```

- [ ] **Step 2: Failing tests**

```python
# tests/test_tasks.py
from swe_lite_ab.tasks import Task, gold_files, mentions_gold_file, select_stratified

PATCH = """diff --git a/requests/models.py b/requests/models.py
--- a/requests/models.py
+++ b/requests/models.py
@@ -1 +1 @@
-a
+b
diff --git a/requests/utils.py b/requests/utils.py
--- a/requests/utils.py
+++ b/requests/utils.py
@@ -1 +1 @@
-a
+b
"""

def task(i, repo="psf/requests", text="", patch=PATCH):
    return Task(f"{repo.split('/')[1]}-{i}", repo, f"sha{i}", text, patch, f"2020-01-{i % 28 + 1:02d}")

def test_gold_files_lists_every_patched_file():
    assert gold_files(PATCH) == ["requests/models.py", "requests/utils.py"]

def test_mentions_gold_file_matches_basename_or_path():
    assert mentions_gold_file(task(1, text="crash in models.py line 3"))
    assert mentions_gold_file(task(2, text="see requests/utils.py"))
    assert not mentions_gold_file(task(3, text="Session drops cookies"))

def test_select_stratified_is_deterministic_and_proportional():
    pool = [task(i, "a/x", text="x.py" if i % 2 else "") for i in range(60)] + \
           [task(i, "b/y", text="") for i in range(60, 80)]
    first = select_stratified(pool, n=20, seed=7)
    assert [t.instance_id for t in first] == [t.instance_id for t in select_stratified(pool, n=20, seed=7)]
    assert len(first) == 20
    assert sum(t.repo == "a/x" for t in first) == 15  # 60/80 of 20

def test_select_stratified_honours_exclude():
    pool = [task(i) for i in range(30)]
    dev = select_stratified(pool, n=5, seed=1)
    pilot = select_stratified(pool, n=20, seed=1, exclude=frozenset(t.instance_id for t in dev))
    assert not {t.instance_id for t in dev} & {t.instance_id for t in pilot}
```

- [ ] **Step 3: Run**
      `cd evals/swe-bench-lite && uv run pytest tests/test_tasks.py -q` —
      expected: FAIL (`ModuleNotFoundError: swe_lite_ab.tasks`).
- [ ] **Step 4: Implement**

```python
# src/swe_lite_ab/config.py
from dataclasses import dataclass
from pathlib import Path

EVAL_ROOT = Path(__file__).resolve().parents[2]
RUNS = EVAL_ROOT / "runs"
TASKS_DIR = EVAL_ROOT / "tasks"
RESULTS_DIR = EVAL_ROOT / "results"
REPO_ROOT = EVAL_ROOT.parents[1]
PLUGIN_DIR = REPO_ROOT / ".claude-plugin" / "tea-rags"
TOKEN_FILE = Path.home() / ".config" / "swe-lite-ab" / "oauth-token"

MODEL = "claude-sonnet-5-5"
DATASET = "princeton-nlp/SWE-bench_Lite"
AGENT_TIMEOUT_S = 1800
MAX_BUDGET_USD = 5.0

EMBEDDING_ENV = {
    "EMBEDDING_PROVIDER": "llama-server",
    "EMBEDDING_MODEL": "brokkai/Muninn-small",
    "EMBEDDING_BASE_URL": "http://192.168.1.71:8091,8092,8093,8094",
    "QDRANT_URL": "embedded",
    "TRAJECTORY_GIT_ENABLED": "true",
    "CODEGRAPH_ENABLED": "true",
    "INGEST_ENABLE_HYBRID": "true",
}

# Decided by Task 1 (SPIKES.md).
USAGE_SOURCE = "sum"            # "result" | "sum"
SEED_MODE = "worktree-create"   # "worktree-create" | "full"
EVAL_BACKEND = "local"          # "local" | "sb-cli"


@dataclass(frozen=True)
class ArmConfig:
    name: str
    tea_rags: bool


ARMS = {"arm0": ArmConfig("arm0", False), "arm1": ArmConfig("arm1", True)}
```

```python
# src/swe_lite_ab/tasks.py
import json
import random
import re
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path

from . import config

_DIFF_HEADER = re.compile(r"^diff --git a/(\S+) b/\S+$", re.M)


@dataclass(frozen=True)
class Task:
    instance_id: str
    repo: str
    base_commit: str
    problem_statement: str
    patch: str
    created_at: str


def gold_files(patch: str) -> list[str]:
    return _DIFF_HEADER.findall(patch)


def mentions_gold_file(task: Task) -> bool:
    text = task.problem_statement
    return any(path in text or path.rsplit("/", 1)[-1] in text for path in gold_files(task.patch))


def select_stratified(tasks: list[Task], n: int, seed: int, exclude: frozenset[str] = frozenset()) -> list[Task]:
    pool = sorted((t for t in tasks if t.instance_id not in exclude), key=lambda t: t.instance_id)
    strata: dict[tuple[str, bool], list[Task]] = defaultdict(list)
    for t in pool:
        strata[(t.repo, mentions_gold_file(t))].append(t)
    rng = random.Random(seed)
    quotas = {k: n * len(v) / len(pool) for k, v in strata.items()}
    take = {k: int(q) for k, q in quotas.items()}
    for k in sorted(quotas, key=lambda k: (quotas[k] - take[k], k), reverse=True)[: n - sum(take.values())]:
        take[k] += 1
    chosen = [t for k in sorted(strata) for t in rng.sample(strata[k], take[k])]
    return sorted(chosen, key=lambda t: t.instance_id)


def load_lite() -> list[Task]:
    from datasets import load_dataset

    rows = load_dataset(config.DATASET, split="test")
    return [Task(r["instance_id"], r["repo"], r["base_commit"], r["problem_statement"], r["patch"], r["created_at"]) for r in rows]


def save_ids(tasks: list[Task], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([t.instance_id for t in tasks], indent=2) + "\n")


def load_ids(path: Path) -> list[str]:
    return json.loads(path.read_text())


def by_ids(tasks: list[Task], ids: list[str]) -> list[Task]:
    index = {t.instance_id: t for t in tasks}
    return [index[i] for i in ids]


def to_json(task: Task) -> dict:
    return asdict(task)
```

The proportional test splits 60/20 across repos; stratum rounding by largest
remainder keeps `a/x` at exactly 15.

- [ ] **Step 5: Run** `uv run pytest tests/test_tasks.py -q` — expected: 4
      passed.
- [ ] **Step 6: Commit**

```bash
git add .gitignore evals/swe-bench-lite/pyproject.toml evals/swe-bench-lite/uv.lock \
  evals/swe-bench-lite/src evals/swe-bench-lite/tests
git commit -m "feat(scripts): SWE-bench Lite A/B harness scaffold and stratified task selection"
```

### Task 3: Per-task repositories without future history

**Files:** Create `src/swe_lite_ab/repos.py`, `tests/test_repos.py`

**Interfaces:**

- Consumes: `tasks.Task`, `config.RUNS`
- Produces: `repos.mirror_dir(repo: str) -> Path`,
  `repos.ensure_mirror(repo: str) -> Path`,
  `repos.task_dir(instance_id: str) -> Path`,
  `repos.prepare_task_repo(task: Task, mirror: Path, dest: Path) -> Path`

- [ ] **Step 1: Failing test** — builds a local origin with commits c1 → c2 (c2
      = "the fix"), prepares a task at c1, asserts c2 is unreachable.

```python
# tests/test_repos.py
import subprocess
from swe_lite_ab.repos import prepare_task_repo
from swe_lite_ab.tasks import Task

def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()

def test_task_repo_has_only_ancestors_of_base_commit(tmp_path):
    origin = tmp_path / "origin"; origin.mkdir()
    git(origin, "init", "-q", "-b", "main")
    (origin / "a.py").write_text("x = 1\n"); git(origin, "add", "."); git(origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c1")
    c1 = git(origin, "rev-parse", "HEAD")
    (origin / "a.py").write_text("x = 2\n"); git(origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "fix")
    c2 = git(origin, "rev-parse", "HEAD")
    mirror = tmp_path / "mirror.git"
    git(tmp_path, "clone", "-q", "--mirror", str(origin), str(mirror))

    dest = prepare_task_repo(Task("t-1", "o/r", c1, "", "", ""), mirror, tmp_path / "task")

    assert git(dest, "rev-parse", "HEAD") == c1
    assert (dest / "a.py").read_text() == "x = 1\n"
    assert c2 not in git(dest, "log", "--all", "--format=%H")
    assert git(dest, "status", "--porcelain") == ""
```

- [ ] **Step 2: Run** `uv run pytest tests/test_repos.py -q` — expected FAIL.
- [ ] **Step 3: Implement**

```python
# src/swe_lite_ab/repos.py
import shutil
import subprocess
from pathlib import Path

from . import config
from .tasks import Task


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def mirror_dir(repo: str) -> Path:
    return config.RUNS / "mirrors" / (repo.replace("/", "__") + ".git")


def ensure_mirror(repo: str) -> Path:
    path = mirror_dir(repo)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        _git(path.parent, "clone", "-q", "--mirror", f"https://github.com/{repo}.git", str(path))
    return path


def task_dir(instance_id: str) -> Path:
    return config.RUNS / "repos" / instance_id


def prepare_task_repo(task: Task, mirror: Path, dest: Path) -> Path:
    """A fresh repository holding only ancestors of base_commit: no refs to the fix."""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    _git(dest, "init", "-q")
    _git(dest, "fetch", "-q", str(mirror), task.base_commit)
    _git(dest, "checkout", "-q", "--detach", task.base_commit)
    _git(dest, "branch", "-q", "swe-base", task.base_commit)
    return dest
```

`git fetch <path> <sha>` needs `uploadpack.allowAnySHA1InWant`; a local path
transport allows it. If the test shows otherwise, set
`git -C <mirror> config uploadpack.allowReachableSHA1InWant true` inside
`ensure_mirror` and in the test fixture.

- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit**
      `feat(scripts): per-task SWE-bench repositories without future history`

### Task 4: Forward-seed index chain (arm 1)

**Files:** Create `src/swe_lite_ab/indexing.py`, `tests/test_indexing.py`

**Interfaces:**

- Consumes: `tasks.Task`, `repos.task_dir`, `config.EMBEDDING_ENV`,
  `config.SEED_MODE`
- Produces: `indexing.alias_for(instance_id: str) -> str`,
  `indexing.chain_order(tasks: list[Task]) -> dict[str, list[Task]]`,
  `indexing.index_commands(task, previous_alias: str | None, seed_mode: str) -> list[list[str]]`,
  `indexing.run_chain(tasks: list[Task]) -> list[dict]` (one record per task:
  `instance_id, alias, seconds, ok`)

- [ ] **Step 1: Failing tests**

```python
# tests/test_indexing.py
from swe_lite_ab.indexing import alias_for, chain_order, index_commands
from swe_lite_ab.tasks import Task

def t(i, repo, date):
    return Task(i, repo, "sha" + i, "", "", date)

def test_alias_is_a_valid_registry_name():
    assert alias_for("Django__django-11099") == "swe-django__django-11099"

def test_chain_order_groups_by_repo_and_sorts_by_date():
    chains = chain_order([t("b", "x/r", "2021"), t("a", "x/r", "2019"), t("c", "y/r", "2020")])
    assert [x.instance_id for x in chains["x/r"]] == ["a", "b"]
    assert [x.instance_id for x in chains["y/r"]] == ["c"]

def test_first_task_indexes_from_scratch():
    cmds = index_commands(t("a", "x/r", "2019"), None, "worktree-create")
    assert cmds == [["tea-rags", "index-codebase", str(cmds[0][2]), "--name", "swe-a",
                     "--no-worktree-seed", "--wait-enrichments", "--json"]]

def test_next_task_seeds_from_the_earlier_one():
    cmds = index_commands(t("b", "x/r", "2021"), "swe-a", "worktree-create")
    assert cmds[0][:4] == ["tea-rags", "worktree", "create", "swe-b"]
    assert cmds[0][4:6] == ["--from", "swe-a"]
    assert "--no-git" in cmds[0]
    assert cmds[1][:2] == ["tea-rags", "index-codebase"]

def test_full_mode_never_seeds():
    assert index_commands(t("b", "x/r", "2021"), "swe-a", "full")[0][1] == "index-codebase"
```

- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement**

```python
# src/swe_lite_ab/indexing.py
import json
import os
import subprocess
import time
from collections import defaultdict

from . import config
from .repos import task_dir
from .tasks import Task


def alias_for(instance_id: str) -> str:
    return ("swe-" + instance_id.lower())[:64]


def chain_order(tasks: list[Task]) -> dict[str, list[Task]]:
    chains: dict[str, list[Task]] = defaultdict(list)
    for t in tasks:
        chains[t.repo].append(t)
    return {repo: sorted(ts, key=lambda t: t.created_at) for repo, ts in chains.items()}


def index_commands(task: Task, previous_alias: str | None, seed_mode: str) -> list[list[str]]:
    path, alias = str(task_dir(task.instance_id)), alias_for(task.instance_id)
    if previous_alias is None or seed_mode == "full":
        return [["tea-rags", "index-codebase", path, "--name", alias, "--no-worktree-seed", "--wait-enrichments", "--json"]]
    return [
        ["tea-rags", "worktree", "create", alias, "--from", previous_alias, "--path", path, "--no-git", "--json"],
        ["tea-rags", "index-codebase", "--project", alias, "--wait-enrichments", "--json"],
    ]


def run_chain(tasks: list[Task]) -> list[dict]:
    env = {**os.environ, **config.EMBEDDING_ENV}
    records = []
    for repo_tasks in chain_order(tasks).values():
        previous = None
        for task in repo_tasks:
            started = time.monotonic()
            ok = True
            for cmd in index_commands(task, previous, config.SEED_MODE):
                proc = subprocess.run(cmd, env=env, capture_output=True, text=True)
                ok = ok and proc.returncode == 0
            records.append({"instance_id": task.instance_id, "alias": alias_for(task.instance_id),
                            "seconds": round(time.monotonic() - started, 1), "ok": ok})
            previous = alias_for(task.instance_id) if ok else previous
    out = config.RUNS / "index.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(r) + "\n" for r in records))
    return records
```

If Task 1 Step 3 shows `worktree create` registers the clone under a different
alias than `<name>`, read the alias from its `--json` output here instead of
`alias_for`, and adjust `test_next_task_seeds_from_the_earlier_one` accordingly
before implementing.

- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit**
      `feat(scripts): forward-seed TeaRAGs index chain for SWE-bench tasks`

### Task 5: Agent command construction and run

**Files:** Create `src/swe_lite_ab/agent.py`, `tests/test_agent.py`

**Interfaces:**

- Consumes: `config.ArmConfig`, `config.*`, `tasks.Task`, `repos.task_dir`
- Produces: `agent.TASK_PROMPT: str`,
  `agent.render_prompt(task, repo_dir) -> str`, `agent.mcp_config(arm) -> dict`,
  `agent.build_command(arm, task, repo_dir, run_dir) -> tuple[list[str], dict[str, str]]`,
  `agent.run_task(arm, task) -> Path` (returns `runs/<arm>/<instance_id>/`)

- [ ] **Step 1: Failing tests**

```python
# tests/test_agent.py
from pathlib import Path
from swe_lite_ab.agent import build_command, render_prompt
from swe_lite_ab.config import ARMS
from swe_lite_ab.tasks import Task

TASK = Task("psf__requests-1", "psf/requests", "abc", "Session drops cookies", "", "2020")

def test_prompt_is_identical_across_arms_and_never_names_tea_rags():
    p = render_prompt(TASK, Path("/r"))
    assert "Session drops cookies" in p and "/r" in p
    assert "tea-rags" not in p.lower() and "tearags" not in p.lower()

def test_arm0_has_no_mcp_and_no_plugin(tmp_path):
    argv, env = build_command(ARMS["arm0"], TASK, Path("/r"), tmp_path)
    assert "--strict-mcp-config" in argv
    assert "--plugin-dir" not in argv
    assert '"mcpServers": {}' in (tmp_path / "mcp.json").read_text()
    assert env["CLAUDE_CONFIG_DIR"] == str(tmp_path / "config")

def test_arm1_adds_tea_rags_mcp_and_plugin_only(tmp_path):
    a0, _ = build_command(ARMS["arm0"], TASK, Path("/r"), tmp_path / "a0")
    a1, env = build_command(ARMS["arm1"], TASK, Path("/r"), tmp_path / "a1")
    extra = [x for x in a1 if x not in a0]
    assert "--plugin-dir" in a1
    assert '"tea-rags"' in (tmp_path / "a1" / "mcp.json").read_text()
    assert set(extra) <= {"--plugin-dir", str(Path(a1[a1.index("--plugin-dir") + 1])),
                          str(tmp_path / "a1" / "mcp.json")}

def test_both_arms_share_model_and_limits(tmp_path):
    a0, _ = build_command(ARMS["arm0"], TASK, Path("/r"), tmp_path / "a0")
    a1, _ = build_command(ARMS["arm1"], TASK, Path("/r"), tmp_path / "a1")
    for flag in ("--model", "--max-budget-usd", "--output-format"):
        assert a0[a0.index(flag) + 1] == a1[a1.index(flag) + 1]
```

- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement**

```python
# src/swe_lite_ab/agent.py
import json
import os
import subprocess
from pathlib import Path

from . import config
from .config import ArmConfig
from .repos import task_dir
from .tasks import Task

TASK_PROMPT = """You are working in the git repository at {repo_dir}.

Resolve the following GitHub issue by editing the source code in that repository.

<issue>
{problem_statement}
</issue>

Rules:
- Make the minimal change to non-test source files that resolves the issue.
- Do not add or modify tests.
- No test environment is available: the project's dependencies are not installed,
  so do not try to run the test suite.
- When you are done, stop. Your changes are collected with `git diff`.
"""


def render_prompt(task: Task, repo_dir: Path) -> str:
    return TASK_PROMPT.format(repo_dir=repo_dir, problem_statement=task.problem_statement)


def mcp_config(arm: ArmConfig) -> dict:
    if not arm.tea_rags:
        return {"mcpServers": {}}
    return {"mcpServers": {"tea-rags": {"type": "stdio", "command": "tea-rags", "args": ["server"],
                                        "env": dict(config.EMBEDDING_ENV)}}}


def build_command(arm: ArmConfig, task: Task, repo_dir: Path, run_dir: Path) -> tuple[list[str], dict[str, str]]:
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "config").mkdir(exist_ok=True)
    mcp_path = run_dir / "mcp.json"
    mcp_path.write_text(json.dumps(mcp_config(arm), indent=2))
    argv = ["claude", "-p", render_prompt(task, repo_dir),
            "--model", config.MODEL,
            "--output-format", "stream-json", "--verbose",
            "--max-budget-usd", str(config.MAX_BUDGET_USD),
            "--dangerously-skip-permissions",
            "--no-session-persistence",
            "--strict-mcp-config", "--mcp-config", str(mcp_path)]
    if arm.tea_rags:
        argv += ["--plugin-dir", str(config.PLUGIN_DIR)]
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "ANTHROPIC"))}
    env["CLAUDE_CONFIG_DIR"] = str(run_dir / "config")
    if config.TOKEN_FILE.exists():
        env["CLAUDE_CODE_OAUTH_TOKEN"] = config.TOKEN_FILE.read_text().strip()
    return argv, env


def reset_repo(repo_dir: Path) -> None:
    """Both arms share runs/repos/<id>; every run starts from the pristine base."""
    subprocess.run(["git", "checkout", "-q", "--force", "swe-base"], cwd=repo_dir, check=True)
    subprocess.run(["git", "clean", "-fdq"], cwd=repo_dir, check=True)


def run_task(arm: ArmConfig, task: Task) -> Path:
    repo_dir = task_dir(task.instance_id)
    reset_repo(repo_dir)
    run_dir = config.RUNS / arm.name / task.instance_id
    argv, env = build_command(arm, task, repo_dir, run_dir)
    with (run_dir / "transcript.jsonl").open("w") as out:
        try:
            proc = subprocess.run(argv, cwd=repo_dir, env=env, stdout=out, stderr=subprocess.PIPE,
                                  text=True, timeout=config.AGENT_TIMEOUT_S)
            status = {"returncode": proc.returncode, "timeout": False, "stderr": proc.stderr[-4000:]}
        except subprocess.TimeoutExpired:
            status = {"returncode": None, "timeout": True, "stderr": ""}
    (run_dir / "status.json").write_text(json.dumps(status, indent=2))
    return run_dir
```

`test_arm0_has_no_mcp_and_no_plugin` asserts `'"mcpServers": {}'`, which is what
`json.dumps(..., indent=2)` produces for the empty dict.

- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit**
      `feat(scripts): Claude Code headless runner with isolated per-arm config`

### Task 6: Transcript metrics

**Files:** Create `src/swe_lite_ab/transcript.py`,
`tests/fixtures/stream-sample.jsonl`, `tests/test_transcript.py`

**Interfaces:**

- Consumes: `config.USAGE_SOURCE`, `tasks.gold_files`
- Produces: `transcript.RunMetrics` (dataclass:
  `input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, cost_usd, turns, tool_calls: dict[str,int], tea_rags_calls, search_read_calls, gold_touched: bool, turns_to_gold: int | None, is_error: bool`),
  `transcript.parse(lines: Iterable[str], gold: list[str], usage_source: str) -> RunMetrics`

- [ ] **Step 1: Fixture** — five events: one assistant `tool_use` Bash
      `grep -rn cookie requests/`, one assistant `tool_use`
      `mcp__tea-rags__hybrid_search`, a `user` `tool_result` whose text contains
      `"relativePath":"requests/sessions.py"`, one subagent assistant event
      (`parent_tool_use_id` set) with usage, one assistant `tool_use` `Edit` on
      `requests/sessions.py`, and a final `result` event.

```jsonl
{"type":"assistant","parent_tool_use_id":null,"message":{"id":"m1","usage":{"input_tokens":100,"cache_creation_input_tokens":10,"cache_read_input_tokens":0,"output_tokens":5},"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"grep -rn cookie requests/"}}]}}
{"type":"assistant","parent_tool_use_id":null,"message":{"id":"m2","usage":{"input_tokens":20,"cache_creation_input_tokens":0,"cache_read_input_tokens":110,"output_tokens":7},"content":[{"type":"tool_use","id":"t2","name":"mcp__tea-rags__hybrid_search","input":{"query":"cookie"}}]}}
{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":[{"type":"text","text":"{\"results\":[{\"payload\":{\"relativePath\":\"requests/sessions.py\"}}]}"}]}]}}
{"type":"assistant","parent_tool_use_id":"t9","message":{"id":"s1","usage":{"input_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":3},"content":[{"type":"text","text":"sub"}]}}
{"type":"assistant","parent_tool_use_id":null,"message":{"id":"m3","usage":{"input_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":130,"output_tokens":40},"content":[{"type":"tool_use","id":"t3","name":"Edit","input":{"file_path":"/r/requests/sessions.py"}}]}}
{"type":"result","is_error":false,"num_turns":3,"total_cost_usd":0.12,"usage":{"input_tokens":125,"cache_creation_input_tokens":10,"cache_read_input_tokens":240,"output_tokens":52}}
```

- [ ] **Step 2: Failing tests**

```python
# tests/test_transcript.py
from pathlib import Path
from swe_lite_ab.transcript import parse

LINES = (Path(__file__).parent / "fixtures" / "stream-sample.jsonl").read_text().splitlines()

def test_sum_mode_counts_subagent_usage_once_per_message():
    m = parse(LINES, ["requests/sessions.py"], "sum")
    assert (m.input_tokens, m.cache_write_tokens, m.cache_read_tokens, m.output_tokens) == (175, 10, 240, 55)

def test_result_mode_reads_the_final_event():
    m = parse(LINES, ["requests/sessions.py"], "result")
    assert m.input_tokens == 125 and m.output_tokens == 52 and m.cost_usd == 0.12

def test_tool_accounting_and_tea_rags_share():
    m = parse(LINES, ["requests/sessions.py"], "sum")
    assert m.tool_calls == {"Bash": 1, "mcp__tea-rags__hybrid_search": 1, "Edit": 1}
    assert m.tea_rags_calls == 1 and m.search_read_calls == 2

def test_gold_touch_counts_tea_rags_results_and_turn_index():
    m = parse(LINES, ["requests/sessions.py"], "sum")
    assert m.gold_touched and m.turns_to_gold == 2
    assert not parse(LINES, ["requests/models.py"], "sum").gold_touched
```

- [ ] **Step 3: Run** — expected FAIL.
- [ ] **Step 4: Implement**

```python
# src/swe_lite_ab/transcript.py
import json
from collections import Counter
from dataclasses import dataclass, field
from typing import Iterable

SEARCH_READ_TOOLS = {"Bash", "Read", "Grep", "Glob"}
TEA_RAGS_PREFIX = "mcp__tea-rags__"


@dataclass
class RunMetrics:
    input_tokens: int = 0
    cache_write_tokens: int = 0
    cache_read_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    turns: int = 0
    tool_calls: dict[str, int] = field(default_factory=dict)
    tea_rags_calls: int = 0
    search_read_calls: int = 0
    gold_touched: bool = False
    turns_to_gold: int | None = None
    is_error: bool = True


def _mentions(text: str, gold: list[str]) -> bool:
    return any(g in text for g in gold)


def parse(lines: Iterable[str], gold: list[str], usage_source: str) -> RunMetrics:
    m = RunMetrics()
    seen: set[str] = set()
    tools: Counter[str] = Counter()
    main_turn = 0
    for line in lines:
        if not line.strip():
            continue
        event = json.loads(line)
        kind = event.get("type")
        if kind == "assistant":
            msg = event["message"]
            if msg["id"] not in seen:
                seen.add(msg["id"])
                u = msg.get("usage") or {}
                if usage_source == "sum":
                    m.input_tokens += u.get("input_tokens", 0)
                    m.cache_write_tokens += u.get("cache_creation_input_tokens", 0)
                    m.cache_read_tokens += u.get("cache_read_input_tokens", 0)
                    m.output_tokens += u.get("output_tokens", 0)
                if event.get("parent_tool_use_id") is None:
                    main_turn += 1
            for block in msg.get("content", []):
                if block.get("type") != "tool_use":
                    continue
                tools[block["name"]] += 1
                if not m.gold_touched and _mentions(json.dumps(block.get("input", {})), gold):
                    m.gold_touched, m.turns_to_gold = True, main_turn
        elif kind == "user" and not m.gold_touched:
            if _mentions(json.dumps(event.get("message", {})), gold):
                m.gold_touched, m.turns_to_gold = True, main_turn
        elif kind == "result":
            m.is_error = bool(event.get("is_error"))
            m.turns = event.get("num_turns", main_turn)
            m.cost_usd = event.get("total_cost_usd", 0.0)
            if usage_source == "result":
                u = event.get("usage") or {}
                m.input_tokens = u.get("input_tokens", 0)
                m.cache_write_tokens = u.get("cache_creation_input_tokens", 0)
                m.cache_read_tokens = u.get("cache_read_input_tokens", 0)
                m.output_tokens = u.get("output_tokens", 0)
    m.tool_calls = dict(tools)
    m.tea_rags_calls = sum(n for name, n in tools.items() if name.startswith(TEA_RAGS_PREFIX))
    m.search_read_calls = m.tea_rags_calls + sum(n for name, n in tools.items() if name in SEARCH_READ_TOOLS)
    return m
```

`search_read_calls` in the fixture is 2 (Bash + the tea-rags call); `Edit` is
not a search/read tool. Gold is touched on main turn 2: the tea-rags result
lists `requests/sessions.py` after the second main assistant message.

- [ ] **Step 5: Run** — expected PASS.
- [ ] **Step 6: Commit**
      `feat(scripts): stream-json transcript metrics for SWE-bench runs`

### Task 7: Collect predictions and evaluate

**Files:** Create `src/swe_lite_ab/collect.py`, `src/swe_lite_ab/evaluate.py`,
`tests/test_collect.py`

**Interfaces:**

- Consumes: `repos.task_dir`, `config.EVAL_BACKEND`, `config.DATASET`
- Produces: `collect.diff_for(repo_dir: Path, base_commit: str) -> str`,
  `collect.write_predictions(arm: str, tasks: list[Task]) -> Path`,
  `evaluate.harness_command(arm: str, predictions: Path, ids: list[str], run_id: str) -> list[str]`,
  `evaluate.run(arm: str, tasks: list[Task], run_id: str) -> Path` (report
  path), `evaluate.resolved_ids(report: Path) -> set[str]`

- [ ] **Step 1: Failing tests**

```python
# tests/test_collect.py
import subprocess
from swe_lite_ab.collect import diff_for
from swe_lite_ab.evaluate import harness_command

def test_diff_includes_new_and_modified_files_but_not_untracked_junk(tmp_path):
    run = lambda *a: subprocess.run(["git", *a], cwd=tmp_path, check=True, capture_output=True, text=True).stdout.strip()
    run("init", "-q"); (tmp_path / "a.py").write_text("x = 1\n"); run("add", ".")
    run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base")
    base = run("rev-parse", "HEAD")
    (tmp_path / "a.py").write_text("x = 2\n"); (tmp_path / "b.py").write_text("y = 1\n")
    (tmp_path / "__pycache__").mkdir(); (tmp_path / "__pycache__" / "a.pyc").write_bytes(b"\0")
    d = diff_for(tmp_path, base)
    assert "a/a.py" in d and "b/b.py" in d and "pyc" not in d

def test_harness_command_targets_lite_with_local_images(tmp_path):
    cmd = harness_command("arm1", tmp_path / "p.jsonl", ["x-1", "y-2"], "arm1-pilot")
    assert cmd[:3] == ["python", "-m", "swebench.harness.run_evaluation"]
    assert cmd[cmd.index("--dataset_name") + 1] == "princeton-nlp/SWE-bench_Lite"
    assert cmd[cmd.index("--instance_ids") + 1 : cmd.index("--instance_ids") + 3] == ["x-1", "y-2"]
```

- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement**

```python
# src/swe_lite_ab/collect.py
import json
import subprocess
from pathlib import Path

from . import config
from .repos import task_dir
from .tasks import Task

_JUNK = ("__pycache__/", ".pyc", ".egg-info/", ".pytest_cache/")


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


def diff_for(repo_dir: Path, base_commit: str) -> str:
    untracked = [p for p in _git(repo_dir, "ls-files", "--others", "--exclude-standard").splitlines()
                 if not any(j in p for j in _JUNK)]
    if untracked:
        _git(repo_dir, "add", "--intent-to-add", "--", *untracked)
    return _git(repo_dir, "diff", base_commit, "--", ".", *[f":(exclude)*{j.rstrip('/')}*" for j in _JUNK])


def write_predictions(arm: str, tasks: list[Task]) -> Path:
    out = config.RUNS / arm / "predictions.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w") as f:
        for t in tasks:
            f.write(json.dumps({"instance_id": t.instance_id, "model_name_or_path": arm,
                                "model_patch": diff_for(task_dir(t.instance_id), t.base_commit)}) + "\n")
    return out
```

```python
# src/swe_lite_ab/evaluate.py
import json
import subprocess
from pathlib import Path

from . import config
from .tasks import Task


def harness_command(arm: str, predictions: Path, ids: list[str], run_id: str) -> list[str]:
    return ["python", "-m", "swebench.harness.run_evaluation",
            "--dataset_name", config.DATASET, "--predictions_path", str(predictions),
            "--instance_ids", *ids, "--max_workers", "4", "--run_id", run_id,
            "--namespace", "", "--cache_level", "env", "--clean", "True"]


def run(arm: str, tasks: list[Task], run_id: str) -> Path:
    predictions = config.RUNS / arm / "predictions.jsonl"
    subprocess.run(harness_command(arm, predictions, [t.instance_id for t in tasks], run_id),
                   cwd=config.RUNS, check=True)
    return config.RUNS / f"{arm}.{run_id}.json"


def resolved_ids(report: Path) -> set[str]:
    return set(json.loads(report.read_text()).get("resolved_ids", []))
```

The report filename `<model_name_or_path>.<run_id>.json` is what the harness
writes in its working directory; confirm it against the Task 1 Step 4 spike
output and adjust `run` if the name differs. Each worktree has its own repos, so
`git add --intent-to-add` mutates nothing shared.

- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit**
      `feat(scripts): collect SWE-bench predictions and run the official harness`

### Task 8: Statistics and report

**Files:** Create `src/swe_lite_ab/stats.py`, `src/swe_lite_ab/report.py`,
`tests/test_stats.py`, `tests/test_report.py`

**Interfaces:**

- Consumes: `transcript.RunMetrics`, `evaluate.resolved_ids`,
  `tasks.mentions_gold_file`
- Produces: `stats.mcnemar(a: list[bool], b: list[bool]) -> float` (exact
  two-sided p), `stats.wilcoxon_p(a, b) -> float`,
  `stats.bootstrap_ci(diffs: list[float], seed=0, n=10000) -> tuple[float, float]`,
  `report.Row` (per task × arm), `report.build_rows(...) -> list[Row]`,
  `report.render(rows) -> str`

- [ ] **Step 1: Failing tests**

```python
# tests/test_stats.py
from swe_lite_ab.stats import bootstrap_ci, mcnemar, wilcoxon_p

def test_mcnemar_exact_on_discordant_pairs():
    a = [True] * 10 + [False] * 10
    b = [True] * 10 + [True] * 8 + [False] * 2   # 8 discordant, all favour b
    assert round(mcnemar(a, b), 4) == 0.0078

def test_mcnemar_is_one_without_discordance():
    assert mcnemar([True, False], [True, False]) == 1.0

def test_wilcoxon_detects_consistent_shift():
    assert wilcoxon_p([10, 12, 14, 16, 18, 20, 22, 24], [5, 6, 8, 9, 10, 12, 13, 15]) < 0.05

def test_bootstrap_ci_brackets_the_mean():
    lo, hi = bootstrap_ci([1.0, 2.0, 3.0, 4.0, 5.0])
    assert lo < 3.0 < hi
```

```python
# tests/test_report.py
from swe_lite_ab.report import Row, render

def row(arm, i, resolved, tokens, mentioned):
    return Row(arm=arm, instance_id=f"t{i}", repo="psf/requests", mentioned=mentioned, resolved=resolved,
               input_tokens=tokens, cache_write_tokens=0, cache_read_tokens=tokens * 10, output_tokens=tokens // 10,
               cost_usd=tokens / 1e5, turns=10, tool_calls_total=20 if arm == "arm0" else 12,
               tea_rags_calls=3 if arm == "arm1" else 0, search_read_calls=6, gold_touched=True, turns_to_gold=2)

def test_render_has_headline_strata_and_tea_rags_share():
    rows = [row("arm0", i, i < 2, 1000, i % 2 == 0) for i in range(4)] + \
           [row("arm1", i, i < 3, 800, i % 2 == 0) for i in range(4)]
    md = render(rows)
    assert "| Resolved | 2/4 (50.0%) | 3/4 (75.0%) |" in md
    assert "Gold file named in issue" in md and "Gold file not named" in md
    assert "TeaRAGs share of search/read calls: 50.0%" in md

def test_render_reports_tool_calls_as_a_paired_metric():
    rows = [row("arm0", i, False, 1000, True) for i in range(4)] + \
           [row("arm1", i, False, 800, True) for i in range(4)]
    assert "| median tool_calls_total | 20 | 12 |" in render(rows)
```

- [ ] **Step 2: Run** — expected FAIL.
- [ ] **Step 3: Implement**

```python
# src/swe_lite_ab/stats.py
import random

from scipy.stats import binomtest, wilcoxon


def mcnemar(a: list[bool], b: list[bool]) -> float:
    only_a = sum(x and not y for x, y in zip(a, b))
    only_b = sum(y and not x for x, y in zip(a, b))
    if only_a + only_b == 0:
        return 1.0
    return binomtest(only_a, only_a + only_b, 0.5).pvalue


def wilcoxon_p(a: list[float], b: list[float]) -> float:
    if all(x == y for x, y in zip(a, b)):
        return 1.0
    return float(wilcoxon(a, b).pvalue)


def bootstrap_ci(diffs: list[float], seed: int = 0, n: int = 10000) -> tuple[float, float]:
    rng = random.Random(seed)
    means = sorted(sum(rng.choices(diffs, k=len(diffs))) / len(diffs) for _ in range(n))
    return means[int(0.025 * n)], means[int(0.975 * n) - 1]
```

```python
# src/swe_lite_ab/report.py
from dataclasses import dataclass
from statistics import median

from .stats import bootstrap_ci, mcnemar, wilcoxon_p

PAIRED_FIELDS = ("input_tokens", "cache_write_tokens", "cache_read_tokens", "output_tokens", "cost_usd",
                 "turns", "tool_calls_total", "search_read_calls")


@dataclass
class Row:
    arm: str
    instance_id: str
    repo: str
    mentioned: bool
    resolved: bool
    input_tokens: int
    cache_write_tokens: int
    cache_read_tokens: int
    output_tokens: int
    cost_usd: float
    turns: int
    tool_calls_total: int
    tea_rags_calls: int
    search_read_calls: int
    gold_touched: bool
    turns_to_gold: int | None


def _pairs(rows: list[Row]) -> list[tuple[Row, Row]]:
    a0 = {r.instance_id: r for r in rows if r.arm == "arm0"}
    a1 = {r.instance_id: r for r in rows if r.arm == "arm1"}
    return [(a0[i], a1[i]) for i in sorted(a0.keys() & a1.keys())]


def _pct(k: int, n: int) -> str:
    return f"{k}/{n} ({100 * k / n:.1f}%)" if n else "0/0"


def _section(title: str, pairs: list[tuple[Row, Row]]) -> list[str]:
    n = len(pairs)
    r0 = [p[0].resolved for p in pairs]
    r1 = [p[1].resolved for p in pairs]
    out = [f"## {title} (n={n})", "", "| Metric | arm0 | arm1 | p |", "|---|---|---|---|",
           f"| Resolved | {_pct(sum(r0), n)} | {_pct(sum(r1), n)} | {mcnemar(r0, r1):.3f} (McNemar) |"]
    for f in PAIRED_FIELDS:
        v0 = [getattr(p[0], f) for p in pairs]
        v1 = [getattr(p[1], f) for p in pairs]
        lo, hi = bootstrap_ci([y - x for x, y in zip(v0, v1)])
        out.append(f"| median {f} | {median(v0):.4g} | {median(v1):.4g} | "
                   f"{wilcoxon_p(v0, v1):.3f} (Wilcoxon); Δ mean 95% CI [{lo:.4g}, {hi:.4g}] |")
    g0 = [p[0].gold_touched for p in pairs]
    g1 = [p[1].gold_touched for p in pairs]
    out += [f"| Gold file touched | {_pct(sum(g0), n)} | {_pct(sum(g1), n)} | {mcnemar(g0, g1):.3f} (McNemar) |", ""]
    return out


def render(rows: list[Row]) -> str:
    pairs = _pairs(rows)
    if not pairs:
        return "# SWE-bench Lite A/B\n\nNo paired results.\n"
    tr = sum(p[1].tea_rags_calls for p in pairs)
    sr = sum(p[1].search_read_calls for p in pairs)
    lines = ["# SWE-bench Lite A/B — Claude Code with vs without TeaRAGs", "",
             f"TeaRAGs share of search/read calls: {100 * tr / sr:.1f}%" if sr else "TeaRAGs share: n/a", ""]
    lines += _section("All tasks", pairs)
    lines += _section("Gold file named in issue", [p for p in pairs if p[0].mentioned])
    lines += _section("Gold file not named", [p for p in pairs if not p[0].mentioned])
    return "\n".join(lines) + "\n"
```

`build_rows` (in `report.py`) joins `tasks` + `transcript.parse` of each
`runs/<arm>/<id>/transcript.jsonl` + `resolved_ids` of each arm's harness
report, and also writes `results/pilot-<date>.csv` with every Row field:

```python
def build_rows(tasks, resolved_by_arm: dict[str, set[str]], usage_source: str) -> list[Row]:
    from . import config
    from .tasks import gold_files, mentions_gold_file
    from .transcript import parse

    rows = []
    for arm in ("arm0", "arm1"):
        for t in tasks:
            path = config.RUNS / arm / t.instance_id / "transcript.jsonl"
            if not path.exists():
                continue
            m = parse(path.read_text().splitlines(), gold_files(t.patch), usage_source)
            rows.append(Row(arm, t.instance_id, t.repo, mentions_gold_file(t), t.instance_id in resolved_by_arm[arm],
                            m.input_tokens, m.cache_write_tokens, m.cache_read_tokens, m.output_tokens, m.cost_usd,
                            m.turns, sum(m.tool_calls.values()), m.tea_rags_calls, m.search_read_calls,
                            m.gold_touched, m.turns_to_gold))
    return rows
```

- [ ] **Step 4: Run** `uv run pytest -q` — expected: all tests pass.
- [ ] **Step 5: Commit**
      `feat(scripts): paired statistics and markdown report for SWE-bench A/B`

### Task 9: CLI, README, pre-registration

**Files:** Create `src/swe_lite_ab/cli.py`, `README.md`, `PREREGISTRATION.md`,
`tasks/pilot-50.json`, `tasks/dev-5.json`

- [ ] **Step 1: CLI** — subcommands map 1:1 to stages; `--tasks` picks
      `pilot-50` or `dev-5`.

```python
# src/swe_lite_ab/cli.py
import argparse
import datetime as dt
import json
from concurrent.futures import ThreadPoolExecutor

from . import agent, collect, config, evaluate, indexing, report, repos, tasks


def _tasks(name: str) -> list[tasks.Task]:
    return tasks.by_ids(tasks.load_lite(), tasks.load_ids(config.TASKS_DIR / f"{name}.json"))


def main() -> None:
    p = argparse.ArgumentParser(prog="swe-lite-ab")
    sub = p.add_subparsers(dest="stage", required=True)
    sub.add_parser("select")
    for stage in ("prepare", "index", "run", "collect", "evaluate", "report"):
        s = sub.add_parser(stage)
        s.add_argument("--tasks", default="pilot-50")
        if stage in ("run", "collect", "evaluate"):
            s.add_argument("--arm", choices=sorted(config.ARMS), required=True)
        if stage == "run":
            s.add_argument("--parallel", type=int, default=2)
    a = p.parse_args()

    if a.stage == "select":
        lite = tasks.load_lite()
        dev = tasks.select_stratified(lite, n=5, seed=20261003)
        pilot = tasks.select_stratified(lite, n=50, seed=20261003, exclude=frozenset(t.instance_id for t in dev))
        tasks.save_ids(dev, config.TASKS_DIR / "dev-5.json")
        tasks.save_ids(pilot, config.TASKS_DIR / "pilot-50.json")
        return
    ts = _tasks(a.tasks)
    if a.stage == "prepare":
        for t in ts:
            repos.prepare_task_repo(t, repos.ensure_mirror(t.repo), repos.task_dir(t.instance_id))
    elif a.stage == "index":
        print(json.dumps(indexing.run_chain(ts), indent=2))
    elif a.stage == "run":
        arm = config.ARMS[a.arm]
        with ThreadPoolExecutor(a.parallel) as pool:
            list(pool.map(lambda t: agent.run_task(arm, t), ts))
    elif a.stage == "collect":
        collect.write_predictions(a.arm, ts)
    elif a.stage == "evaluate":
        evaluate.run(a.arm, ts, f"{a.arm}-{a.tasks}")
    elif a.stage == "report":
        resolved = {arm: evaluate.resolved_ids(config.RUNS / f"{arm}.{arm}-{a.tasks}.json") for arm in config.ARMS}
        rows = report.build_rows(ts, resolved, config.USAGE_SOURCE)
        out = config.RESULTS_DIR / f"{a.tasks}-{dt.date.today()}.md"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(report.render(rows))
        print(out)
```

Both arms of one task share `runs/repos/<id>`; `agent.run_task` resets it via
`agent.reset_repo` (Task 5), so `collect` for an arm must run right after that
arm's `run`, before the other arm resets the tree. Encode the order in the
README.

- [ ] **Step 2: `select`** — `uv run swe-lite-ab select`; verify
      `tasks/pilot-50.json` has 50 ids, `tasks/dev-5.json` has 5, disjoint.
- [ ] **Step 3: PREREGISTRATION.md** — hypotheses H1 (resolve arm1 > arm0), H2
      (median total input tokens arm1 < arm0), H3 (effect larger in "gold file
      not named"), analysis plan (McNemar / Wilcoxon / bootstrap), exclusion
      rule (a run with `is_error` or timeout counts as unresolved and stays in
      the token analysis with its partial usage), dated 2026-10-03, committed
      before the first scored run.
- [ ] **Step 4: README.md** — prerequisites (token file, OrbStack, nucbox Muninn
      endpoints, tea-rags version), the stage order:
      `select → prepare → index → run arm0 → collect arm0 → run arm1 →     collect arm1 → evaluate arm0 → evaluate arm1 → report`.
- [ ] **Step 5: Commit**
      `feat(scripts): SWE-bench A/B CLI, pre-registration and task lists`

### Task 10: Plugin prompt tuning on dev tasks

**Files:** possibly modify `.claude-plugin/tea-rags/rules/search-cascade.md`,
`.claude-plugin/tea-rags/rules/references/subagent-injection.md` (owner:
artk0de; search-cascade has 70 commits and was edited today under `WTO-5`).

- [ ] **Step 1:** `prepare` + `index` + `run --arm arm1` on `--tasks dev-5`.
- [ ] **Step 2:** `report --tasks dev-5`; read the TeaRAGs share and the
      transcripts. Target: ≥60% of search/read calls go to TeaRAGs, and no
      transcript shows a tea-rags failure (wrong `path`, drift refusal,
      embedding error).
- [ ] **Step 3:** If below target, change the plugin prose (one focused edit per
      round), bump the plugin patch version, rerun dev-5 arm 1. At most 3
      rounds. Record share per round in `SPIKES.md`.
- [ ] **Step 4: Commit** each plugin edit as `improve(plugin): …` with the
      measured share in the body.

### Task 11: Pilot run and report

- [ ] **Step 1:** `prepare` + `index` on pilot-50; check `runs/index.jsonl` has
      50 `ok: true`.
- [ ] **Step 2:** Run arms in the README order (arm0, collect, arm1, collect).
- [ ] **Step 3:** `evaluate` both arms; `report --tasks pilot-50`.
- [ ] **Step 4:** Commit `results/pilot-50-<date>.md` + CSV as
      `docs(scripts): SWE-bench Lite pilot results (50 tasks)`.

```

```
