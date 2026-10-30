import json
import random
from collections import defaultdict

from swe_lite_ab import config, tasks

pool = defaultdict(list)
for t in tasks.load("pro"):
    if not tasks.mentions_gold_file(t):
        pool[t.repo].append(t)
chosen = []
for repo in sorted(pool):
    ts = sorted(pool[repo], key=lambda t: t.instance_id)
    sample = random.Random(20261006).sample(ts, 1)
    chosen += sample
    print(repo, "not named:", len(ts), "sampled:", len(sample))
tasks.save_task_list(sorted(chosen, key=lambda t: t.instance_id), config.TASKS_DIR / "probe-repos.json", "pro")
