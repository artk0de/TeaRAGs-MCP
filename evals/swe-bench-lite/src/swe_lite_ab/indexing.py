import hashlib
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
    # `worktree create` registers the clone as `<from>-worktree-<name>`, which grows along a chain past
    # the 64-char registry cap; re-register it under the short alias (the collection follows the path).
    clone = "w" + hashlib.sha1(task.instance_id.encode()).hexdigest()[:8]
    return [
        ["tea-rags", "worktree", "create", clone, "--from", previous_alias, "--path", path, "--no-git", "--json"],
        ["tea-rags", "projects", "unregister", "--name", f"{previous_alias}-worktree-{clone}"],
        ["tea-rags", "projects", "register", "--path", path, "--name", alias],
        ["tea-rags", "index-codebase", "--project", alias, "--wait-enrichments", "--json"],
    ]


_INDEX_STAT_KEYS = ("overallMs", "filesCount", "chunksCount")


def index_stats(stdout: str) -> dict:
    """overallMs / filesCount / chunksCount from an `index-codebase --json` run; {} when unparseable."""
    candidates = [stdout] + [line for line in reversed(stdout.splitlines()) if line.lstrip().startswith("{")]
    for text in candidates:
        try:
            data = json.loads(text)
        except ValueError:
            continue
        if isinstance(data, dict):
            return {k: data[k] for k in _INDEX_STAT_KEYS if k in data}
    return {}


def run_chain(tasks: list[Task]) -> list[dict]:
    env = {**os.environ, **config.EMBEDDING_ENV}
    records = []
    for repo_tasks in chain_order(tasks).values():
        previous = None
        for task in repo_tasks:
            started = time.monotonic()
            ok = True
            stats: dict = {}
            for cmd in index_commands(task, previous, config.SEED_MODE):
                proc = subprocess.run(cmd, env=env, capture_output=True, text=True)
                ok = ok and proc.returncode == 0
                if cmd[1] == "index-codebase":
                    stats = index_stats(proc.stdout)
            records.append({"instance_id": task.instance_id, "alias": alias_for(task.instance_id),
                            "seconds": round(time.monotonic() - started, 1), "ok": ok, **stats})
            previous = alias_for(task.instance_id) if ok else previous
    out = config.RUNS / "index.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(r) + "\n" for r in records))
    return records
