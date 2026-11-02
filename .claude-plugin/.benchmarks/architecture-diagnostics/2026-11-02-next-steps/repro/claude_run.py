#!/usr/bin/env python3
"""One Claude Code actor session per case and arm, plugin via --plugin-dir, fixture MCP via --mcp-config.

Adapted from search-cascade/2026-10-31-4mffb/repro/claude_run.py for the
architecture-diagnostics suite format (prompt/actor_context/fixture.tool_responses),
plus: Skill tool allowed, retained-context placeholders resolved per arm
(__SKILL:<name>__, __PLUGIN_ROOT__, __FIXTURE_ROOT__), fixture.workspace_dirs,
and a logging `bd` shim.

usage: claude_run.py <baseline|current> <baseline-plugin-dir> <out-root> <work-root> [CASE,CASE]
"""
import json, os, re, subprocess, sys, time
from pathlib import Path

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[4]
EVALS = BASE.parents[1] / "evals/2026-11-02-next-steps.json"
PY = "/opt/homebrew/bin/python3"
arm, baseline_pkg, out_base, work_base = sys.argv[1:5]
only = [x for x in (sys.argv[5].split(",") if len(sys.argv) > 5 else []) if x]
plugin = Path(baseline_pkg) if arm == "baseline" else ROOT / ".claude-plugin/tea-rags"
out_root = Path(out_base) / arm
out_root.mkdir(parents=True, exist_ok=True)
work_root = Path(work_base) / arm
cases = json.loads(EVALS.read_text())["evals"]
FIXTURE_ROOT = "/work/auth-demo"


def resolve(text, cwd):
    def skill(m):
        return (plugin / "skills" / m.group(1) / "SKILL.md").read_text()
    text = re.sub(r"__SKILL:([a-z0-9-]+)__", skill, text)
    return text.replace("__PLUGIN_ROOT__", str(plugin)).replace("__FIXTURE_ROOT__", str(cwd)).replace(FIXTURE_ROOT, str(cwd))


for case in cases:
    cid = case["id"]
    if only and cid not in only:
        continue
    out = out_root / cid
    out.mkdir(parents=True, exist_ok=True)
    cwd = work_root / cid / "workspace"
    cwd.mkdir(parents=True)
    alias = "arch-next-" + cid.lower()
    fixture = case["fixture"]
    for rel, text in fixture["files"].items():
        path = cwd / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    for rel in fixture.get("workspace_dirs", []):
        (cwd / rel).mkdir(parents=True, exist_ok=True)
    raw = json.loads(resolve(json.dumps(fixture.get("tool_responses", {})), cwd))
    fx = {"cwd": str(cwd), "alias": alias, "files": fixture["files"], "raw_tool_responses": raw}
    (out / "fixture.json").write_text(json.dumps(fx))
    shim = work_root / cid / "bin"
    shim.mkdir()
    prime = ("# TeaRAGs project context\nproject: " + alias + "\ncwd: " + str(cwd) +
             "\n## Enrichment\ncodegraph.symbols: available\ncodegraph.imports: available\ngit: available\n"
             "Index: healthy, current working tree; all fixture source files indexed.\n")
    (shim / "tea-rags").write_text("#!/bin/sh\ncase \"$1\" in\n  prime) /bin/cat <<'DIGEST'\n" + prime + "DIGEST\n;;\n  *) exit 0;;\nesac\n")
    bd_log = out / "bd-calls.log"
    (shim / "bd").write_text("#!/bin/sh\necho \"$*\" >> '" + str(bd_log) + "'\ncase \" $* \" in\n"
                             "  *--help*|*' -h'*) echo \"usage: bd <command> [flags] (fixture shim)\"; exit 0;;\nesac\n"
                             "case \"$1\" in\n  create) echo \"Created issue: auth-demo-1\";;\n  *) exit 0;;\nesac\n")
    for name in ("tea-rags", "bd"):
        (shim / name).chmod(0o755)
    mcp = {"mcpServers": {"tea-rags": {"command": PY, "args": [str(BASE / "fixture_mcp.py"), "--fixture", str(out / "fixture.json"),
                                                               "--audit", str(out / "fixture-tool-audit.jsonl"), "--plugin-root", str(plugin)]}}}
    (out / "mcp.json").write_text(json.dumps(mcp))
    prompt = "Environment: " + resolve(case["actor_context"], cwd) + "\n\n"
    retained = [dict(m, content=resolve(m["content"], cwd)) for m in fixture.get("initial_context", [])]
    if retained:
        prompt += "Retained session context, in chronological order:\n" + json.dumps(retained, indent=2) + "\n\nCurrent user request:\n"
    prompt += case["prompt"]
    (out / "actor-input.txt").write_text(prompt)
    env = dict(os.environ, PATH=str(shim) + ":" + os.environ["PATH"])
    env.pop("CLAUDE_PROJECT_DIR", None)
    cmd = ["claude", "-p", prompt, "--plugin-dir", str(plugin), "--mcp-config", str(out / "mcp.json"), "--strict-mcp-config",
           "--setting-sources", "project", "--output-format", "stream-json", "--verbose", "--model", "opus",
           "--allowedTools", "mcp__tea-rags__*", "Bash", "Read", "Grep", "Glob", "Skill", "ReadMcpResourceTool", "ListMcpResourcesTool"]
    started = time.monotonic()
    with (out / "stream.jsonl").open("w") as so, (out / "stderr.txt").open("w") as se:
        try:
            rc = subprocess.run(cmd, cwd=cwd, env=env, stdout=so, stderr=se, timeout=900).returncode
        except subprocess.TimeoutExpired:
            rc = "timeout"
    (out / "status.json").write_text(json.dumps({"case": cid, "arm": arm, "rc": rc, "model": "opus",
                                                 "wall_seconds": round(time.monotonic() - started, 1), "plugin": str(plugin)}))
    print("CASE", arm, cid, rc, flush=True)
print("RESULTS", out_root)
