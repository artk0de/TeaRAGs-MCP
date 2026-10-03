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
