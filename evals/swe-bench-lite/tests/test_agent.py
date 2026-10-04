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


def test_arm_order_is_deterministic_and_roughly_balanced():
    from swe_lite_ab.agent import arm_order

    ids = [f"repo__x-{i}" for i in range(50)]
    orders = [arm_order(i, 20261003) for i in ids]
    assert orders == [arm_order(i, 20261003) for i in ids]
    assert set(map(tuple, orders)) == {("arm0", "arm1"), ("arm1", "arm0")}
    assert 15 <= sum(o[0] == "arm0" for o in orders) <= 35


def test_run_pair_captures_each_arms_patch_before_the_next_arm_runs(tmp_path, monkeypatch):
    from swe_lite_ab import agent, collect, config

    monkeypatch.setattr(config, "RUNS", tmp_path / "runs")
    monkeypatch.setattr(agent, "task_dir", lambda _id: tmp_path / "repo")
    events = []
    current = {}

    def fake_run_task(arm, task):
        events.append(("run", arm.name))
        current["arm"] = arm.name
        return config.RUNS / arm.name / task.instance_id

    def fake_diff(repo_dir, base_commit):
        events.append(("diff", current["arm"]))
        return f"patch from {current['arm']} at {base_commit}\n"

    monkeypatch.setattr(agent, "run_task", fake_run_task)
    monkeypatch.setattr(collect, "diff_for", fake_diff)

    order = agent.arm_order(TASK.instance_id, 7)
    run_dirs = agent.run_pair(TASK, 7)

    assert events == [("run", order[0]), ("diff", order[0]), ("run", order[1]), ("diff", order[1])]
    assert run_dirs == [config.RUNS / arm / TASK.instance_id for arm in order]
    for arm in order:
        patch = config.RUNS / arm / "patches" / f"{TASK.instance_id}.diff"
        assert patch.read_text() == f"patch from {arm} at abc\n"


def test_both_arms_share_model_and_limits(tmp_path):
    a0, _ = build_command(ARMS["arm0"], TASK, Path("/r"), tmp_path / "a0")
    a1, _ = build_command(ARMS["arm1"], TASK, Path("/r"), tmp_path / "a1")
    for flag in ("--model", "--max-budget-usd", "--output-format"):
        assert a0[a0.index(flag) + 1] == a1[a1.index(flag) + 1]


def test_run_task_refuses_a_repo_that_inherits_claude_instructions(tmp_path, monkeypatch):
    import pytest

    from swe_lite_ab import agent, config

    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "CLAUDE.md").write_text("always use tea-rags")
    repo = tmp_path / "repo"; repo.mkdir()
    monkeypatch.setattr(config, "RUNS", tmp_path / "runs")
    monkeypatch.setattr(agent, "task_dir", lambda _id: repo)
    monkeypatch.setattr(agent, "reset_repo", lambda _dir: None)
    monkeypatch.setattr(agent, "build_command", lambda *a: pytest.fail("agent must not start"))

    with pytest.raises(RuntimeError, match="CLAUDE.md"):
        agent.run_task(config.ARMS["arm0"], Task("t-1", "o/r", "c", "", "", ""))


def test_arm1_tea_rags_anchors_git_windows_on_the_snapshot_head():
    # Task repositories are historical snapshots: windows and ages anchored on today would be empty
    # or years off. The server derives ages at query time, so the MCP env needs it, not only the index.
    from swe_lite_ab import config
    from swe_lite_ab.agent import mcp_config

    assert config.EMBEDDING_ENV["TRAJECTORY_GIT_ANCHOR"] == "head"
    assert mcp_config(ARMS["arm1"])["mcpServers"]["tea-rags"]["env"]["TRAJECTORY_GIT_ANCHOR"] == "head"
