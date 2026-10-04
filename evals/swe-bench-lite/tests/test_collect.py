import subprocess

from swe_lite_ab.collect import diff_for
from swe_lite_ab.evaluate import harness_command, image_name, pull_command


def test_write_predictions_prefers_captured_patch_over_live_repo(tmp_path, monkeypatch):
    import json

    from swe_lite_ab import collect, config
    from swe_lite_ab.tasks import Task

    monkeypatch.setattr(config, "RUNS", tmp_path)
    monkeypatch.setattr(collect, "diff_for", lambda repo_dir, base: f"live diff at {base}\n")
    captured, live = Task("a__a-1", "a/a", "s1", "", "", ""), Task("b__b-2", "b/b", "s2", "", "", "")
    (tmp_path / "arm1" / "patches").mkdir(parents=True)
    (tmp_path / "arm1" / "patches" / "a__a-1.diff").write_text("captured diff\n")

    out = collect.write_predictions("arm1", [captured, live])
    preds = {p["instance_id"]: p for p in map(json.loads, out.read_text().splitlines())}
    assert preds["a__a-1"]["model_patch"] == "captured diff\n"
    assert preds["b__b-2"]["model_patch"] == "live diff at s2\n"
    assert {p["model_name_or_path"] for p in preds.values()} == {"arm1"}


def test_image_name_follows_the_swebench_eval_image_scheme():
    assert image_name("psf__requests-2317") == "swebench/sweb.eval.x86_64.psf_1776_requests-2317:latest"
    assert image_name("django__django-11099") == "swebench/sweb.eval.x86_64.django_1776_django-11099:latest"


def test_pull_command_forces_amd64_images():
    assert pull_command("psf__requests-2317") == [
        "docker", "pull", "-q", "--platform", "linux/amd64",
        "swebench/sweb.eval.x86_64.psf_1776_requests-2317:latest",
    ]


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
