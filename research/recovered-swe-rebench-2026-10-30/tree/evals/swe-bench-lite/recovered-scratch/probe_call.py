import json, os, subprocess, sys
sys.path.insert(0, "/Users/artk0re/Dev/Tools/tea-rags-mcp/.claude/worktrees/swe-rebench/evals/swe-bench-lite/src")
from swe_lite_ab import config, indexing, localize
env = {**os.environ, **config.EMBEDDING_ENV}
ids = json.load(open(config.TASKS_DIR / "loc-10.json"))["ids"]
done = {json.loads(l)["instance_id"] for l in (config.RUNS / "index.jsonl").read_text().splitlines() if l}
rows = localize.load_locagent()
for i in ids:
    p = subprocess.run(["tea-rags", "call", "get_index_status", json.dumps({"project": indexing.alias_for(i)})],
                       env=env, capture_output=True, text=True, cwd="/tmp")
    out = (p.stdout + p.stderr).replace("\n", " ")
    g = localize.scored_gold(rows[i]["patch"])
    print(i[:60], "rec" if i in done else "-", p.returncode, len(rows[i]["problem_statement"]), g["primary"], len(g["secondary"]), out[:160])
