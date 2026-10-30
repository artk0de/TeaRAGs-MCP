import os
from dataclasses import dataclass
from pathlib import Path

EVAL_ROOT = Path(__file__).resolve().parents[2]
RUNS = EVAL_ROOT / "runs"
# Claude Code loads CLAUDE.md, CLAUDE.local.md and .claude/ from every ANCESTOR of its working
# directory, whatever CLAUDE_CONFIG_DIR says. Task repositories under this checkout would inherit
# the operator's ~/.claude/CLAUDE.md and tea-rags' own project rules in both arms, so they live
# outside the home tree.
REPOS_ROOT = Path(os.environ.get("SWE_LITE_AB_REPOS", "/Users/Shared/swe-lite-ab/repos"))
TASKS_DIR = EVAL_ROOT / "tasks"
LITE_SNAPSHOT = RUNS / "lite.jsonl"
# SWE-rebench leaderboard as swebench 5.x harness instances (rebench.py); also the harness dataset.
REBENCH_SNAPSHOT = RUNS / "rebench.jsonl"
# SWE-bench Pro V2, Python + TypeScript rows (pro.py). The tooling checkout holds every task's
# instruction.md (the agent input) and verifier (tests/test.sh and friends).
PRO_SNAPSHOT = RUNS / "pro.jsonl"
PRO_OS = Path(os.environ.get("SWE_PRO_OS", "/Users/Shared/swe-lite-ab/swe-bench-pro-os"))
PRO_DATASET = "ScaleAI/SWE-bench_Pro"
PRO_VERIFIER_TIMEOUT_S = 3000
# Memorisation probe (probe.py): answers per task, and the empty working directories the model is
# asked from (outside the home tree, so no CLAUDE.md ancestor leaks into the probe).
PROBE_FILE = RUNS / "probe.jsonl"
PROBE_ROOT = Path(os.environ.get("SWE_LITE_AB_PROBE", "/Users/Shared/swe-lite-ab/probe"))
# Per-repository .contextignore templates, named <owner>__<repo>. tea-rags reads .contextignore only
# from the indexed root, so prepare installs one into every task repository.
CONTEXTIGNORE_DIR = EVAL_ROOT / "contextignore"
RESULTS_DIR = EVAL_ROOT / "results"
REPO_ROOT = EVAL_ROOT.parents[1]
PLUGIN_DIR = REPO_ROOT / ".claude-plugin" / "tea-rags"
TOKEN_FILE = Path.home() / ".config" / "swe-lite-ab" / "oauth-token"

MODEL = "claude-sonnet-5-5"
DATASET = "SWE-bench/SWE-bench_Lite"
REBENCH_DATASET = "nebius/SWE-rebench-leaderboard"
AGENT_TIMEOUT_S = 1800
MAX_BUDGET_USD = 5.0

EMBEDDING_ENV = {
    "EMBEDDING_PROVIDER": "llama-server",
    "EMBEDDING_MODEL": "brokkai/Muninn-small",
    "EMBEDDING_BASE_URL": "http://192.168.1.71:8091,8092,8093,8094",
    "QDRANT_URL": "embedded",
    "TRAJECTORY_GIT_ENABLED": "true",
    # Task repositories are historical snapshots (HEADs 2012-2023): anchor git windows and ages on
    # the HEAD commit, not on today (bd tea-rags-mcp-i6tkc). Stamped with the index.
    "TRAJECTORY_GIT_ANCHOR": "head",
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

# Component localization benchmark (localize.py): the ORIGINAL Pro issue texts, no LLM.
LOCAGENT_DATASET = "OpenHands/SWE-bench_Pro-locagent"
LOCAGENT_SNAPSHOT = RUNS / "locagent.jsonl"
