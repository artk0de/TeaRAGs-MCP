import json
import subprocess
import sys

from swe_lite_ab import config, evaluate

iid = sys.argv[1]
NOOP = "diff --git a/noop.txt b/noop.txt\nnew file mode 100644\n--- /dev/null\n+++ b/noop.txt\n@@ -0,0 +1 @@\n+noop\n"
noop = len(sys.argv) > 2 and sys.argv[2] == "noop"
inst = next(json.loads(l) for l in config.REBENCH_SNAPSHOT.read_text().splitlines() if json.loads(l)["instance_id"] == iid)
pred = config.RUNS / "gold" / "predictions.jsonl"
pred.parent.mkdir(parents=True, exist_ok=True)
pred.write_text(json.dumps({"instance_id": iid, "model_name_or_path": "gold", "model_patch": NOOP if noop else inst["patch"]}) + "\n")
run_id = "gold-rebench-noop" if noop else "gold-rebench-smoke"
evaluate.ensure_images([iid], "rebench")
cmd = evaluate.harness_command("gold", pred, [iid], run_id, "rebench")
subprocess.run(cmd, cwd=config.RUNS, check=False)
report = evaluate.report_path("gold", run_id)
print("REPORT", report, report.exists() and json.loads(report.read_text()).get("resolved_ids"))
