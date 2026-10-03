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
