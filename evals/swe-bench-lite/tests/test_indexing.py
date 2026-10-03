import hashlib

from swe_lite_ab.indexing import alias_for, chain_order, index_commands, index_stats
from swe_lite_ab.repos import task_dir
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
    path = str(task_dir("b"))
    clone = "w" + hashlib.sha1(b"b").hexdigest()[:8]
    assert cmds == [
        ["tea-rags", "worktree", "create", clone, "--from", "swe-a", "--path", path, "--no-git", "--json"],
        ["tea-rags", "projects", "unregister", "--name", f"swe-a-worktree-{clone}"],
        ["tea-rags", "projects", "register", "--path", path, "--name", "swe-b"],
        ["tea-rags", "index-codebase", "--project", "swe-b", "--wait-enrichments", "--json"],
    ]


def test_index_stats_reads_the_final_json_object():
    out = 'noise\n{"overallMs": 1234, "filesCount": 10, "chunksCount": 99, "outcome": {"measured": true}}\n'
    assert index_stats(out) == {"overallMs": 1234, "filesCount": 10, "chunksCount": 99}
    assert index_stats("not json") == {}


def test_full_mode_never_seeds():
    assert index_commands(t("b", "x/r", "2021"), "swe-a", "full")[0][1] == "index-codebase"
