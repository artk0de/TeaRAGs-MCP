import json
from collections import Counter

from datasets import load_dataset

from swe_lite_ab.tasks import Task, mentions_gold_file

ds = load_dataset("OpenHands/SWE-bench_Pro-locagent", split="test")
r = ds[0]
print("file_changes sample:", json.dumps(r["file_changes"])[:700])
print("statement head:", r["problem_statement"][:400].replace("\n", " | "))
print("has 'Requirements'/'interface' text:", sum("nterface" in x["problem_statement"] for x in ds), "/", len(ds))
print("distinct commits per repo:", Counter(x["repo"] for x in {(y["repo"], y["base_commit"]): y for y in ds}.values()))
named = sum(mentions_gold_file(Task(x["instance_id"], x["repo"], x["base_commit"], x["problem_statement"], x["patch"], "")) for x in ds)
print("statement names a gold file:", named, "/", len(ds))
pro_ids = {json.loads(l)["instance_id"] for l in open("runs/pro.jsonl")}
print("ids also in our pro snapshot:", sum(x["instance_id"] in pro_ids for x in ds))
