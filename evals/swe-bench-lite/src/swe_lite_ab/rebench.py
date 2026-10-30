"""SWE-rebench leaderboard rows as swebench 5.x harness instances.

swebench 5.x grades from per-instance `image` / `eval_script` / `log_parser` / `eval_type`; rebench
ships `docker_image` and an `install_config` with the test command instead. The rebench images keep
conda under /opt/conda (Lite's under /opt/miniconda3) with the repository at /testbed.
"""
import json

from . import config
from .tasks import Task, gold_files

_HEREDOC = "EOF_114329324912"


def eval_script(row: dict) -> str:
    base, test_files = row["base_commit"], " ".join(gold_files(row["test_patch"]))
    reset = f"git checkout {base} {test_files}"
    return "\n".join([
        "#!/bin/bash",
        "set -uxo pipefail",
        "source /opt/conda/bin/activate",
        "conda activate testbed",
        "cd /testbed",
        "git config --global --add safe.directory /testbed",
        reset,
        f"git apply -v - <<'{_HEREDOC}'",
        row["test_patch"].rstrip("\n"),
        _HEREDOC,
        ": '>>>>> Start Test Output'",
        row["install_config"]["test_cmd"],
        ": '>>>>> End Test Output'",
        reset,
    ]) + "\n"


def to_instance(row: dict) -> dict | None:
    """None for interface tasks: their spec names the gold file's path, and without it the tests demand
    API names the agent cannot know."""
    if row.get("interface"):
        return None
    return {
        "instance_id": row["instance_id"], "repo": row["repo"], "base_commit": row["base_commit"],
        "patch": row["patch"], "test_patch": row["test_patch"], "problem_statement": row["problem_statement"],
        "hints_text": row.get("hints_text", ""), "created_at": str(row["created_at"]), "version": row["version"],
        "FAIL_TO_PASS": row["FAIL_TO_PASS"], "PASS_TO_PASS": row["PASS_TO_PASS"],
        "image": row["docker_image"], "log_parser": row["install_config"]["log_parser"],
        "eval_type": "pass_and_fail", "eval_script": eval_script(row),
    }


def _task(inst: dict) -> Task:
    return Task(inst["instance_id"], inst["repo"], inst["base_commit"], inst["problem_statement"],
                inst["patch"], inst["created_at"])


def load() -> list[Task]:
    """The snapshot doubles as the harness dataset (`--dataset_name <snapshot>.jsonl`), so agents and
    grading read the same fixed task content offline."""
    if not config.REBENCH_SNAPSHOT.exists():
        instances = [i for i in map(to_instance, _fetch_rows()) if i is not None]
        config.REBENCH_SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
        config.REBENCH_SNAPSHOT.write_text("".join(json.dumps(i) + "\n" for i in instances))
    return [_task(json.loads(line)) for line in config.REBENCH_SNAPSHOT.read_text().splitlines() if line]


def _fetch_rows() -> list[dict]:
    from datasets import load_dataset

    return list(load_dataset(config.REBENCH_DATASET, split="test"))
