#!/usr/bin/env python3
"""One fresh Claude Code actor session per case run, modeled on
search-cascade/2026-10-31-4mffb/repro/claude_run.py: the CURRENT Claude plugin
package via --plugin-dir (its SessionStart hook injects rules/core.md), fixture
MCP via --strict-mcp-config, `tea-rags prime` shimmed to the case's digest.
Workspace is a real git repo (own checkout = alias path) whose uncommitted edits
are the changed files. Usage: run.py E14,E15,E16 [run-label]"""
import json, os, subprocess, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cases import CASES  # noqa: E402

BASE = Path(__file__).resolve().parent
OUT = BASE.parent
ROOT = BASE.parents[4]
PLUGIN = ROOT / ".claude-plugin/tea-rags"
PY = "/opt/homebrew/bin/python3"
ids = sys.argv[1].split(",")
label = sys.argv[2] if len(sys.argv) > 2 else "r1"
stamp = time.strftime("%Y%m%d-%H%M%S")


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                   env=dict(os.environ, GIT_AUTHOR_NAME="fx", GIT_AUTHOR_EMAIL="fx@x", GIT_COMMITTER_NAME="fx", GIT_COMMITTER_EMAIL="fx@x"))


for cid in ids:
    out = OUT / "runs" / f"{cid}-{label}"
    out.mkdir(parents=True)
    work = Path("/tmp/lag-followups-claude") / f"{cid}-{label}-{stamp}"
    cwd = work / "workspace"
    cwd.mkdir(parents=True)
    alias = "acme"
    case = CASES[cid](alias, str(cwd))
    for rel, text in case["base"].items():
        (cwd / rel).parent.mkdir(parents=True, exist_ok=True)
        (cwd / rel).write_text(text)
    git(cwd, "init", "-q", "-b", "main")
    git(cwd, "add", "-A")
    git(cwd, "commit", "-q", "-m", "base")
    for rel, text in case["tree"].items():
        (cwd / rel).parent.mkdir(parents=True, exist_ok=True)
        (cwd / rel).write_text(text)
    files = dict(case["base"], **case["tree"])  # find_symbol reads the working tree
    fx = {"cwd": str(cwd), "alias": alias, "files": files, "raw_tool_responses": case["raw"]}
    (out / "fixture.json").write_text(json.dumps(fx, indent=1))
    shim = work / "bin"
    shim.mkdir()
    prime = ("# tea-rags digest — " + alias + "\nproject `" + alias + "` · path " + str(cwd)
             + " — pass `project: \"" + alias + "\"` + `path` on tea-rags calls\n"
             + "codegraph: on\n" + case["prime_extra"])
    (shim / "tea-rags").write_text("#!/bin/sh\ncase \"$1\" in\n  prime) /bin/cat <<'DIGEST'\n" + prime + "DIGEST\n;;\n  *) exit 0;;\nesac\n")
    (shim / "tea-rags").chmod(0o755)
    mcp = {"mcpServers": {"tea-rags": {"command": PY, "args": [str(BASE / "fixture_mcp.py"), "--fixture", str(out / "fixture.json"),
                                                               "--audit", str(out / "fixture-tool-audit.jsonl"), "--plugin-root", str(PLUGIN)]}}}
    (out / "mcp.json").write_text(json.dumps(mcp))
    (out / "actor-input.txt").write_text(case["prompt"])
    (out / "prime.txt").write_text(prime)
    env = dict(os.environ, PATH=str(shim) + ":" + os.environ["PATH"])
    env.pop("CLAUDE_PROJECT_DIR", None)
    cmd = ["claude", "-p", case["prompt"], "--plugin-dir", str(PLUGIN), "--mcp-config", str(out / "mcp.json"), "--strict-mcp-config",
           "--setting-sources", "project", "--output-format", "stream-json", "--verbose", "--model", "opus",
           "--allowedTools", "mcp__tea-rags__*", "Bash", "Read", "Grep", "Glob", "ReadMcpResourceTool", "ListMcpResourcesTool"]
    started = time.monotonic()
    with (out / "stream.jsonl").open("w") as so, (out / "stderr.txt").open("w") as se:
        rc = subprocess.run(cmd, cwd=cwd, env=env, stdout=so, stderr=se, timeout=600).returncode
    (out / "status.json").write_text(json.dumps({"case": cid, "run": label, "rc": rc, "wall_seconds": round(time.monotonic() - started, 1),
                                                  "plugin": str(PLUGIN), "cwd": str(cwd)}))
    print("CASE", cid, label, rc, flush=True)
