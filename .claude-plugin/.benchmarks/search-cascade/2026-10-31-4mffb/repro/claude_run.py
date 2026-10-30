#!/usr/bin/env python3
"""One Claude Code actor session per case and arm, plugin loaded via --plugin-dir, fixture MCP via --mcp-config."""
import json, os, shutil, subprocess, sys, time
from pathlib import Path

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[1]
EVALS = ROOT / ".claude-plugin/.benchmarks/search-cascade/evals/2026-10-31-migration-history-class-contract.json"
PY = "/opt/homebrew/bin/python3"
arm = sys.argv[1]
only = [x for x in (sys.argv[2].split(",") if len(sys.argv) > 2 else []) if x]
plugin = BASE / "baseline-claude-tea-rags" if arm == "baseline" else ROOT / ".claude-plugin/tea-rags"
out_root = BASE / "claude-runs" / (arm + "-" + time.strftime("%Y%m%d-%H%M%S"))
out_root.mkdir(parents=True)
work_root = Path("/tmp/4mffb-claude") / out_root.name
cases = json.loads(EVALS.read_text())["cases"]
for case in cases:
    if only and case["id"] not in only:
        continue
    cid = case["id"]
    out = out_root / cid
    out.mkdir()
    cwd = work_root / cid / "workspace"
    cwd.mkdir(parents=True)
    alias = "routing-claude-" + cid.lower()
    old = case["actor"]["project"]
    for rel, text in case["fixture"]["files"].items():
        path = cwd / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    fx = {"cwd": str(cwd), "alias": alias, "files": case["fixture"]["files"]}
    (out / "fixture.json").write_text(json.dumps(fx))
    shim = work_root / cid / "bin"
    shim.mkdir()
    prime = "# TeaRAGs project context\nproject: " + alias + "\ncwd: " + str(cwd) + "\n## Enrichment\ncodegraph.symbols: available\ncodegraph.imports: available\nIndex: healthy, current working tree; all fixture source files indexed.\n"
    (shim / "tea-rags").write_text("#!/bin/sh\ncase \"$1\" in\n  prime) /bin/cat <<'DIGEST'\n" + prime + "DIGEST\n;;\n  *) exit 0;;\nesac\n")
    (shim / "tea-rags").chmod(0o755)
    mcp = {"mcpServers": {"tea-rags": {"command": PY, "args": [str(BASE / "fixture_mcp.py"), "--fixture", str(out / "fixture.json"),
                                                               "--audit", str(out / "fixture-tool-audit.jsonl"), "--plugin-root", str(plugin)]}}}
    (out / "mcp.json").write_text(json.dumps(mcp))
    retained = [dict(m, content=m["content"].replace("__FIXTURE_ROOT__", str(cwd)).replace(old, alias)) for m in case["fixture"].get("initial_context", [])]
    text = "Retained session context, in chronological order:\n" + json.dumps(retained, indent=2) + "\n\nCurrent user request:\n" + case["actor"]["prompt"]
    (out / "actor-input.txt").write_text(text)
    env = dict(os.environ, PATH=str(shim) + ":" + os.environ["PATH"])
    env.pop("CLAUDE_PROJECT_DIR", None)
    cmd = ["claude", "-p", text, "--plugin-dir", str(plugin), "--mcp-config", str(out / "mcp.json"), "--strict-mcp-config",
           "--setting-sources", "project", "--output-format", "stream-json", "--verbose", "--model", "opus",
           "--allowedTools", "mcp__tea-rags__*", "Bash", "Read", "Grep", "Glob", "ReadMcpResourceTool", "ListMcpResourcesTool"]
    started = time.monotonic()
    with (out / "stream.jsonl").open("w") as so, (out / "stderr.txt").open("w") as se:
        rc = subprocess.run(cmd, cwd=cwd, env=env, stdout=so, stderr=se, timeout=600).returncode
    (out / "status.json").write_text(json.dumps({"case": cid, "arm": arm, "rc": rc, "wall_seconds": round(time.monotonic() - started, 1), "plugin": str(plugin)}))
    print("CASE", cid, rc, flush=True)
print("RESULTS", out_root)
