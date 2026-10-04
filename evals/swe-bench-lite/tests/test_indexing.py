import hashlib
from pathlib import Path

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


FIXTURES = Path(__file__).parent / "fixtures"


def test_parse_prime_reads_primary_language_resolve_and_per_kind_rates():
    from swe_lite_ab.indexing import parse_prime

    q = parse_prime((FIXTURES / "prime-django.txt").read_text())

    assert q["primaryLanguage"] == "python"
    assert q["resolve"] == 0.6
    assert q["kinds"]["bareCall"] == {"rate": 0.97, "resolved": 3922, "total": 12156}
    assert q["kinds"]["chain"] == {"rate": 0.08, "resolved": 114, "total": 3127}
    assert q["enrichment"] == {"git": "file healthy, chunk healthy",
                               "codegraph.symbols": "file healthy, chunk healthy"}


def test_signal_counts_sums_source_and_test_and_reports_absent_signals_as_zero():
    from swe_lite_ab.indexing import signal_counts

    metrics = {"signals": {"python": {
        "git.file.commitCount": {"source": {"count": 616}, "test": {"count": 1276}},
        "codegraph.chunk.fanIn": {"source": {"count": 2093}},
    }}}

    assert signal_counts(metrics, "python") == {
        "git.file.commitCount": 1892, "git.chunk.commitCount": 0, "codegraph.chunk.fanIn": 2093}


def test_index_outcome_reads_the_enrichment_outcome_of_the_final_json_object():
    from swe_lite_ab.indexing import index_outcome

    out = 'noise\n{"overallMs": 5, "outcome": {"measured": true, "failed": [], "degraded": ["git"]}}\n'
    assert index_outcome(out) == {"measured": True, "failed": [], "degraded": ["git"]}
    assert index_outcome("not json") is None


def test_index_quality_combines_prime_and_index_metrics():
    import json
    import subprocess

    from swe_lite_ab.indexing import index_quality

    prime = (FIXTURES / "prime-django.txt").read_text()
    metrics = json.dumps({"signals": {"python": {"git.file.commitCount": {"source": {"count": 3}}}}})
    calls = []

    def run(cmd, **kw):
        calls.append(cmd)
        out = prime if cmd[1] == "prime" else metrics
        return subprocess.CompletedProcess(cmd, 0, stdout=out, stderr="")

    q = index_quality("/repo", "swe-x", {}, run=run)

    assert calls[0] == ["tea-rags", "prime", "/repo"]
    assert calls[1][:3] == ["tea-rags", "call", "get_index_metrics"]
    assert json.loads(calls[1][3]) == {"project": "swe-x"}
    assert q["codegraphResolve"]["resolve"] == 0.6
    assert q["signalCounts"]["git.file.commitCount"] == 3
    assert q["signalCounts"]["git.chunk.commitCount"] == 0


def test_index_quality_survives_a_cold_prime_and_takes_the_language_from_the_metrics():
    # prime answers "Qdrant warm-up pending" under load even while the daemon serves `call`;
    # an unmeasured resolve must read as unknown, never as an empty graph.
    import json
    import subprocess

    from swe_lite_ab.indexing import index_quality

    cold = "# tea-rags prime — /repo\nQdrant warm-up pending — index queries will be available after MCP server attaches.\n"
    metrics = json.dumps({"distributions": {"language": {"python": 900, "javascript": 10}},
                          "signals": {"python": {"git.chunk.commitCount": {"source": {"count": 5}}}}})
    calls = []

    def run(cmd, **kw):
        calls.append(cmd[1])
        return subprocess.CompletedProcess(cmd, 0, stdout=cold if cmd[1] == "prime" else metrics, stderr="")

    q = index_quality("/repo", "swe-x", {}, run=run, retry_delay=0)

    assert calls.count("prime") == 3
    assert q["codegraphResolve"] is None
    assert q["language"] == "python"
    assert q["signalCounts"]["git.chunk.commitCount"] == 5
