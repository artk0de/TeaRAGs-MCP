import json
from pathlib import Path

from swe_lite_ab.report import Row, index_time_line, render


def row(arm, i, resolved, tokens, mentioned, repo="psf/requests", gold_before_search=False):
    return Row(arm=arm, instance_id=f"t{i}", repo=repo, mentioned=mentioned, resolved=resolved,
               input_tokens=tokens, cache_write_tokens=0, cache_read_tokens=tokens * 10, output_tokens=tokens // 10,
               cost_usd=tokens / 1e5, turns=10, tool_calls_total=20 if arm == "arm0" else 12,
               tea_rags_calls=3 if arm == "arm1" else 0, search_read_calls=6, gold_touched=True, turns_to_gold=2,
               wall_seconds=60.0 if arm == "arm0" else 40.0, wall_seconds_raw=60.0 if arm == "arm0" else 45.0,
               index_in_run_seconds=0.0 if arm == "arm0" else 5.0, api_seconds=30.0 if arm == "arm0" else 20.0,
               gold_before_search=gold_before_search)


def test_render_has_headline_strata_and_tea_rags_share():
    rows = [row("arm0", i, i < 2, 1000, i % 2 == 0) for i in range(4)] + \
           [row("arm1", i, i < 3, 800, i % 2 == 0) for i in range(4)]
    md = render(rows)
    assert "| Resolved | 2/4 (50.0%) | 3/4 (75.0%) |" in md
    assert "Gold file named in issue" in md and "Gold file not named" in md
    assert "TeaRAGs share of search/read calls: 50.0%" in md


def test_render_reports_tool_calls_as_a_paired_metric():
    rows = [row("arm0", i, False, 1000, True) for i in range(4)] + \
           [row("arm1", i, False, 800, True) for i in range(4)]
    assert "| median tool_calls_total | 20 | 12 |" in render(rows)


def test_write_csv_has_every_row_field(tmp_path):
    import csv
    from dataclasses import fields

    from swe_lite_ab.report import write_csv

    out = write_csv([row("arm0", 1, True, 1000, False)], tmp_path / "r.csv")
    records = list(csv.DictReader(out.open()))
    assert list(records[0]) == [f.name for f in fields(Row)]
    assert records[0]["instance_id"] == "t1" and records[0]["tool_calls_total"] == "20"


def test_render_reports_wall_and_api_time_as_paired_metrics():
    rows = [row("arm0", i, False, 1000, True) for i in range(4)] + \
           [row("arm1", i, False, 800, True) for i in range(4)]
    md = render(rows)
    assert "| median wall_seconds | 60 | 40 |" in md
    assert "| median api_seconds | 30 | 20 |" in md


def test_index_time_line_is_descriptive_and_separate_from_agent_time():
    records = [{"seconds": 10.0}, {"seconds": 30.0}, {"seconds": 20.0}]
    assert index_time_line(records) == \
        "Arm 1 index time per task: median 20.0 s, total 60.0 s (not included in agent wall time)"
    assert index_time_line([]) is None


def test_index_quality_section_lists_each_index_and_flags_empty_git_signals():
    from swe_lite_ab.report import index_quality_section

    good = {"instance_id": "a", "language": "python", "outcome": {"measured": True, "failed": [], "degraded": []},
            "codegraphResolve": {"primaryLanguage": "python", "resolve": 0.6, "kinds": {}},
            "signalCounts": {"git.file.commitCount": 10, "git.chunk.commitCount": 50, "codegraph.chunk.fanIn": 7}}
    empty_git = {**good, "instance_id": "b",
                 "signalCounts": {**good["signalCounts"], "git.chunk.commitCount": 0}}
    failed = {**good, "instance_id": "c", "outcome": {"measured": True, "failed": ["git"], "degraded": []}}

    md = "\n".join(index_quality_section([good, empty_git, failed]))

    assert "| a | python | 0.6 | 10 | 50 | 7 | ok |" in md
    assert "| b | python | 0.6 | 10 | 0 | 7 | ok |" in md
    assert "| c | python | 0.6 | 10 | 50 | 7 | failed: git |" in md
    assert "WARNING: 2 of 3 arm-1 indexes are defective" in md
    assert index_quality_section([{"instance_id": "x", "seconds": 1.0}]) == []

    unmeasured = {**good, "instance_id": "d", "codegraphResolve": None}
    assert "| d | python | n/a | 10 | 50 | 7 | ok |" in "\n".join(index_quality_section([unmeasured]))


def test_render_includes_index_time_only_when_records_given():
    rows = [row("arm0", 0, False, 1000, True), row("arm1", 0, False, 800, True)]
    assert "Arm 1 index time" not in render(rows)
    assert "Arm 1 index time per task: median 5.0 s" in render(rows, [{"seconds": 5.0}])


