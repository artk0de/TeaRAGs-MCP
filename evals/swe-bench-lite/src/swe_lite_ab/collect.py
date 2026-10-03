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
