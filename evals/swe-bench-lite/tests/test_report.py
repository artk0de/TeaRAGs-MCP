from swe_lite_ab.report import Row, render


def row(arm, i, resolved, tokens, mentioned):
    return Row(arm=arm, instance_id=f"t{i}", repo="psf/requests", mentioned=mentioned, resolved=resolved,
               input_tokens=tokens, cache_write_tokens=0, cache_read_tokens=tokens * 10, output_tokens=tokens // 10,
               cost_usd=tokens / 1e5, turns=10, tool_calls_total=20 if arm == "arm0" else 12,
               tea_rags_calls=3 if arm == "arm1" else 0, search_read_calls=6, gold_touched=True, turns_to_gold=2)


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