def test_build_rows_reads_wall_time_from_status_and_api_time_from_transcript(tmp_path, monkeypatch):
    from swe_lite_ab import config
    from swe_lite_ab.report import build_rows
    from swe_lite_ab.tasks import Task

    monkeypatch.setattr(config, "RUNS", tmp_path)
    fixture = (Path(__file__).parent / "fixtures" / "stream-sample.jsonl").read_text()
    task = Task("psf__requests-1", "psf/requests", "abc", "", "", "2020")
    for arm in ("arm0", "arm1"):
        (tmp_path / arm / task.instance_id).mkdir(parents=True)
        (tmp_path / arm / task.instance_id / "transcript.jsonl").write_text(fixture)
    (tmp_path / "arm0" / task.instance_id / "status.json").write_text(json.dumps({"wall_seconds": 61.5}))
    rows = {r.arm: r for r in build_rows([task], {"arm0": set(), "arm1": set()}, "sum")}
    assert rows["arm0"].wall_seconds == 61.5 and rows["arm0"].api_seconds == 30.0
    assert rows["arm1"].wall_seconds == 0


def test_render_reports_raw_wall_and_in_run_index_time():
    rows = [row("arm0", i, False, 1000, True) for i in range(4)] + \
           [row("arm1", i, False, 800, True) for i in range(4)]
    md = render(rows)
    assert "| median wall_seconds_raw | 60 | 45 |" in md
    assert "| median index_in_run_seconds | 0 | 5 |" in md


def test_build_rows_subtracts_in_run_index_time_from_wall_clock(tmp_path, monkeypatch):
    from swe_lite_ab import config
    from swe_lite_ab.report import build_rows
    from swe_lite_ab.tasks import Task

    monkeypatch.setattr(config, "RUNS", tmp_path)
    task = Task("psf__requests-1", "psf/requests", "abc", "", "", "2020")
    lines = [
        json.dumps({"type": "assistant", "parent_tool_use_id": None, "message": {"id": "a1", "usage": {}, "content": [
            {"type": "tool_use", "id": "i1", "name": "mcp__tea-rags__index_codebase", "input": {}}]}}),
        json.dumps({"type": "user", "parent_tool_use_id": None, "message": {"content": [
            {"type": "tool_result", "tool_use_id": "i1", "content": "ok"}]}}),
    ]
    for arm, wall in (("arm0", 3.0), ("arm1", 50.0)):
        d = tmp_path / arm / task.instance_id
        d.mkdir(parents=True)
        (d / "transcript.jsonl").write_text("\n".join(lines) + "\n")
        (d / "status.json").write_text(json.dumps({"wall_seconds": wall}))
    (tmp_path / "arm0" / task.instance_id / "arrivals.txt").write_text("1.000\n9.000\n")
    (tmp_path / "arm1" / task.instance_id / "arrivals.txt").write_text("10.000\n25.500\n")
    rows = {r.arm: r for r in build_rows([task], {"arm0": set(), "arm1": set()}, "sum")}
    assert (rows["arm1"].wall_seconds_raw, rows["arm1"].index_in_run_seconds, rows["arm1"].wall_seconds) == (50.0, 15.5, 34.5)
    assert rows["arm0"].wall_seconds == 0  # floored: 3.0 raw - 8.0 index


def test_render_breaks_results_down_by_repository_and_stratum():
    rows = [row("arm0", i, i == 0, 1000, False, repo="django/django") for i in range(3)] + \
           [row("arm1", i, i < 2, 800, False, repo="django/django") for i in range(3)] + \
           [row("arm0", 3, True, 1000, True), row("arm1", 3, True, 800, True)]
    md = render(rows)
    assert "## By repository × stratum" in md
    # repo | gold file | n | resolved arm0 | resolved arm1 | median total input arm0 | arm1 | median wall arm0 | arm1
    assert "| django/django | not named | 3 | 1 | 2 | 11000 | 8800 | 60 | 40 |" in md
    assert "| psf/requests | named | 1 | 1 | 1 |" in md
    assert "| django/django | named |" not in md


def test_render_reports_gold_opened_before_search_per_arm():
    rows = [row("arm0", i, False, 1000, True, gold_before_search=i == 0) for i in range(4)] + \
           [row("arm1", i, False, 800, True, gold_before_search=i < 3) for i in range(4)]
    md = render(rows)
    assert "Gold file opened before any search (arm0): 1/4 (25.0%)" in md
    assert "Gold file opened before any search (arm1): 3/4 (75.0%)" in md


def test_exploratory_section_keeps_pairs_arm0_did_not_open_before_search():
    rows = [row("arm0", i, False, 1000, True, gold_before_search=i == 0) for i in range(4)] + \
           [row("arm1", i, False, 800, True, gold_before_search=True) for i in range(4)]
    assert "## Exploratory: not searched-for in arm 0 (n=3)" in render(rows)
