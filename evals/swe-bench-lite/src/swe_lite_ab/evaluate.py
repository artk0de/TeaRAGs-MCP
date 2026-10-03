import json
import subprocess
from pathlib import Path

from . import config
from .tasks import Task


def report_path(arm: str, run_id: str) -> Path:
    """Where the harness writes its report: <report_dir>/<model_name_or_path>.<run_id>.json."""
    return config.RUNS / "reports" / f"{arm}.{run_id}.json"


def harness_command(arm: str, predictions: Path, ids: list[str], run_id: str) -> list[str]:
    return ["python", "-m", "swebench.harness.run_evaluation",
            "--dataset_name", config.DATASET, "--predictions_path", str(predictions),
            "--instance_ids", *ids, "--max_workers", "4", "--run_id", run_id,
            "--report_dir", str(report_path(arm, run_id).parent)]


def run(arm: str, tasks: list[Task], run_id: str) -> Path:
    predictions = config.RUNS / arm / "predictions.jsonl"
    subprocess.run(harness_command(arm, predictions, [t.instance_id for t in tasks], run_id),
                   cwd=config.RUNS, check=True)
    return report_path(arm, run_id)


def resolved_ids(report: Path) -> set[str]:
    return set(json.loads(report.read_text()).get("resolved_ids", []))
