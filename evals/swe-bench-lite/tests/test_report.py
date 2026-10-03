import json
from pathlib import Path

from swe_lite_ab.report import Row, index_time_line, render


def row(arm, i, resolved, tokens, mentioned):
    return Row(arm=arm, instance_id=f"t{i}", repo="psf/requests", mentioned=mentioned, resolved=resolved,
               input_tokens=tokens, cache_write_tokens=0, cache_read_tokens=tokens * 10, output_tokens=tokens // 10,
               cost_usd=tokens / 1e5, turns=10, tool_calls_total=20 if arm == "arm0" else 12,
               tea_rags_calls=3 if arm == "arm1" else 0, search_read_calls=6, gold_touched=True, turns_to_gold=2,
               wall_seconds=60.0 if arm == "arm0" else 40.0, api_seconds=30.0 if arm == "arm0" else 20.0)


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
