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
    kind: str = ""          # "bug" | "feature" when the dataset labels it (Pro); "" = issue-text heuristic


def gold_files(patch: str) -> list[str]:
    return _DIFF_HEADER.findall(patch)


def mentions_gold_file(task: Task) -> bool:
    text = task.problem_statement
    return any(path in text or path.rsplit("/", 1)[-1] in text for path in gold_files(task.patch))


def patch_size(patch: str) -> tuple[int, int]:
    """(files, changed lines) of a unified diff, file headers excluded."""
    changed = sum(1 for line in patch.splitlines() if line[:1] in "+-" and line[:3] not in ("+++", "---"))
    return len(gold_files(patch)), changed


# A large task touches several files with a real body of change; one-line fixes are the small stratum.
LARGE_MIN_FILES, LARGE_MIN_LINES = 2, 40
# Issue-text heuristic for bug reports versus feature requests, read from the head of the issue.
_BUG_WORDS = re.compile(r"\b(bug|error|traceback|exception|crash(es|ed)?|fails?|failing|failed|broken|incorrect|wrong"
                        r"|regression|raises?)\b", re.I)


def stratum(task: Task) -> str:
    files, lines = patch_size(task.patch)
    size = "large" if files >= LARGE_MIN_FILES and lines >= LARGE_MIN_LINES else "small"
    kind = task.kind or ("bug" if _BUG_WORDS.search(task.problem_statement[:1500]) else "feature")
    return f"{size}-{kind}"


def select_rebench(tasks: list[Task], since: str, n_small_bug: int, seed: int) -> list[Task]:
    """Every large task created on or after `since` (both kinds), plus a seeded sample of small bug
    fixes as the one-file control. Id-sorted."""
    pool = sorted((t for t in tasks if t.created_at[:len(since)] >= since), key=lambda t: t.instance_id)
    large = [t for t in pool if stratum(t).startswith("large-")]
    small_bugs = [t for t in pool if stratum(t) == "small-bug"]
    sample = random.Random(seed).sample(small_bugs, min(n_small_bug, len(small_bugs)))
    return sorted(large + sample, key=lambda t: t.instance_id)


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


def select_focus(tasks: list[Task], repo: str, n_not_named: int, seed: int,
                 exclude: frozenset[str] = frozenset()) -> tuple[list[Task], list[Task]]:
    """One repo: a seeded sample of tasks whose issue does not name the gold file, plus every task
    whose issue does (the named control). Both id-sorted; `exclude` removes ids from both pools."""
    pool = sorted((t for t in tasks if t.repo == repo and t.instance_id not in exclude), key=lambda t: t.instance_id)
    named = [t for t in pool if mentions_gold_file(t)]
    not_named_pool = [t for t in pool if not mentions_gold_file(t)]
    if len(not_named_pool) < n_not_named:
        raise ValueError(f"{repo}: {len(not_named_pool)} not-named tasks, {n_not_named} requested")
    sample = random.Random(seed).sample(not_named_pool, n_not_named)
    return sorted(sample, key=lambda t: t.instance_id), named


def load_lite() -> list[Task]:
    """Lite from a local snapshot, written on first use: later stages run offline, and the task
    content stays fixed for the whole experiment even if the Hub publishes a new revision."""
    if config.LITE_SNAPSHOT.exists():
        return [Task(**json.loads(line)) for line in config.LITE_SNAPSHOT.read_text().splitlines() if line]
    rows = _fetch_lite()
    config.LITE_SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
    config.LITE_SNAPSHOT.write_text("".join(json.dumps(asdict(t)) + "\n" for t in rows))
    return rows


def _fetch_lite() -> list[Task]:
    from datasets import load_dataset

    rows = load_dataset(config.DATASET, split="test")
    return [Task(r["instance_id"], r["repo"], r["base_commit"], r["problem_statement"], r["patch"], r["created_at"]) for r in rows]


def save_ids(tasks: list[Task], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([t.instance_id for t in tasks], indent=2) + "\n")


def load_ids(path: Path) -> list[str]:
    return load_task_list(path)[1]


def save_task_list(tasks: list[Task], path: Path, dataset: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"dataset": dataset, "ids": [t.instance_id for t in tasks]}, indent=2) + "\n")


def load_task_list(path: Path) -> tuple[str, list[str]]:
    """(dataset, ids). A bare id list predates the dataset field and is Lite."""
    data = json.loads(path.read_text())
    return ("lite", data) if isinstance(data, list) else (data["dataset"], data["ids"])


def load(dataset: str) -> list[Task]:
    if dataset == "lite":
        return load_lite()
    from . import pro, rebench

    return pro.load() if dataset == "pro" else rebench.load()


def by_ids(tasks: list[Task], ids: list[str]) -> list[Task]:
    index = {t.instance_id: t for t in tasks}
    return [index[i] for i in ids]


def to_json(task: Task) -> dict:
    return asdict(task)
