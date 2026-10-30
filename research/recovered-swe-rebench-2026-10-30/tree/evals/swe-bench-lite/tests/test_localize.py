import json
import subprocess

from swe_lite_ab import config


def chunk(path):
    return {"id": path, "score": 0.5, "payload": {"relativePath": path}}


def git_repo(tmp_path, files):
    for name, text in files.items():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text(text)
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True)
    return tmp_path


def test_files_from_chunks_keeps_distinct_paths_in_first_seen_rank_order():
    from swe_lite_ab.localize import files_from_chunks

    chunks = [chunk("b.py"), chunk("a.py"), chunk("b.py"), chunk("c.py"), chunk("a.py")]
    assert files_from_chunks(chunks) == ["b.py", "a.py", "c.py"]


def test_tokenize_splits_snake_camel_dots_and_slashes_and_drops_short_tokens():
    from swe_lite_ab.localize import tokenize

    assert tokenize("lib/ansible/module_utils.py parseHTTPResponse a.b") == \
        ["lib", "ansible", "module", "utils", "py", "parse", "http", "response"]


def test_bm25_ranks_the_file_sharing_rare_query_terms_first(tmp_path):
    from swe_lite_ab.localize import bm25_rank

    repo = git_repo(tmp_path, {
        "pkg/common.py": "def helper():\n    return value\n" * 5,
        "pkg/vault.py": "def decrypt_vault(secret):\n    return secret\n",
        "pkg/other.py": "def helper_value():\n    return value\n",
        "README.md": "decrypt vault secret decrypt vault secret",
    })
    ranking = bm25_rank(repo, "Vault decryption fails: decrypt_vault loses the secret", (".py",))
    assert ranking[0] == "pkg/vault.py"
    assert "README.md" not in ranking


def test_bm25_counts_path_tokens(tmp_path):
    from swe_lite_ab.localize import bm25_rank

    repo = git_repo(tmp_path, {"plugins/inventory/yaml.py": "x = 1\n", "plugins/other.py": "y = 2\n"})
    assert bm25_rank(repo, "the inventory plugin", (".py",))[0] == "plugins/inventory/yaml.py"


def test_bm25_skips_untracked_files(tmp_path):
    from swe_lite_ab.localize import bm25_rank

    repo = git_repo(tmp_path, {"tracked.py": "token\n"})
    (repo / "untracked.py").write_text("token token\n")
    assert bm25_rank(repo, "token", (".py",)) == ["tracked.py"]


def test_score_reports_first_gold_rank_recall_hit_and_mrr():
    from swe_lite_ab.localize import score

    ranking = ["x.py", "a.py", "y.py", "z.py", "w.py", "v.py", "b.py"]
    m = score(ranking, ["a.py", "b.py"])
    assert m["rank_of_first_gold"] == 2
    assert m["recall@1"] == 0.0 and m["recall@5"] == 0.5 and m["recall@10"] == 1.0
    assert m["hit@1"] == 0 and m["hit@5"] == 1 and m["hit@10"] == 1
    assert m["mrr"] == 0.5


def test_score_of_a_ranking_missing_every_gold_has_no_rank_and_zero_mrr():
    from swe_lite_ab.localize import score

    m = score(["x.py"], ["a.py"])
    assert m["rank_of_first_gold"] is None and m["mrr"] == 0.0 and m["hit@10"] == 0


def test_score_of_an_empty_gold_set_is_none():
    from swe_lite_ab.localize import score

    assert score(["x.py"], []) is None


def test_scored_gold_is_python_files_primary_and_every_file_secondary():
    from swe_lite_ab.localize import scored_gold

    patch = "diff --git a/lib/a.py b/lib/a.py\n+x\ndiff --git a/docs/b.rst b/docs/b.rst\n+y\n"
    assert scored_gold(patch) == {"primary": ["lib/a.py"], "secondary": ["lib/a.py", "docs/b.rst"]}


def test_truncate_query_caps_long_issue_text_and_reports_it():
    from swe_lite_ab.localize import truncate_query

    assert truncate_query("short", 10) == ("short", False)
    assert truncate_query("x" * 20, 10) == ("x" * 10, True)


def test_tea_rags_config_set_is_pinned_in_order():
    from swe_lite_ab.localize import CONFIG_NAMES, TEA_RAGS_CONFIGS

    assert [c.name for c in TEA_RAGS_CONFIGS] == [
        "semantic-relevance", "hybrid-relevance", "hybrid-bugHunt", "hybrid-hotspots",
        "semantic-relevance-prod", "hybrid-relevance-prod", "hybrid-tiebreak-prod", "semantic-tiebreak-prod"]
    assert CONFIG_NAMES == tuple(c.name for c in TEA_RAGS_CONFIGS) + ("bm25", "bm25-prod")
    assert {c.name: c.production for c in TEA_RAGS_CONFIGS} == {
        "semantic-relevance": False, "hybrid-relevance": False, "hybrid-bugHunt": False,
        "hybrid-hotspots": False, "semantic-relevance-prod": True, "hybrid-relevance-prod": True,
        "hybrid-tiebreak-prod": True, "semantic-tiebreak-prod": True}
    assert len(set(TEA_RAGS_CONFIGS)) == len(TEA_RAGS_CONFIGS)  # frozen and hashable


