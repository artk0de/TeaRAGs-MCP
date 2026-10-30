from swe_lite_ab.tasks import Task

TEST_PATCH = """diff --git a/tests/test_copy.py b/tests/test_copy.py
--- a/tests/test_copy.py
+++ b/tests/test_copy.py
@@ -1 +1,2 @@
 import copier
+assert copier
"""


def row(instance_id="copier-org__copier-2646", interface="", **overrides):
    r = {
        "instance_id": instance_id, "repo": "copier-org/copier", "base_commit": "abc123",
        "patch": "diff --git a/copier/main.py b/copier/main.py\n", "test_patch": TEST_PATCH,
        "problem_statement": "Copier crashes on update", "hints_text": "", "created_at": "2026-04-30 11:21:38",
        "version": "unknown", "FAIL_TO_PASS": ["tests/test_copy.py::test_a"], "PASS_TO_PASS": ["tests/test_copy.py::test_b"],
        "docker_image": "swerebench/sweb.eval.x86_64.copier-org_1776_copier-2646:latest", "interface": interface,
        "install_config": {"test_cmd": "pytest -rA tests/test_copy.py", "log_parser": "parse_log_pytest"},
    }
    r.update(overrides)
    return r


def test_eval_script_activates_the_testbed_env_of_the_rebench_image():
    from swe_lite_ab.rebench import eval_script

    lines = eval_script(row()).splitlines()
    assert lines[:2] == ["#!/bin/bash", "set -uxo pipefail"]
    assert "source /opt/conda/bin/activate" in lines
    assert "conda activate testbed" in lines
    assert "cd /testbed" in lines


def test_eval_script_applies_the_test_patch_and_runs_the_test_command_between_markers():
    from swe_lite_ab.rebench import eval_script

    script = eval_script(row())
    start, end = script.index(": '>>>>> Start Test Output'"), script.index(": '>>>>> End Test Output'")
    assert script.index(TEST_PATCH) < start
    assert script[start:end].splitlines()[1:] == ["pytest -rA tests/test_copy.py"]


def test_eval_script_resets_test_files_to_base_before_and_after_the_run():
    from swe_lite_ab.rebench import eval_script

    lines = eval_script(row()).splitlines()
    reset = "git checkout abc123 tests/test_copy.py"
    assert lines.count(reset) == 2
    assert lines[-1] == reset


def test_to_instance_builds_a_swebench5_instance_from_a_rebench_row():
    from swe_lite_ab.rebench import eval_script, to_instance

    inst = to_instance(row())
    assert inst["image"] == "swerebench/sweb.eval.x86_64.copier-org_1776_copier-2646:latest"
    assert inst["log_parser"] == "parse_log_pytest"
    assert inst["eval_type"] == "pass_and_fail"
    assert inst["eval_script"] == eval_script(row())
    assert inst["FAIL_TO_PASS"] == ["tests/test_copy.py::test_a"]
    assert {"instance_id", "repo", "base_commit", "patch", "problem_statement", "created_at", "version"} <= inst.keys()


def test_to_instance_drops_rows_whose_interface_spec_names_the_gold_file():
    from swe_lite_ab.rebench import to_instance

    assert to_instance(row(interface="Type: Class\nPath: copier/main.py")) is None


def test_load_snapshots_harness_instances_once_and_returns_tasks(tmp_path, monkeypatch):
    import json

    from swe_lite_ab import config, rebench

    monkeypatch.setattr(config, "REBENCH_SNAPSHOT", tmp_path / "rebench.jsonl")
    calls = []
    monkeypatch.setattr(rebench, "_fetch_rows", lambda: calls.append(1) or [row(), row("x__y-1_interface", interface="Path: a.py")])

    first = rebench.load()
    second = rebench.load()

    assert first == second == [Task("copier-org__copier-2646", "copier-org/copier", "abc123", "Copier crashes on update",
                                    "diff --git a/copier/main.py b/copier/main.py\n", "2026-04-30 11:21:38")]
    assert calls == [1]
    snapshot = [json.loads(line) for line in (tmp_path / "rebench.jsonl").read_text().splitlines()]
    assert [s["instance_id"] for s in snapshot] == ["copier-org__copier-2646"]
    assert snapshot[0]["eval_script"] == rebench.eval_script(row())
