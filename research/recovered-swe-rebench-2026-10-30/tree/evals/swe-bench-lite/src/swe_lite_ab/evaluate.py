import json
import subprocess
from pathlib import Path

from . import config
from .tasks import Task


def report_path(arm: str, run_id: str) -> Path:
    """Where the harness writes its report: <report_dir>/<model_name_or_path>.<run_id>.json."""
    return config.RUNS / "reports" / f"{arm}.{run_id}.json"


_IMAGE_NAMESPACE = {"lite": "swebench", "rebench": "swerebench"}


def image_name(instance_id: str, dataset: str = "lite") -> str:
    return f"{_IMAGE_NAMESPACE[dataset]}/sweb.eval.x86_64." + instance_id.replace("__", "_1776_").lower() + ":latest"


def pull_command(instance_id: str, dataset: str = "lite") -> list[str]:
    return ["docker", "pull", "-q", "--platform", "linux/amd64", image_name(instance_id, dataset)]


def ensure_images(ids: list[str], dataset: str = "lite") -> None:
    """swebench 5.0.2 never pulls: a missing eval image fails with ImageNotFound."""
    for i in ids:
        image = image_name(i, dataset)
        present = subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode == 0
        if not present:
            subprocess.run(pull_command(i, dataset), check=True)


def harness_dataset(dataset: str) -> str:
    """Lite grades from the Hub dataset; rebench from the snapshot rebench.load wrote as instances."""
    return config.DATASET if dataset == "lite" else str(config.REBENCH_SNAPSHOT)


def harness_command(arm: str, predictions: Path, ids: list[str], run_id: str, dataset: str = "lite") -> list[str]:
    return ["python", "-m", "swebench.harness.run_evaluation",
            "--dataset_name", harness_dataset(dataset), "--predictions_path", str(predictions),
            "--instance_ids", *ids, "--max_workers", "4", "--run_id", run_id,
            "--report_dir", str(report_path(arm, run_id).parent)]


def run(arm: str, tasks: list[Task], run_id: str, dataset: str = "lite") -> Path:
    if dataset == "pro":
        from . import pro

        return pro.grade(arm, tasks, run_id)
    predictions = config.RUNS / arm / "predictions.jsonl"
    ids = [t.instance_id for t in tasks]
    ensure_images(ids, dataset)
    subprocess.run(harness_command(arm, predictions, ids, run_id, dataset),
                   cwd=config.RUNS, check=True)
    return report_path(arm, run_id)


def resolved_ids(report: Path) -> set[str]:
    return set(json.loads(report.read_text()).get("resolved_ids", []))