def test_search_params_send_the_production_preset_filter_only_for_production_configs():
    from swe_lite_ab.localize import TEA_RAGS_CONFIGS, search_params

    for c in TEA_RAGS_CONFIGS:
        p = search_params(c, "alias", "q", limit=300, offset=0)
        assert p["filter"] == ({"presets": "production"} if c.production else {})
        assert p["language"] == "python"


def test_search_params_send_a_preset_name_or_custom_weights_as_rerank():
    from swe_lite_ab.localize import TEA_RAGS_CONFIGS, search_params

    by_name = {c.name: search_params(c, "alias", "q", limit=300, offset=0) for c in TEA_RAGS_CONFIGS}
    assert by_name["hybrid-bugHunt"]["rerank"] == "bugHunt"
    assert by_name["semantic-relevance-prod"]["rerank"] == "relevance"
    weights = {"custom": {"similarity": 0.85, "recency": 0.075, "churn": 0.075}}
    assert by_name["hybrid-tiebreak-prod"]["rerank"] == weights
    assert by_name["semantic-tiebreak-prod"]["rerank"] == weights


def test_is_test_or_doc_path_follows_the_pro_verifier_rule():
    from swe_lite_ab.localize import is_test_or_doc_path

    for path in ["tests/a.py", "pkg/test/a.py", "pkg/__tests__/a.py", "spec/a.py", "x/specs/a.py",
                 "docs/a.py", "pkg/doc/a.py", "pkg/conftest.py", "pkg/test_a.py", "pkg/a_test.py", "conftest.py"]:
        assert is_test_or_doc_path(path), path
    for path in ["pkg/a.py", "pkg/testing.py", "pkg/contest.py", "latest/a.py", "pkg/test_a.txt", "a.py"]:
        assert not is_test_or_doc_path(path), path


def test_bm25_prod_excludes_test_and_doc_files(monkeypatch, tmp_path):
    from swe_lite_ab import localize

    monkeypatch.setattr(config, "RUNS", tmp_path)
    repo = git_repo(tmp_path / "repo", {"lib/vault.py": "decrypt vault\n",
                                        "tests/test_vault.py": "decrypt vault decrypt vault decrypt vault\n",
                                        "docs/vault.py": "decrypt vault decrypt vault\n"})
    run, _ = fake_call([["lib/vault.py"]])
    rec = localize.localize_task("t1", "decrypt vault", "diff --git a/lib/vault.py b/lib/vault.py\n", "a", repo, run=run)
    assert rec["configs"]["bm25"]["files"] == 3
    assert rec["configs"]["bm25-prod"]["files"] == 1
    saved = json.loads((tmp_path / "localize" / "t1" / "bm25-prod.json").read_text())
    assert saved["files"] == ["lib/vault.py"]


