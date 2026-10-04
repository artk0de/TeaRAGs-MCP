import json
from pathlib import Path

from swe_lite_ab.transcript import parse

LINES = (Path(__file__).parent / "fixtures" / "stream-sample.jsonl").read_text().splitlines()


def test_sum_mode_counts_subagent_usage_once_per_message():
    m = parse(LINES, ["requests/sessions.py"], "sum")
    assert (m.input_tokens, m.cache_write_tokens, m.cache_read_tokens, m.output_tokens) == (175, 10, 240, 55)


def test_result_mode_reads_the_final_event():
    m = parse(LINES, ["requests/sessions.py"], "result")
    assert m.input_tokens == 125 and m.output_tokens == 52 and m.cost_usd == 0.12


def _tool_use(msg_id, tool_id, name, tool_input):
    return json.dumps({"type": "assistant", "parent_tool_use_id": None, "message": {
        "id": msg_id, "usage": {}, "content": [{"type": "tool_use", "id": tool_id, "name": name, "input": tool_input}]}})


def _tool_result(tool_id):
    return json.dumps({"type": "user", "parent_tool_use_id": None, "message": {
        "content": [{"type": "tool_result", "tool_use_id": tool_id, "content": "ok"}]}})


TIMED = [
    _tool_use("a1", "i1", "mcp__tea-rags__index_codebase", {"project": "x"}),
    _tool_result("i1"),
    _tool_use("a2", "b1", "Bash", {"command": "grep -rn foo ."}),
    _tool_result("b1"),
]


def test_tool_seconds_and_in_run_index_time_from_arrivals():
    m = parse(TIMED, [], "sum", arrivals=[10.0, 25.5, 30.0, 31.0])
    assert m.tool_seconds == {"mcp__tea-rags__index_codebase": 15.5, "Bash": 1.0}
    assert m.index_in_run_seconds == 15.5


def test_bash_tea_rags_index_codebase_counts_as_in_run_index():
    lines = [_tool_use("a1", "b1", "Bash", {"command": "tea-rags index-codebase --project x"}), _tool_result("b1")]
    m = parse(lines, [], "sum", arrivals=[2.0, 9.25])
    assert m.tool_seconds == {"Bash": 7.25} and m.index_in_run_seconds == 7.25


def test_without_arrivals_tool_timing_stays_empty():
    m = parse(TIMED, [], "sum")
    assert m.tool_seconds == {} and m.index_in_run_seconds == 0


GOLD = ["django/db/models/query.py"]


def test_gold_read_as_first_tool_is_before_search():
    lines = [_tool_use("a1", "r1", "Read", {"file_path": "/r/django/db/models/query.py"})]
    assert parse(lines, GOLD, "sum").gold_before_search


def test_gold_read_after_a_bash_search_is_not_before_search():
    lines = [_tool_use("a1", "b1", "Bash", {"command": "rg QuerySet django/"}), _tool_result("b1"),
             _tool_use("a2", "r1", "Read", {"file_path": "/r/django/db/models/query.py"})]
    assert not parse(lines, GOLD, "sum").gold_before_search


def test_gold_read_after_a_non_search_bash_is_before_search():
    lines = [_tool_use("a1", "b1", "Bash", {"command": "cat setup.py"}), _tool_result("b1"),
             _tool_use("a2", "r1", "Read", {"file_path": "/r/django/db/models/query.py"})]
    assert parse(lines, GOLD, "sum").gold_before_search


def test_gold_never_touched_is_not_before_search():
    lines = [_tool_use("a1", "r1", "Read", {"file_path": "/r/setup.py"})]
    assert not parse(lines, GOLD, "sum").gold_before_search


def test_gold_first_seen_in_a_search_result_is_not_before_search():
    assert not parse(LINES, ["requests/sessions.py"], "sum").gold_before_search


def test_durations_come_from_the_result_event():
    m = parse(LINES, ["requests/sessions.py"], "sum")
    assert m.duration_ms == 42000 and m.duration_api_ms == 30000


def test_tool_accounting_and_tea_rags_share():
    m = parse(LINES, ["requests/sessions.py"], "sum")
    assert m.tool_calls == {"Bash": 1, "mcp__tea-rags__hybrid_search": 1, "Edit": 1}
    assert m.tea_rags_calls == 1 and m.search_read_calls == 2


def test_gold_touch_counts_tea_rags_results_and_turn_index():
    m = parse(LINES, ["requests/sessions.py"], "sum")
    assert m.gold_touched and m.turns_to_gold == 2
    assert not parse(LINES, ["requests/models.py"], "sum").gold_touched
