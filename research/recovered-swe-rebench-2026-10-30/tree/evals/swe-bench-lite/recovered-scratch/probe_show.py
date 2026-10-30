import json

from swe_lite_ab import config, tasks

ids = set(tasks.load_task_list(config.TASKS_DIR / "probe-repos.json")[1])
by_id = {t.instance_id: t for t in tasks.load("pro")}
for line in config.PROBE_FILE.read_text().splitlines():
    r = json.loads(line)
    if r["instance_id"] not in ids:
        continue
    t = by_id[r["instance_id"]]
    gold = tasks.gold_files(t.patch)
    pred = r.get("predicted") or r.get("paths") or []
    dirs_gold = {g.rsplit("/", 1)[0] for g in gold}
    dir_hit = any(p.rsplit("/", 1)[0] in dirs_gold for p in pred)
    print(f"{t.repo:30} hit={r['hit']!s:5} dir_hit={dir_hit!s:5} cost={r.get('cost_usd')}")
    print("   gold:", gold[:4])
    print("   pred:", pred[:4])