def fake_call(pages):
    """A `tea-rags call --json` stand-in that serves `pages` (lists of paths) by offset."""
    calls = []

    def run(cmd, **kwargs):
        params = json.loads(cmd[3])
        calls.append(params)
        page = pages[params["offset"] // params["limit"]] if params["offset"] // params["limit"] < len(pages) else []
        out = json.dumps({"structuredContent": {"results": [chunk(p) for p in page]}})
        return subprocess.CompletedProcess(cmd, 0, out, "")

    return run, calls


def test_search_files_pages_until_enough_distinct_files(monkeypatch):
    from swe_lite_ab.localize import TEA_RAGS_CONFIGS, search_files

    run, calls = fake_call([["a.py", "a.py"], ["b.py", "c.py"], ["d.py"]])
    files = search_files(TEA_RAGS_CONFIGS[0], "alias", "q", want=3, page=2, max_pages=5, run=run)
    assert files == ["a.py", "b.py", "c.py"]
    assert [c["offset"] for c in calls] == [0, 2]


def test_search_files_stops_when_the_tool_runs_out_of_results():
    from swe_lite_ab.localize import TEA_RAGS_CONFIGS, search_files

    run, calls = fake_call([["a.py", "b.py"], ["c.py"]])
    assert search_files(TEA_RAGS_CONFIGS[0], "alias", "q", want=50, page=2, max_pages=5, run=run) == \
        ["a.py", "b.py", "c.py"]
    assert len(calls) == 2


def test_search_files_raises_with_the_tool_error_text():
    import pytest

    from swe_lite_ab.localize import TEA_RAGS_CONFIGS, search_files

    def run(cmd, **kwargs):
        return subprocess.CompletedProcess(cmd, 1, "", "Error: project not found")

    with pytest.raises(RuntimeError, match="project not found"):
        search_files(TEA_RAGS_CONFIGS[0], "alias", "q", run=run)


def test_localize_task_persists_top_rankings_and_scores_each_config(monkeypatch, tmp_path):
    from swe_lite_ab import localize

    monkeypatch.setattr(config, "RUNS", tmp_path)
    repo = git_repo(tmp_path / "repo", {"lib/vault.py": "decrypt vault\n", "lib/other.py": "nothing\n"})
    run, _ = fake_call([["lib/other.py", "lib/vault.py"]])
    patch = "diff --git a/lib/vault.py b/lib/vault.py\n+x\n"
    rec = localize.localize_task("t1", "decrypt the vault", patch, "alias", repo, run=run)
    assert rec["configs"]["hybrid-relevance"]["primary"]["rank_of_first_gold"] == 2
    assert rec["configs"]["bm25"]["primary"]["rank_of_first_gold"] == 1
    saved = json.loads((tmp_path / "localize" / "t1" / "bm25.json").read_text())
    assert saved["files"][0] == "lib/vault.py"
    assert rec["query_truncated"] is False and rec["gold"]["primary"] == ["lib/vault.py"]


def test_localize_task_records_a_failing_config_and_keeps_the_others(monkeypatch, tmp_path):
    from swe_lite_ab import localize

    monkeypatch.setattr(config, "RUNS", tmp_path)
    repo = git_repo(tmp_path / "repo", {"lib/vault.py": "decrypt vault\n"})

    def run(cmd, **kwargs):
        return subprocess.CompletedProcess(cmd, 1, "", "boom")

    rec = localize.localize_task("t1", "decrypt the vault", "diff --git a/lib/vault.py b/lib/vault.py\n", "a", repo, run=run)
    assert "boom" in rec["configs"]["semantic-relevance"]["error"]
    assert rec["configs"]["semantic-relevance"]["primary"] is None
    assert rec["configs"]["bm25"]["primary"]["rank_of_first_gold"] == 1


def record(iid, ranks, truncated=False, gold_py=("a.py",), error=None):
    configs = {}
    for name, rank in ranks.items():
        m = None if rank == "-" else {"rank_of_first_gold": rank, "recall@1": float(rank == 1),
                                      "recall@5": float(rank is not None and rank <= 5),
                                      "recall@10": float(rank is not None and rank <= 10),
                                      "hit@1": int(rank == 1), "hit@5": int(rank is not None and rank <= 5),
                                      "hit@10": int(rank is not None and rank <= 10),
                                      "mrr": 1 / rank if rank else 0.0}
        configs[name] = {"error": error if rank == "-" else None, "files": 50,
                         "primary": m if gold_py else None, "secondary": m}
    return {"instance_id": iid, "query_truncated": truncated, "query_chars": 10,
            "gold": {"primary": list(gold_py), "secondary": ["a.py"]}, "configs": configs}


def test_render_report_has_mean_metrics_per_config_and_per_task_ranks():
    from swe_lite_ab.localize import render

    records = [record("t1", {"bm25": 1, "hybrid-relevance": 4}), record("t2", {"bm25": None, "hybrid-relevance": 2})]
    md = render(records, "loc-2")
    assert "| bm25 | 2 | 0.50 | 0.50 | 0.50 | 0.50 | 0.50 |" in md
    assert "| hybrid-relevance | 2 | 0.00 | 1.00 | 1.00 | 1.00 | 0.38 |" in md
    assert "| t1 | 1 | 1 | 4 |" in md
    assert "| t2 | 1 | – | 2 |" in md


def test_render_report_notes_truncated_queries_unscored_tasks_and_errors():
    from swe_lite_ab.localize import render

    records = [record("t1", {"bm25": 1, "hybrid-relevance": "-"}, truncated=True, error="alias not found"),
               record("t2", {"bm25": 1, "hybrid-relevance": 1}, gold_py=())]
    md = render(records, "loc-2")
    assert "Queries truncated: t1" in md
    assert "Unscored (no gold .py file): t2" in md
    assert "t1 hybrid-relevance: alias not found" in md


def test_task_list_path_falls_back_to_a_temporary_list_under_runs(monkeypatch, tmp_path):
    from swe_lite_ab.localize import task_list_path

    monkeypatch.setattr(config, "TASKS_DIR", tmp_path / "tasks")
    monkeypatch.setattr(config, "RUNS", tmp_path / "runs")
    (tmp_path / "tasks").mkdir()
    (tmp_path / "runs").mkdir()
    (tmp_path / "runs" / "loc-ready.json").write_text("{}")
    assert task_list_path("loc-ready") == tmp_path / "runs" / "loc-ready.json"
    (tmp_path / "tasks" / "loc-ready.json").write_text("{}")
    assert task_list_path("loc-ready") == tmp_path / "tasks" / "loc-ready.json"
