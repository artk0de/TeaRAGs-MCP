"""Read one native observations file; preserve numeric usage, not private reasoning."""
from pathlib import Path
import hashlib
import json
import sys

source, target = map(Path, sys.argv[1:])
raw = source.read_bytes()
data = json.loads(raw)
usage = data["native_usage"]
fresh = usage["inputTokens"] - usage["cachedInputTokens"]
result = {
    "source": str(source),
    "source_sha256": hashlib.sha256(raw).hexdigest(),
    "model_responses": data["native_model_response_count"],
    "input_tokens": usage["inputTokens"],
    "fresh_input_tokens": fresh,
    "cached_input_tokens": usage["cachedInputTokens"],
    "output_tokens": usage["outputTokens"],
    "reasoning_output_tokens": usage.get("reasoningOutputTokens"),
    "seconds": data["turn_controller_wall_seconds"],
    "initial_input_tokens": data["initial_input_tokens"],
    "prompt_sha256": data["prompt_sha256"],
    "native_result": data["native_result"],
    "final_output_tokens": sum(item.get("output_tokens", 0) for item in data.get("finals", [])),
    "final_stream_seconds": sum(item.get("observed_stream_seconds", 0) for item in data.get("finals", [])),
    "observed_runtime_union_seconds": data.get("observed_all_runtime_union_seconds"),
    "model_network_client_residual_seconds": data.get("model_network_client_residual_seconds"),
    "cost_status": "unpriced: compare fresh/cached/output separately; output already includes reasoning tokens",
    "cache_limitation": "Independent fresh actor histories; provider prefix caching is observed, not disabled",
}
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({key: result[key] for key in ["model_responses", "input_tokens", "fresh_input_tokens", "cached_input_tokens", "output_tokens", "seconds", "final_output_tokens", "final_stream_seconds", "observed_runtime_union_seconds"]}))
