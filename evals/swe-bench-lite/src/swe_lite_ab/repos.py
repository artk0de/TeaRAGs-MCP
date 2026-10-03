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
        # --bare, not --mirror: GitHub exposes refs/pull/*, which --mirror fetches too (django: 800 MB
        # instead of ~300 MB). Base commits sit on the branch history a bare clone already holds.
        _git(path.parent, "clone", "-q", "--bare", f"https://github.com/{repo}.git", str(path))
    return path


def task_dir(instance_id: str) -> Path:
    return config.REPOS_ROOT / instance_id


INSTRUCTION_FILES = ("CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", ".claude/rules")


def instruction_leaks(repo_dir: Path) -> list[Path]:
    """Claude Code instruction files in strict ancestors of repo_dir, which an agent started there
    would load. The repository's own files are part of the task and are not reported."""
    return [ancestor / name for ancestor in repo_dir.absolute().parents
            for name in INSTRUCTION_FILES if (ancestor / name).exists()]


def prepare_task_repo(task: Task, mirror: Path, dest: Path) -> Path:
    """A fresh repository holding only ancestors of base_commit: no refs to the fix."""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    _git(dest, "init", "-q")
    _git(dest, "fetch", "-q", str(mirror), task.base_commit)
    _git(dest, "checkout", "-q", "--detach", task.base_commit)
    _git(dest, "branch", "-q", "swe-base", task.base_commit)
    install_contextignore(task.repo, dest)
    return dest


def install_contextignore(repo: str, dest: Path) -> None:
    """Copies the repository's .contextignore template into dest and lists it in .git/info/exclude:
    `git clean -fdq` between arms keeps ignored files, and the patch diff never shows it."""
    template = config.CONTEXTIGNORE_DIR / repo.replace("/", "__")
    if not template.exists():
        return
    shutil.copyfile(template, dest / ".contextignore")
    exclude = dest / ".git" / "info" / "exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    with exclude.open("a") as f:
        f.write("/.contextignore\n")
