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
