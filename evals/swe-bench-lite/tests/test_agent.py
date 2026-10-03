import os
import sys
from pathlib import Path

from swe_lite_ab.agent import build_command, render_prompt
from swe_lite_ab.config import ARMS
from swe_lite_ab.tasks import Task

TASK = Task("psf__requests-1", "psf/requests", "abc", "Session drops cookies", "", "2020")


def test_prompt_is_identical_across_arms_and_never_names_tea_rags():
    p = render_prompt(TASK, Path("/r"))
    assert "Session drops cookies" in p and "/r" in p
    assert "tea-rags" not in p.lower() and "tearags" not in p.lower()


def test_arm0_has_no_mcp_and_no_plugin(tmp_path):
    argv, env = build_command(ARMS["arm0"], TASK, Path("/r"), tmp_path)
    assert "--strict-mcp-config" in argv
    assert "--plugin-dir" not in argv
    assert '"mcpServers": {}' in (tmp_path / "mcp.json").read_text()
    assert env["CLAUDE_CONFIG_DIR"] == str(tmp_path / "config")


def test_arm1_adds_tea_rags_mcp_and_plugin_only(tmp_path):
    a0, _ = build_command(ARMS["arm0"], TASK, Path("/r"), tmp_path / "a0")
    a1, env = build_command(ARMS["arm1"], TASK, Path("/r"), tmp_path / "a1")
    extra = [x for x in a1 if x not in a0]
    assert "--plugin-dir" in a1
    assert '"tea-rags"' in (tmp_path / "a1" / "mcp.json").read_text()
    assert set(extra) <= {"--plugin-dir", str(Path(a1[a1.index("--plugin-dir") + 1])),
                          str(tmp_path / "a1" / "mcp.json")}


def test_run_task_records_wall_clock_seconds(tmp_path, monkeypatch):
    import json

    from swe_lite_ab import agent, config

    monkeypatch.setattr(config, "RUNS", tmp_path / "runs")
    monkeypatch.setattr(agent, "task_dir", lambda _id: tmp_path)
    monkeypatch.setattr(agent, "reset_repo", lambda _dir: None)

    def fake_build(arm, task, repo_dir, run_dir):
        run_dir.mkdir(parents=True, exist_ok=True)
        return [sys.executable, "-c", "import time; time.sleep(0.2)"], dict(os.environ)

    monkeypatch.setattr(agent, "build_command", fake_build)
    run_dir = agent.run_task(ARMS["arm0"], TASK)
    status = json.loads((run_dir / "status.json").read_text())
    assert status["returncode"] == 0
    assert 0.2 <= status["wall_seconds"] < 30


def _fake_run(tmp_path, monkeypatch, script):
    from swe_lite_ab import agent, config

    monkeypatch.setattr(config, "RUNS", tmp_path / "runs")
    monkeypatch.setattr(agent, "task_dir", lambda _id: tmp_path)
    monkeypatch.setattr(agent, "reset_repo", lambda _dir: None)

    def fake_build(arm, task, repo_dir, run_dir):
        run_dir.mkdir(parents=True, exist_ok=True)
        return [sys.executable, "-u", "-c", script], dict(os.environ)

    monkeypatch.setattr(agent, "build_command", fake_build)
    return agent.run_task(ARMS["arm0"], TASK)


def test_run_task_writes_raw_lines_and_their_arrival_offsets(tmp_path, monkeypatch):
    import json

    script = "import time\nprint('{\"a\": 1}')\ntime.sleep(0.3)\nprint('{\"b\": 2}')\n"
    run_dir = _fake_run(tmp_path, monkeypatch, script)
    assert (run_dir / "transcript.jsonl").read_text() == '{"a": 1}\n{"b": 2}\n'
    arrivals = [float(x) for x in (run_dir / "arrivals.txt").read_text().splitlines()]
    assert len(arrivals) == 2
    assert arrivals[1] - arrivals[0] >= 0.25
    status = json.loads((run_dir / "status.json").read_text())
    assert status["timeout"] is False and status["wall_seconds"] >= arrivals[1]


def test_run_task_kills_the_agent_at_the_timeout(tmp_path, monkeypatch):
    import json

    from swe_lite_ab import config

    monkeypatch.setattr(config, "AGENT_TIMEOUT_S", 0.5)
    run_dir = _fake_run(tmp_path, monkeypatch, "import time\nprint('{}')\ntime.sleep(10)\n")
    status = json.loads((run_dir / "status.json").read_text())
    assert status["timeout"] is True and status["wall_seconds"] < 5
    assert (run_dir / "transcript.jsonl").read_text() == "{}\n"


def test_both_arms_share_model_and_limits(tmp_path):
    a0, _ = build_command(ARMS["arm0"], TASK, Path("/r"), tmp_path / "a0")
    a1, _ = build_command(ARMS["arm1"], TASK, Path("/r"), tmp_path / "a1")
    for flag in ("--model", "--max-budget-usd", "--output-format"):
        assert a0[a0.index(flag) + 1] == a1[a1.index(flag) + 1]
