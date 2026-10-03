import argparse
import datetime as dt
import json
from concurrent.futures import ThreadPoolExecutor

from . import agent, collect, config, evaluate, indexing, report, repos, tasks


def _tasks(name: str) -> list[tasks.Task]:
    return tasks.by_ids(tasks.load_lite(), tasks.load_ids(config.TASKS_DIR / f"{name}.json"))


def main() -> None:
    p = argparse.ArgumentParser(prog="swe-lite-ab")
    sub = p.add_subparsers(dest="stage", required=True)
    sub.add_parser("select")
    for stage in ("prepare", "index", "run", "collect", "evaluate", "report"):
        s = sub.add_parser(stage)
        s.add_argument("--tasks", default="pilot-50")
        if stage in ("run", "collect", "evaluate"):
            s.add_argument("--arm", choices=sorted(config.ARMS), required=True)
        if stage == "run":
            s.add_argument("--parallel", type=int, default=2)
    a = p.parse_args()

    if a.stage == "select":
        lite = tasks.load_lite()
        dev = tasks.select_stratified(lite, n=5, seed=20261003)
        pilot = tasks.select_stratified(lite, n=50, seed=20261003, exclude=frozenset(t.instance_id for t in dev))
        tasks.save_ids(dev, config.TASKS_DIR / "dev-5.json")
        tasks.save_ids(pilot, config.TASKS_DIR / "pilot-50.json")
        return
    ts = _tasks(a.tasks)
    if a.stage == "prepare":
        for t in ts:
            repos.prepare_task_repo(t, repos.ensure_mirror(t.repo), repos.task_dir(t.instance_id))
    elif a.stage == "index":
        print(json.dumps(indexing.run_chain(ts), indent=2))
    elif a.stage == "run":
        arm = config.ARMS[a.arm]
        with ThreadPoolExecutor(a.parallel) as pool:
            list(pool.map(lambda t: agent.run_task(arm, t), ts))
    elif a.stage == "collect":
        collect.write_predictions(a.arm, ts)
    elif a.stage == "evaluate":
        evaluate.run(a.arm, ts, f"{a.arm}-{a.tasks}")
    elif a.stage == "report":
        resolved = {arm: evaluate.resolved_ids(evaluate.report_path(arm, f"{arm}-{a.tasks}")) for arm in config.ARMS}
        rows = report.build_rows(ts, resolved, config.USAGE_SOURCE)
        out = config.RESULTS_DIR / f"{a.tasks}-{dt.date.today()}.md"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(report.render(rows, report.load_index_records(config.RUNS / "index.jsonl")))
        report.write_csv(rows, out.with_suffix(".csv"))
        print(out)
