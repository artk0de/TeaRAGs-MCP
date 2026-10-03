from dataclasses import dataclass
from pathlib import Path

EVAL_ROOT = Path(__file__).resolve().parents[2]
RUNS = EVAL_ROOT / "runs"
TASKS_DIR = EVAL_ROOT / "tasks"
RESULTS_DIR = EVAL_ROOT / "results"
REPO_ROOT = EVAL_ROOT.parents[1]
PLUGIN_DIR = REPO_ROOT / ".claude-plugin" / "tea-rags"
TOKEN_FILE = Path.home() / ".config" / "swe-lite-ab" / "oauth-token"

MODEL = "claude-sonnet-5-5"
DATASET = "SWE-bench/SWE-bench_Lite"
AGENT_TIMEOUT_S = 1800
MAX_BUDGET_USD = 5.0

EMBEDDING_ENV = {
    "EMBEDDING_PROVIDER": "llama-server",
    "EMBEDDING_MODEL": "brokkai/Muninn-small",
    "EMBEDDING_BASE_URL": "http://192.168.1.71:8091,8092,8093,8094",
    "QDRANT_URL": "embedded",
    "TRAJECTORY_GIT_ENABLED": "true",
    "CODEGRAPH_ENABLED": "true",
    "INGEST_ENABLE_HYBRID": "true",
}

# Decided by Task 1 (SPIKES.md).
USAGE_SOURCE = "sum"            # "result" | "sum"
SEED_MODE = "worktree-create"   # "worktree-create" | "full"
EVAL_BACKEND = "local"          # "local" | "sb-cli"


@dataclass(frozen=True)
class ArmConfig:
    name: str
    tea_rags: bool


ARMS = {"arm0": ArmConfig("arm0", False), "arm1": ArmConfig("arm1", True)}
