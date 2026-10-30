import json

from swe_lite_ab.tasks import Task

PATCH = """diff --git a/lib/ansible/cli/doc.py b/lib/ansible/cli/doc.py
--- a/lib/ansible/cli/doc.py
+++ b/lib/ansible/cli/doc.py
@@ -1 +1 @@
-a
+b
"""


def task(text="Make ansible-doc list collections", patch=PATCH):
    return Task("instance_ansible__ansible-1", "ansible/ansible", "sha", text, patch, "", kind="feature")


def test_render_prompt_holds_only_the_repo_and_the_task_text_and_asks_for_paths():
    from swe_lite_ab.probe import render_prompt

    prompt = render_prompt(task())
    assert "ansible/ansible" in prompt
    assert "Make ansible-doc list collections" in prompt
    assert "one per line" in prompt
    assert "lib/ansible/cli/doc.py" not in prompt


def test_parse_paths_strips_bullets_numbering_backticks_and_prefixes():
    from swe_lite_ab.probe import parse_paths

    answer = "Here are the files:\n- `lib/ansible/cli/doc.py`\n2. ./lib/ansible/x.py\n* a/test/units/y.py\n\nlib/ansible/cli/doc.py\n"
    assert parse_paths(answer) == ["lib/ansible/cli/doc.py", "lib/ansible/x.py", "test/units/y.py"]


def test_hit_is_any_predicted_path_equal_to_a_gold_file():
    from swe_lite_ab.probe import hit

    assert hit(["lib/ansible/x.py", "lib/ansible/cli/doc.py"], task())
    assert not hit(["lib/ansible/cli/docs.py", "doc.py"], task())


def test_build_command_disables_tools_and_mcp_and_isolates_config(tmp_path, monkeypatch):
    from swe_lite_ab import config
    from swe_lite_ab.probe import build_command

    token = tmp_path / "token"
    token.write_text("tok\n")
    monkeypatch.setattr(config, "TOKEN_FILE", token)
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "operator")
    argv, env = build_command(task(), tmp_path / "run")
    assert argv[:2] == ["claude", "-p"]
    assert argv[argv.index("--tools") + 1] == ""
    assert argv[argv.index("--model") + 1] == config.MODEL
    assert "--strict-mcp-config" in argv and "--no-session-persistence" in argv
    assert json.loads((tmp_path / "run" / "mcp.json").read_text()) == {"mcpServers": {}}
    assert env["CLAUDE_CONFIG_DIR"] == str(tmp_path / "run" / "config")
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "tok"


def test_record_combines_prediction_hit_named_and_cost():
    from swe_lite_ab.probe import record

    result = {"result": "lib/ansible/cli/doc.py\n", "total_cost_usd": 0.01}
    rec = record(task("see doc.py"), result)
    assert rec == {"instance_id": "instance_ansible__ansible-1", "predicted": ["lib/ansible/cli/doc.py"],
                   "hit": True, "named": True, "cost_usd": 0.01}


def test_run_appends_records_and_skips_tasks_already_probed(tmp_path, monkeypatch):
    from swe_lite_ab import config, probe

    monkeypatch.setattr(config, "RUNS", tmp_path)
    monkeypatch.setattr(config, "PROBE_FILE", tmp_path / "probe.jsonl")
    (tmp_path / "probe.jsonl").write_text(json.dumps({"instance_id": "done", "hit": False}) + "\n")
    asked = []
    monkeypatch.setattr(probe, "ask", lambda t: asked.append(t.instance_id) or {"result": "x.py", "total_cost_usd": 0.0})
    done = Task("done", "o/r", "s", "", PATCH, "")

    probe.run([done, task()], parallel=2)

    assert asked == ["instance_ansible__ansible-1"]
    assert set(probe.load_hits(tmp_path / "probe.jsonl")) == {"done", "instance_ansible__ansible-1"}
