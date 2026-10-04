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


def test_instruction_leaks_names_ancestor_claude_md_and_rules(tmp_path):
    from swe_lite_ab.repos import instruction_leaks
    (tmp_path / "CLAUDE.md").write_text("x")
    (tmp_path / "a" / ".claude" / "rules").mkdir(parents=True)
    repo = tmp_path / "a" / "b" / "repo"; repo.mkdir(parents=True)
    (repo / "CLAUDE.md").write_text("the task repository's own file is part of the task")

    leaks = instruction_leaks(repo)

    assert tmp_path / "CLAUDE.md" in leaks
    assert tmp_path / "a" / ".claude" / "rules" in leaks
    assert repo / "CLAUDE.md" not in leaks


def test_default_repos_root_is_outside_any_instruction_tree():
    from swe_lite_ab import config
    from swe_lite_ab.repos import instruction_leaks
    assert instruction_leaks(config.REPOS_ROOT / "probe") == []


def test_prepare_installs_the_repo_contextignore_invisible_to_git(tmp_path, monkeypatch):
    from swe_lite_ab import config
    origin = tmp_path / "origin"; origin.mkdir()
    git(origin, "init", "-q", "-b", "main")
    (origin / "a.py").write_text("x = 1\n"); git(origin, "add", "."); git(origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c1")
    c1 = git(origin, "rev-parse", "HEAD")
    mirror = tmp_path / "mirror.git"
    git(tmp_path, "clone", "-q", "--mirror", str(origin), str(mirror))
    templates = tmp_path / "contextignore"; templates.mkdir()
    (templates / "o__r").write_text("vendor-js/\n")
    monkeypatch.setattr(config, "CONTEXTIGNORE_DIR", templates)

    dest = prepare_task_repo(Task("t-1", "o/r", c1, "", "", ""), mirror, tmp_path / "task")
    git(dest, "clean", "-fdq")

    assert (dest / ".contextignore").read_text() == "vendor-js/\n"
    assert git(dest, "status", "--porcelain") == ""
    assert ".contextignore" not in git(dest, "diff", c1)


def test_prepare_without_a_template_writes_no_contextignore(tmp_path, monkeypatch):
    from swe_lite_ab import config
    origin = tmp_path / "origin"; origin.mkdir()
    git(origin, "init", "-q", "-b", "main")
    (origin / "a.py").write_text("x = 1\n"); git(origin, "add", "."); git(origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c1")
    c1 = git(origin, "rev-parse", "HEAD")
    mirror = tmp_path / "mirror.git"
    git(tmp_path, "clone", "-q", "--mirror", str(origin), str(mirror))
    monkeypatch.setattr(config, "CONTEXTIGNORE_DIR", tmp_path / "none")

    dest = prepare_task_repo(Task("t-1", "o/r", c1, "", "", ""), mirror, tmp_path / "task")

    assert not (dest / ".contextignore").exists()
