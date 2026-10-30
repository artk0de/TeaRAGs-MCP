import json

from swe_lite_ab.tasks import Task

PATCH = "diff --git a/qutebrowser/utils/version.py b/qutebrowser/utils/version.py\n"
IID = "instance_qutebrowser__qutebrowser-01d1-v2ef"


def row(instance_id=IID, repo="qutebrowser/qutebrowser", language="python", specificity='["edge_case_bug"]', **overrides):
    r = {
        "repo": repo, "instance_id": instance_id, "base_commit": "abc123", "patch": PATCH,
        "test_patch": "diff --git a/tests/test_v.py b/tests/test_v.py\n", "problem_statement": "raw issue text",
        "requirements": "- must", "interface": "", "repo_language": language, "fail_to_pass": '["t1"]',
        "pass_to_pass": "[]", "issue_specificity": specificity, "issue_categories": '["back_end_knowledge"]',
        "docker_image": f"ghcr.io/scaleapi/swe-bench_pro-v2:{instance_id}", "hard": True, "version": "1.0",
    }
    r.update(overrides)
    return r


def write_instruction(root, instance_id, text):
    d = root / "v2" / "tasks" / instance_id
    (d / "tests").mkdir(parents=True)
    (d / "instruction.md").write_text(text)
    return d


def test_keep_takes_python_rows_and_the_typescript_repos_only():
    from swe_lite_ab.pro import language

    assert language(row()) == "python"
    assert language(row(repo="protonmail/webclients", language="js")) == "ts"
    assert language(row(repo="element-hq/element-web", language="js")) == "ts"
    assert language(row(repo="tutao/tutanota", language="ts")) == "ts"
    assert language(row(repo="NodeBB/NodeBB", language="js")) is None
    assert language(row(repo="flipt-io/flipt", language="go")) is None


def test_kind_is_bug_for_any_bug_label_and_feature_otherwise():
    from swe_lite_ab.pro import kind

    assert kind(row(specificity='["edge_case_bug"]')) == "bug"
    assert kind(row(specificity='["refactoring_enh", "minor_bug"]')) == "bug"
    assert kind(row(specificity='["core_feat", "code_quality_enh"]')) == "feature"


def test_to_record_uses_the_instruction_as_the_problem_statement(tmp_path):
    from swe_lite_ab.pro import to_record

    rec = to_record(row(), "instruction text")
    assert rec["problem_statement"] == "instruction text"
    assert rec["image"] == f"ghcr.io/scaleapi/swe-bench_pro-v2:{IID}"
    assert (rec["language"], rec["kind"], rec["hard"]) == ("python", "bug", True)
    assert (rec["repo"], rec["base_commit"], rec["patch"]) == ("qutebrowser/qutebrowser", "abc123", PATCH)


def test_load_snapshots_kept_rows_once_and_returns_tasks_with_kind(tmp_path, monkeypatch):
    from swe_lite_ab import config, pro

    monkeypatch.setattr(config, "PRO_SNAPSHOT", tmp_path / "pro.jsonl")
    monkeypatch.setattr(config, "PRO_OS", tmp_path / "os")
    write_instruction(tmp_path / "os", IID, "A code repository is available in /app.")
    calls = []
    monkeypatch.setattr(pro, "_fetch_rows", lambda: calls.append(1) or [
        row(), row("instance_NodeBB__NodeBB-1", repo="NodeBB/NodeBB", language="js")])

    first = pro.load()
    second = pro.load()

    assert first == second == [Task(IID, "qutebrowser/qutebrowser", "abc123", "A code repository is available in /app.",
                                    PATCH, "", kind="bug")]
    assert calls == [1]
    snapshot = [json.loads(line) for line in (tmp_path / "pro.jsonl").read_text().splitlines()]
    assert [(s["instance_id"], s["language"]) for s in snapshot] == [(IID, "python")]


def test_grade_command_mounts_tests_and_patch_read_only_and_runs_the_verifier(tmp_path, monkeypatch):
    from swe_lite_ab import config
    from swe_lite_ab.pro import grade_command

    monkeypatch.setattr(config, "PRO_OS", tmp_path / "os")
    patch = tmp_path / "p.diff"
    argv = grade_command(IID, patch)
    assert argv[:5] == ["docker", "run", "--rm", "--platform", "linux/amd64"]
    tests = tmp_path / "os" / "v2" / "tasks" / IID / "tests"
    assert f"{tests}:/tests:ro" in argv
    assert f"{patch}:/model.patch:ro" in argv
    assert f"ghcr.io/scaleapi/swe-bench_pro-v2:{IID}" in argv
    script = argv[-1]
    assert "cd /app 2>/dev/null || cd /testbed" in script
    assert "git apply" in script and "/model.patch" in script
    assert "[ -s /model.patch ]" in script, "an empty patch skips git apply and grades the untouched base"
    assert script.index("git apply") < script.index("bash /tests/test.sh")


def test_grade_writes_logs_and_a_report_with_resolved_ids(tmp_path, monkeypatch):
    from swe_lite_ab import config, evaluate, pro

    monkeypatch.setattr(config, "RUNS", tmp_path)
    monkeypatch.setattr(config, "PRO_OS", tmp_path / "os")
    (tmp_path / "armX").mkdir()
    (tmp_path / "armX" / "predictions.jsonl").write_text(
        json.dumps({"instance_id": "a", "model_name_or_path": "armX", "model_patch": "diff --git a/x b/x"}) + "\n"
        + json.dumps({"instance_id": "b", "model_name_or_path": "armX", "model_patch": ""}) + "\n")
    pulled, ran = [], []
    monkeypatch.setattr(pro, "ensure_image", lambda image: pulled.append(image))

    def fake_verify(argv, log):
        patch = next(a for a in argv if a.endswith(":/model.patch:ro")).split(":")[0]
        ran.append(open(patch).read())
        log.write_text("verifier output\n")
        return 0 if "a" in argv[-2] else 1

    monkeypatch.setattr(pro, "_verify", fake_verify)
    monkeypatch.setattr(pro, "grade_command", lambda iid, patch: ["docker", f"{patch}:/model.patch:ro", iid, "script"])
    ts = [Task("a", "r", "c", "", "", ""), Task("b", "r", "c", "", "", ""), Task("c", "r", "c", "", "", "")]

    out = pro.grade("armX", ts, "armX-pro")

    assert out == evaluate.report_path("armX", "armX-pro")
    assert evaluate.resolved_ids(out) == {"a"}
    assert ran == ["diff --git a/x b/x\n", "", ""], "patches end in a newline; missing predictions grade as empty"
    assert len(pulled) == 3
    assert (tmp_path / "armX" / "eval" / "armX-pro" / "a.log").read_text() == "verifier output\n"
    report = json.loads(out.read_text())
    assert sorted(report["unresolved_ids"]) == ["b", "c"]
