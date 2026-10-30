import json
from collections import Counter

from swe_lite_ab import config, tasks

d = json.loads((config.TASKS_DIR / "rebench-2026.json").read_text())
chosen = tasks.by_ids(tasks.load("rebench"), d["ids"])
print("chosen:", Counter(tasks.stratum(t) for t in chosen))
pool = [t for t in tasks.load("rebench") if t.created_at[:7] >= "2026-01"]
print("pool since 2026-01:", len(pool), Counter(tasks.stratum(t) for t in pool))
print("created_at samples:", sorted({t.created_at[:7] for t in tasks.load("rebench")})[-6:])
