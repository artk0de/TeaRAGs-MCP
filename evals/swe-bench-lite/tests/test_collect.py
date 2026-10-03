import subprocess

from swe_lite_ab.collect import diff_for
from swe_lite_ab.evaluate import harness_command


def test_diff_includes_new_and_modified_files_but_not_untracked_junk(tmp_path):
    run = lambda *a: subprocess.run(["git", *a], cwd=tmp_path, check=True, capture_output=True, text=True).stdout.strip()
    run("init", "-q"); (tmp_path / "a.py").write_text("x = 1\n"); run("add", ".")
    run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base")
    base = run("rev-parse", "HEAD")
    (tmp_path / "a.py").write_text("x = 2\n"); (tmp_path / "b.py").write_text("y = 1\n")
    (tmp_path / "__pycache__").mkdir(); (tmp_path / "__pycache__" / "a.pyc").write_bytes(b"\0")
    d = diff_for(tmp_path, base)
    assert "a/a.py" in d and "b/b.py" in d and "pyc" not in d


def test_harness_command_targets_lite(tmp_path):
    cmd = harness_command("arm1", tmp_path / "p.jsonl", ["x-1", "y-2"], "arm1-pilot")
    assert cmd[:3] == ["python", "-m", "swebench.harness.run_evaluation"]
    assert cmd[cmd.index("--dataset_name") + 1] == "SWE-bench/SWE-bench_Lite"
    assert cmd[cmd.index("--instance_ids") + 1 : cmd.index("--instance_ids") + 3] == ["x-1", "y-2"]
