"""One observations.json per invocation; retain numeric/public evidence only."""
import hashlib
import json
import sys
from pathlib import Path

source, target = map(Path, sys.argv[1:])
raw = source.read_bytes()
data = json.loads(raw)
keys = [
    "native_model_response_count", "native_usage", "initial_cached_input_tokens",
    "initial_input_tokens", "initial_uncached_input_tokens", "native_result",
    "actor_wall_seconds", "turn_controller_wall_seconds", "prompt_sha256",
    "cache_limit", "runtime_union_note", "api_cumulative_equals_completed",
]
result = {key: data.get(key) for key in keys}
result["source"] = str(source)
result["source_sha256"] = hashlib.sha256(raw).hexdigest()
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"case": source.parent.name, "steps": result["native_model_response_count"], "seconds": result["turn_controller_wall_seconds"]}))
