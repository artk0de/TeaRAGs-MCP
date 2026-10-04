import json
import subprocess
from pathlib import Path

from . import config
from .tasks import Task


def report_path(arm: str, run_id: str) -> Path:
    """Where the harness writes its report: <report_dir>/<model_name_or_path>.<run_id>.json."""
    return config.RUNS / "reports" / f"{arm}.{run_id}.json"


def image_name(instance_id: str) -> str:
    return "swebench/sweb.eval.x86_64." + instance_id.replace("__", "_1776_").lower() + ":latest"


def pull_command(instance_id: str) -> list[str]:
    return ["docker", "pull", "-q", "--platform", "linux/amd64", image_name(instance_id)]


def ensure_images(ids: list[str]) -> None:
    """swebench 5.0.2 never pulls: a missing eval image fails with ImageNotFound."""
    for i in ids:
        present = subprocess.run(["docker", "image", "inspect", image_name(i)], capture_output=True).returncode == 0
        if not present:
            subprocess.run(pull_command(i), check=True)


def harness_command(arm: str, predictions: Path, ids: list[str], run_id: str) -> list[str]:
    return ["python", "-m", "swebench.harness.run_evaluation",
            "--dataset_name", config.DATASET, "--predictions_path", str(predictions),
            "--instance_ids", *ids, "--max_workers", "4", "--run_id", run_id,
            "--report_dir", str(report_path(arm, run_id).parent)]


def run(arm: str, tasks: list[Task], run_id: str) -> Path:
    predictions = config.RUNS / arm / "predictions.jsonl"
    ids = [t.instance_id for t in tasks]
    ensure_images(ids)
    subprocess.run(harness_command(arm, predictions, ids, run_id),
                   cwd=config.RUNS, check=True)
    return report_path(arm, run_id)


def resolved_ids(report: Path) -> set[str]:
    return set(json.loads(report.read_text()).get("resolved_ids", []))
