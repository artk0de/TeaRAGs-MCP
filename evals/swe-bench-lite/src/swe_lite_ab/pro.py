"""SWE-bench Pro V2 (ScaleAI/SWE-bench_Pro, split test), Python + TypeScript rows, graded locally.

The agent input is each task's `instruction.md` from the tooling checkout (PR description +
requirements + new interfaces), not the dataset's bare problem_statement. Grading follows the V2
verifier contract: the task's `tests/` dir mounted at /tests, the model patch applied in /app, then
the unchanged `bash /tests/test.sh`, whose exit code is the verdict.
"""
import json
import shlex
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import config
from .tasks import Task

# Labelled js/ts in the dataset, but their patches are .ts/.tsx. NodeBB (plain JS) and Go are dropped.
TS_REPOS = frozenset({"protonmail/webclients", "element-hq/element-web", "tutao/tutanota"})
IMAGE_REPO = "ghcr.io/scaleapi/swe-bench_pro-v2"


def language(row: dict) -> str | None:
    if row["repo_language"] == "python":
        return "python"
    return "ts" if row["repo"] in TS_REPOS else None


def kind(row: dict) -> str:
    return "bug" if any(label.endswith("_bug") for label in json.loads(row["issue_specificity"])) else "feature"


def task_dir(instance_id: str) -> Path:
    return config.PRO_OS / "v2" / "tasks" / instance_id


def image_name(instance_id: str) -> str:
    return f"{IMAGE_REPO}:{instance_id}"


def to_record(row: dict, instruction: str) -> dict:
    return {"instance_id": row["instance_id"], "repo": row["repo"], "base_commit": row["base_commit"],
            "problem_statement": instruction, "patch": row["patch"], "created_at": "", "kind": kind(row),
            "image": row["docker_image"], "language": language(row), "hard": bool(row["hard"])}


def _task(rec: dict) -> Task:
    return Task(rec["instance_id"], rec["repo"], rec["base_commit"], rec["problem_statement"], rec["patch"],
                rec["created_at"], kind=rec["kind"])


def load_records() -> list[dict]:
    """Snapshot written once; later stages read it offline, so task content stays fixed."""
    if not config.PRO_SNAPSHOT.exists():
        records = [to_record(r, (task_dir(r["instance_id"]) / "instruction.md").read_text())
                   for r in _fetch_rows() if language(r)]
        records.sort(key=lambda r: r["instance_id"])
        config.PRO_SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
        config.PRO_SNAPSHOT.write_text("".join(json.dumps(r) + "\n" for r in records))
    return [json.loads(line) for line in config.PRO_SNAPSHOT.read_text().splitlines() if line]


def load() -> list[Task]:
    return [_task(r) for r in load_records()]


def _fetch_rows() -> list[dict]:
    from datasets import load_dataset

    return list(load_dataset(config.PRO_DATASET, split="test"))


# An empty patch skips `git apply` and grades the untouched base (unresolved); a patch that does not
# apply exits 3 before the verifier runs (unresolved too).
_GRADE_SCRIPT = """set -u
cd /app 2>/dev/null || cd /testbed || exit 2
git config --global --add safe.directory '*'
if [ -s /model.patch ]; then
  git apply -v /model.patch || { echo '>>>>> MODEL PATCH DID NOT APPLY'; exit 3; }
fi
bash /tests/test.sh
rc=$?
echo ">>>>> verifier exit $rc; run_script stdout tail:"
tail -n 200 /logs/verifier/run-script-stdout.txt 2>/dev/null
exit $rc
"""


def grade_command(instance_id: str, patch_path: Path) -> list[str]:
    return ["docker", "run", "--rm", "--platform", "linux/amd64",
            "-v", f"{task_dir(instance_id) / 'tests'}:/tests:ro",
            "-v", f"{patch_path}:/model.patch:ro",
            "--entrypoint", "/bin/bash", image_name(instance_id), "-c", _GRADE_SCRIPT]


def ensure_image(image: str) -> None:
    if subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode != 0:
        subprocess.run(["docker", "pull", "-q", "--platform", "linux/amd64", image], check=True)


def _verify(argv: list[str], log: Path) -> int:
    with log.open("w") as out:
        try:
            return subprocess.run(argv, stdout=out, stderr=subprocess.STDOUT,
                                  timeout=config.PRO_VERIFIER_TIMEOUT_S).returncode
        except subprocess.TimeoutExpired:
            out.write(f"\n>>>>> verifier timed out after {config.PRO_VERIFIER_TIMEOUT_S} s\n")
            return 124


def _predictions(arm: str) -> dict[str, str]:
    path = config.RUNS / arm / "predictions.jsonl"
    if not path.exists():
        return {}
    preds = (json.loads(line) for line in path.read_text().splitlines() if line.strip())
    return {p["instance_id"]: p.get("model_patch") or "" for p in preds}


def grade(arm: str, tasks: list[Task], run_id: str, workers: int = 1) -> Path:
    """Grades runs/<arm>/predictions.jsonl task by task (a missing prediction grades as an empty
    patch), keeps each verifier log under runs/<arm>/eval/<run_id>/, and writes the report where
    evaluate.report_path expects it."""
    from .evaluate import report_path

    out_dir = config.RUNS / arm / "eval" / run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    preds = _predictions(arm)

    def one(task: Task) -> tuple[str, int]:
        patch = preds.get(task.instance_id, "")
        patch_file = out_dir / f"{task.instance_id}.diff"
        # git apply rejects a final hunk without its trailing newline as a corrupt patch.
        patch_file.write_text(patch if not patch or patch.endswith("\n") else patch + "\n")
        ensure_image(image_name(task.instance_id))
        return task.instance_id, _verify(grade_command(task.instance_id, patch_file.absolute()),
                                         out_dir / f"{task.instance_id}.log")

    with ThreadPoolExecutor(workers) as pool:
        codes = dict(pool.map(one, tasks))
    report = {"total_instances": len(tasks), "submitted_ids": sorted(preds),
              "resolved_ids": sorted(i for i, c in codes.items() if c == 0),
              "unresolved_ids": sorted(i for i, c in codes.items() if c != 0), "exit_codes": codes}
    path = report_path(arm, run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2) + "\n")
    return path
