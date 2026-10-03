from pathlib import Path

from swe_lite_ab.transcript import parse

LINES = (Path(__file__).parent / "fixtures" / "stream-sample.jsonl").read_text().splitlines()


def test_sum_mode_counts_subagent_usage_once_per_message():
    m = parse(LINES, ["requests/sessions.py"], "sum")
    assert (m.input_tokens, m.cache_write_tokens, m.cache_read_tokens, m.output_tokens) == (175, 10, 240, 55)


def test_result_mode_reads_the_final_event():
    m = parse(LINES, ["requests/sessions.py"], "result")
    assert m.input_tokens == 125 and m.output_tokens == 52 and m.cost_usd == 0.12


def test_tool_accounting_and_tea_rags_share():
    m = parse(LINES, ["requests/sessions.py"], "sum")
    assert m.tool_calls == {"Bash": 1, "mcp__tea-rags__hybrid_search": 1, "Edit": 1}
    assert m.tea_rags_calls == 1 and m.search_read_calls == 2


def test_gold_touch_counts_tea_rags_results_and_turn_index():
    m = parse(LINES, ["requests/sessions.py"], "sum")
    assert m.gold_touched and m.turns_to_gold == 2
    assert not parse(LINES, ["requests/models.py"], "sum").gold_touched
