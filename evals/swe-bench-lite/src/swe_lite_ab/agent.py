import json
import os
import signal
import subprocess
import threading
import time
from pathlib import Path

from . import config
from .config import ArmConfig
from .repos import task_dir
from .tasks import Task

TASK_PROMPT = """You are working in the git repository at {repo_dir}.

Resolve the following GitHub issue by editing the source code in that repository.

<issue>
{problem_statement}
</issue>

Rules:
- Make the minimal change to non-test source files that resolves the issue.
- Do not add or modify tests.
- No test environment is available: the project's dependencies are not installed,
  so do not try to run the test suite.
- When you are done, stop. Your changes are collected with `git diff`.
"""


def render_prompt(task: Task, repo_dir: Path) -> str:
    return TASK_PROMPT.format(repo_dir=repo_dir, problem_statement=task.problem_statement)


def mcp_config(arm: ArmConfig) -> dict:
    if not arm.tea_rags:
        return {"mcpServers": {}}
    return {"mcpServers": {"tea-rags": {"type": "stdio", "command": "tea-rags", "args": ["server"],
                                        "env": dict(config.EMBEDDING_ENV)}}}


def build_command(arm: ArmConfig, task: Task, repo_dir: Path, run_dir: Path) -> tuple[list[str], dict[str, str]]:
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "config").mkdir(exist_ok=True)
    mcp_path = run_dir / "mcp.json"
    mcp_path.write_text(json.dumps(mcp_config(arm), indent=2))
    argv = ["claude", "-p", render_prompt(task, repo_dir),
            "--model", config.MODEL,
            "--output-format", "stream-json", "--verbose",
            "--max-budget-usd", str(config.MAX_BUDGET_USD),
            "--dangerously-skip-permissions",
            "--no-session-persistence",
            "--strict-mcp-config", "--mcp-config", str(mcp_path)]
    if arm.tea_rags:
        argv += ["--plugin-dir", str(config.PLUGIN_DIR)]
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "ANTHROPIC"))}
    env["CLAUDE_CONFIG_DIR"] = str(run_dir / "config")
    if config.TOKEN_FILE.exists():
        env["CLAUDE_CODE_OAUTH_TOKEN"] = config.TOKEN_FILE.read_text().strip()
    return argv, env


def reset_repo(repo_dir: Path) -> None:
    """Both arms share runs/repos/<id>; every run starts from the pristine base."""
    subprocess.run(["git", "checkout", "-q", "--force", "swe-base"], cwd=repo_dir, check=True)
    subprocess.run(["git", "clean", "-fdq"], cwd=repo_dir, check=True)


def run_task(arm: ArmConfig, task: Task) -> Path:
    """Runs the agent, writing each stream-json line unchanged to transcript.jsonl and its arrival
    offset (seconds since process start) to arrivals.txt, so tool durations can be timed afterwards."""
    repo_dir = task_dir(task.instance_id)
    reset_repo(repo_dir)
    run_dir = config.RUNS / arm.name / task.instance_id
    argv, env = build_command(arm, task, repo_dir, run_dir)
    started = time.monotonic()
    # Own process group: the agent spawns MCP servers that inherit stdout; a timeout kills them all.
    proc = subprocess.Popen(argv, cwd=repo_dir, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, start_new_session=True)
    stderr_chunks: list[str] = []
    with (run_dir / "transcript.jsonl").open("w") as out, (run_dir / "arrivals.txt").open("w") as arrivals:
        def pump_stdout() -> None:
            for line in proc.stdout:
                arrivals.write(f"{time.monotonic() - started:.3f}\n")
                out.write(line)

        readers = [threading.Thread(target=pump_stdout, daemon=True),
                   threading.Thread(target=lambda: stderr_chunks.append(proc.stderr.read()), daemon=True)]
        for r in readers:
            r.start()
        try:
            proc.wait(timeout=config.AGENT_TIMEOUT_S)
            timed_out = False
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
            timed_out = True
        wall = time.monotonic() - started
        for r in readers:
            r.join(timeout=30)
    status = {"returncode": None if timed_out else proc.returncode, "timeout": timed_out,
              "stderr": "".join(stderr_chunks)[-4000:], "wall_seconds": round(wall, 3)}
    (run_dir / "status.json").write_text(json.dumps(status, indent=2))
    return run_dir
