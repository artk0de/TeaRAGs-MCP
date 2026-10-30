import json
import random

from datasets import load_dataset

from swe_lite_ab import config, tasks
from swe_lite_ab.tasks import Task, gold_files, mentions_gold_file

loc = {r["instance_id"]: r for r in load_dataset("OpenHands/SWE-bench_Pro-locagent", split="test")}
pro = {t.instance_id: t for t in tasks.load("pro")}
rng = random.Random(20261006)
chosen = []
for repo, n in (("qutebrowser/qutebrowser", 4), ("internetarchive/openlibrary", 3), ("ansible/ansible", 3)):
    pool = sorted(i for i, r in loc.items() if r["repo"] == repo and i in pro
                  and not mentions_gold_file(Task(i, repo, r["base_commit"], r["problem_statement"], r["patch"], ""))
                  and set(gold_files(r["patch"])) == set(gold_files(pro[i].patch)))
    pick = rng.sample(pool, n)
    chosen += pick
    print(repo, "eligible", len(pool), "picked", n)
for i in chosen:
    print(" ", i[:70], gold_files(loc[i]["patch"]))
tasks.save_task_list([pro[i] for i in sorted(chosen)], config.TASKS_DIR / "loc-10.json", "pro")
