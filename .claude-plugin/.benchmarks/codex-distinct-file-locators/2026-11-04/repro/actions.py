"""Summarize ONE public journal export, never native reasoning or hidden grading."""
from collections import Counter
import json
from pathlib import Path
import sys

source, target = map(Path, sys.argv[1:])
data = json.loads(source.read_text())
calls = []
body_deliveries = Counter()
for wave in data["waves"]:
    for child in wave.get("children", []):
        if child.get("type") != "mcpToolCall":
            continue
        args = child.get("arguments") or {}
        tool = child.get("tool")
        row = {"wave": wave["wave"], "tool": tool}
        for key in ("query", "level", "distinctFiles", "pathPattern", "testFile", "symbol", "symbolId", "relativePath"):
            if key in args:
                row[key] = args[key]
        if isinstance(args.get("symbols"), list):
            row["targets"] = len(args["symbols"])
        if tool in ("semantic_search", "hybrid_search"):
            row["metaOnly"] = args.get("metaOnly")
        calls.append(row)
        for fact in child.get("result_facts", []):
            digest = fact.get("body_sha256")
            if digest and fact.get("body_chars", 0):
                body_deliveries[(fact.get("path"), fact.get("symbol"), digest)] += 1

searches = [c for c in calls if c["tool"] in ("semantic_search", "hybrid_search")]
result = {
    "source": str(source),
    "model_response_waves": len(data["waves"]),
    "file_level_semantic_searches": sum(c["tool"] == "semantic_search" and c.get("level") == "file" for c in searches),
    "hybrid_searches": sum(c["tool"] == "hybrid_search" for c in searches),
    "distinct_file_searches": sum(c.get("distinctFiles") is True for c in searches),
    "scoped_searches": sum(bool(c.get("pathPattern")) for c in searches),
    "discovery_calls": searches,
    "batch_body_calls": [c for c in calls if c.get("targets", 0) > 1],
    "repeated_body_hash_candidates": [
        {"path": path, "symbol": symbol, "sha256": digest, "deliveries": count}
        for (path, symbol, digest), count in body_deliveries.items() if count > 1
    ],
    "limitations": "Counts observed public tool arguments only. Repeated body hashes are review candidates, not proof of an unnecessary reread; factual quality requires separate grading."
}
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({k: result[k] for k in ("model_response_waves", "file_level_semantic_searches", "hybrid_searches", "scoped_searches")}))
