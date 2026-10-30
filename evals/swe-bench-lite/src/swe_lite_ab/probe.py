"""Memorisation probe: can the model name the files to change from the task text alone?

The model gets only the repository name and the task's problem statement - no checkout, no tools,
no MCP servers, no instructions from the operator's CLAUDE.md. A task whose gold file it names
anyway is likely memorised (or trivially implied by the text) and is reported apart.
"""
import json
import os
import re
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import config
from .repos import instruction_leaks
from .tasks import Task, gold_files, mentions_gold_file

PROBE_PROMPT = """The following task is for the GitHub repository {repo}. You do not have access to the
repository; answer from what you know about it.

<task>
{problem_statement}
</task>

List the repository-relative paths of the source files that must change to implement this task,
one per line, most likely first. Output only the paths: no prose, no bullets, no code fences.
"""

_LIST_MARKER = re.compile(r"^(?:[-*+•]\s+|\d+[.)]\s+)")
_PATH = re.compile(r"^[\w.@~+-]+(?:/[\w.@~+-]+)*\.\w+$|^[\w.@~+-]+(?:/[\w.@~+-]+)+$")


def render_prompt(task: Task) -> str:
    return PROBE_PROMPT.format(repo=task.repo, problem_statement=task.problem_statement)


def parse_paths(answer: str) -> list[str]:
    """Path-shaped lines of the answer, list markers / backticks / ./ and a/ prefixes removed, deduplicated."""
    out: list[str] = []
    for line in answer.splitlines():
        p = _LIST_MARKER.sub("", line.strip()).strip().strip("`").strip()
        for prefix in ("./", "a/", "b/"):
            if p.startswith(prefix):
                p = p[len(prefix):]
        if _PATH.match(p) and p not in out:
            out.append(p)
    return out


def hit(predicted: list[str], task: Task) -> bool:
    return bool(set(predicted) & set(gold_files(task.patch)))


def run_dir(instance_id: str) -> Path:
    return config.RUNS / "probe" / instance_id


def build_command(task: Task, rdir: Path) -> tuple[list[str], dict[str, str]]:
    """Same isolation as agent.build_command, with every tool disabled (`--tools ""`)."""
    (rdir / "config").mkdir(parents=True, exist_ok=True)
    mcp_path = rdir / "mcp.json"
    mcp_path.write_text(json.dumps({"mcpServers": {}}))
    argv = ["claude", "-p", render_prompt(task),
            "--model", config.MODEL,
            "--output-format", "json",
            "--tools", "",
            "--no-session-persistence",
            "--strict-mcp-config", "--mcp-config", str(mcp_path)]
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "ANTHROPIC"))}
    env["CLAUDE_CONFIG_DIR"] = str(rdir / "config")
    if config.TOKEN_FILE.exists():
        env["CLAUDE_CODE_OAUTH_TOKEN"] = config.TOKEN_FILE.read_text().strip()
    return argv, env


def ask(task: Task) -> dict:
    """The CLI's --output-format json result object."""
    cwd = config.PROBE_ROOT / task.instance_id
    cwd.mkdir(parents=True, exist_ok=True)
    leaks = instruction_leaks(cwd)
    if leaks or any(cwd.iterdir()):
        raise RuntimeError(f"probe cwd {cwd} is not an isolated empty dir: {', '.join(map(str, leaks))}")
    rdir = run_dir(task.instance_id)
    argv, env = build_command(task, rdir)
    proc = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=600)
    if proc.returncode != 0:
        raise RuntimeError(f"probe {task.instance_id}: claude exited {proc.returncode}: {proc.stderr[-2000:]}")
    (rdir / "result.json").write_text(proc.stdout)  # raw answer + usage, for auditing the parse
    return json.loads(proc.stdout)


def record(task: Task, result: dict) -> dict:
    predicted = parse_paths(result.get("result") or "")
    return {"instance_id": task.instance_id, "predicted": predicted, "hit": hit(predicted, task),
            "named": mentions_gold_file(task), "cost_usd": result.get("total_cost_usd")}


def load_records(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def load_hits(path: Path) -> dict[str, bool]:
    return {r["instance_id"]: r["hit"] for r in load_records(path)}


def run(tasks: list[Task], parallel: int = 2) -> Path:
    """Appends one record per task to config.PROBE_FILE; tasks already recorded are skipped (resumable)."""
    out = config.PROBE_FILE
    done = set(load_hits(out))
    lock = threading.Lock()
    out.parent.mkdir(parents=True, exist_ok=True)

    def one(task: Task) -> None:
        rec = record(task, ask(task))
        with lock, out.open("a") as f:
            f.write(json.dumps(rec) + "\n")

    with ThreadPoolExecutor(parallel) as pool:
        list(pool.map(one, [t for t in tasks if t.instance_id not in done]))
    return out
