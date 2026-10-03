import json
import random
import re
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path

from . import config

_DIFF_HEADER = re.compile(r"^diff --git a/(\S+) b/\S+$", re.M)


@dataclass(frozen=True)
class Task:
    instance_id: str
    repo: str
    base_commit: str
    problem_statement: str
    patch: str
    created_at: str


def gold_files(patch: str) -> list[str]:
    return _DIFF_HEADER.findall(patch)


def mentions_gold_file(task: Task) -> bool:
    text = task.problem_statement
    return any(path in text or path.rsplit("/", 1)[-1] in text for path in gold_files(task.patch))


def select_stratified(tasks: list[Task], n: int, seed: int, exclude: frozenset[str] = frozenset()) -> list[Task]:
    pool = sorted((t for t in tasks if t.instance_id not in exclude), key=lambda t: t.instance_id)
    strata: dict[tuple[str, bool], list[Task]] = defaultdict(list)
    for t in pool:
        strata[(t.repo, mentions_gold_file(t))].append(t)
    rng = random.Random(seed)
    quotas = {k: n * len(v) / len(pool) for k, v in strata.items()}
    take = {k: int(q) for k, q in quotas.items()}
    for k in sorted(quotas, key=lambda k: (quotas[k] - take[k], k), reverse=True)[: n - sum(take.values())]:
        take[k] += 1
    chosen = [t for k in sorted(strata) for t in rng.sample(strata[k], take[k])]
    return sorted(chosen, key=lambda t: t.instance_id)


def load_lite() -> list[Task]:
    from datasets import load_dataset

    rows = load_dataset(config.DATASET, split="test")
    return [Task(r["instance_id"], r["repo"], r["base_commit"], r["problem_statement"], r["patch"], r["created_at"]) for r in rows]


def save_ids(tasks: list[Task], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([t.instance_id for t in tasks], indent=2) + "\n")


def load_ids(path: Path) -> list[str]:
    return json.loads(path.read_text())


def by_ids(tasks: list[Task], ids: list[str]) -> list[Task]:
    index = {t.instance_id: t for t in tasks}
    return [index[i] for i in ids]


def to_json(task: Task) -> dict:
    return asdict(task)
