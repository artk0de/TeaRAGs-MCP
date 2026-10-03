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
