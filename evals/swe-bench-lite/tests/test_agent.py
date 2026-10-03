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


def test_both_arms_share_model_and_limits(tmp_path):
    a0, _ = build_command(ARMS["arm0"], TASK, Path("/r"), tmp_path / "a0")
    a1, _ = build_command(ARMS["arm1"], TASK, Path("/r"), tmp_path / "a1")
    for flag in ("--model", "--max-budget-usd", "--output-format"):
        assert a0[a0.index(flag) + 1] == a1[a1.index(flag) + 1]
