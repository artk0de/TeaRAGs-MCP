import argparse
import datetime as dt
import json
import time
from concurrent.futures import ThreadPoolExecutor

from . import agent, collect, config, evaluate, indexing, localize, probe, report, repos, tasks


def _tasks(name: str) -> tuple[str, list[tasks.Task]]:
    dataset, ids = tasks.load_task_list(config.TASKS_DIR / f"{name}.json")
    return dataset, tasks.by_ids(tasks.load(dataset), ids)


def main() -> None:
    p = argparse.ArgumentParser(prog="swe-lite-ab")
    sub = p.add_subparsers(dest="stage", required=True)
    sel = sub.add_parser("select")
    sel.add_argument("--profile", choices=["pilot", "django-focus", "rebench", "pro"], default="pilot")
    for stage in ("prepare", "index", "run", "run-paired", "collect", "evaluate", "report", "probe"):
        s = sub.add_parser(stage)
        s.add_argument("--tasks", default="pilot-50")
        if stage in ("run", "collect", "evaluate"):
            s.add_argument("--arm", choices=sorted(config.ARMS), required=True)
        if stage in ("run", "run-paired", "probe"):
            s.add_argument("--parallel", type=int, default=2)
        if stage == "run-paired":
            s.add_argument("--seed", type=int, default=20261003)
    loc = sub.add_parser("localize")
    loc.add_argument("--tasks", default="loc-10")
    a = p.parse_args()

    if a.stage == "localize":
        # Retrieval-only: no LLM, no task objects — ids, the locagent issue texts and the indexes.
        _, ids = tasks.load_task_list(localize.task_list_path(a.tasks))
        started = time.monotonic()
        records = localize.run(ids)
        out = config.RESULTS_DIR / f"localize-{a.tasks}-{dt.date.today()}.md"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(localize.render(records, a.tasks, time.monotonic() - started))
        print(out)
        return

    if a.stage == "select" and a.profile == "django-focus":
        # Scored: 30 sampled not-named django tasks + every named one (control); dev: 5 other not-named.
        lite = tasks.load_lite()
        dev, _ = tasks.select_focus(lite, "django/django", n_not_named=5, seed=20261003)
        not_named, named = tasks.select_focus(lite, "django/django", n_not_named=30, seed=20261003,
                                              exclude=frozenset(t.instance_id for t in dev))
        tasks.save_ids(dev, config.TASKS_DIR / "dev-django-5.json")
        tasks.save_ids(sorted(not_named + named, key=lambda t: t.instance_id), config.TASKS_DIR / "django-focus-50.json")
        return
    if a.stage == "select" and a.profile == "rebench":
        # Scored: every large task since 2026-01 (bug + feature) and 20 seeded small bug fixes (control).
        chosen = tasks.select_rebench(tasks.load("rebench"), since="2026-01", n_small_bug=20, seed=20261006)
        tasks.save_task_list(chosen, config.TASKS_DIR / "rebench-2026.json", "rebench")
        return
    if a.stage == "select" and a.profile == "pro":
        # Every kept Pro task (Python + TypeScript); the memorisation probe narrows it afterwards.
        tasks.save_task_list(tasks.load("pro"), config.TASKS_DIR / "pro-py-ts.json", "pro")
        return
    if a.stage == "select":
        lite = tasks.load_lite()
        dev = tasks.select_stratified(lite, n=5, seed=20261003)
        pilot = tasks.select_stratified(lite, n=50, seed=20261003, exclude=frozenset(t.instance_id for t in dev))
        tasks.save_ids(dev, config.TASKS_DIR / "dev-5.json")
        tasks.save_ids(pilot, config.TASKS_DIR / "pilot-50.json")
        return
    dataset, ts = _tasks(a.tasks)
    if a.stage == "prepare":
        for t in ts:
            repos.prepare_task_repo(t, repos.ensure_mirror(t.repo), repos.task_dir(t.instance_id))
    elif a.stage == "index":
        print(json.dumps(indexing.run_chain(ts), indent=2))
    elif a.stage == "run":
        arm = config.ARMS[a.arm]
        with ThreadPoolExecutor(a.parallel) as pool:
            list(pool.map(lambda t: agent.run_task(arm, t), ts))
    elif a.stage == "run-paired":
        # Both arms of a task run sequentially inside one worker, so both see the same parallelism.
        with ThreadPoolExecutor(a.parallel) as pool:
            list(pool.map(lambda t: agent.run_pair(t, a.seed), ts))
    elif a.stage == "probe":
        print(probe.run(ts, a.parallel))
    elif a.stage == "collect":
        collect.write_predictions(a.arm, ts)
    elif a.stage == "evaluate":
        evaluate.run(a.arm, ts, f"{a.arm}-{a.tasks}", dataset)
    elif a.stage == "report":
        resolved = {arm: evaluate.resolved_ids(evaluate.report_path(arm, f"{arm}-{a.tasks}")) for arm in config.ARMS}
        rows = report.build_rows(ts, resolved, config.USAGE_SOURCE,
                                 probe.load_hits(config.PROBE_FILE) if config.PROBE_FILE.exists() else None)
        out = config.RESULTS_DIR / f"{a.tasks}-{dt.date.today()}.md"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(report.render(rows, report.load_index_records(config.RUNS / "index.jsonl")))
        report.write_csv(rows, out.with_suffix(".csv"))
        print(out)
