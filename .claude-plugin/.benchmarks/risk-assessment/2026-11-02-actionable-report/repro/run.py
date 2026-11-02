#!/usr/bin/env python3
"""One Claude Code actor session per case and arm (adapted from search-cascade/2026-10-31-4mffb/repro/claude_run.py).

Changes vs the original: suite path; fixture.git_history replayed as a real git
repo (+ optional origin); PATH shims for tea-rags (prime + resource label maps),
bd and gh (both log every call); Skill added to --allowedTools so the plugin
skill can load; cases run in a small thread pool; 900 s timeout.

usage: run.py <arm: baseline|current> <baseline-plugin-dir> <out-root> <work-root> [CASE,CASE]
"""
import json, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[4]
sys.path.insert(0, str(BASE))
from build_suite import build_repo  # noqa: E402

EVALS = ROOT / ".claude-plugin/.benchmarks/risk-assessment/evals/2026-11-02-actionable-report.json"
PY = "/opt/homebrew/bin/python3"
arm, baseline_dir, out_root, work_root = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4])
only = [x for x in (sys.argv[5].split(",") if len(sys.argv) > 5 else []) if x]
plugin = baseline_dir if arm == "baseline" else ROOT / ".claude-plugin/tea-rags"
cases = json.loads(EVALS.read_text())["evals"]


def run_case(case):
    cid = case["id"]
    out = out_root / arm / cid
    out.mkdir(parents=True)
    cwd = work_root / arm / cid / "workspace"
    cwd.mkdir(parents=True)
    fixture = case["fixture"]
    alias = "widgets-" + arm + "-" + cid.lower()
    history = [(c["date"], tuple(c["author"]), c["subject"], c["files"]) for c in fixture["git_history"]]
    shas = build_repo(cwd, history, fixture.get("git_remote"))
    for rel, text in fixture["files"].items():  # untracked extras (e.g. .beads/) on top of the history
        path = cwd / rel
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
    fx = {"cwd": str(cwd), "alias": alias, "files": fixture["files"],
          "raw_tool_responses": fixture["raw_tool_responses"], "metrics": fixture["label_maps"]}
    (out / "fixture.json").write_text(json.dumps(fx))
    (out / "shas.json").write_text(json.dumps(shas, indent=1))
    shim = work_root / arm / cid / "bin"
    shim.mkdir()
    log = out / "shim-calls.log"
    prime = ("# TeaRAGs project context\nproject: " + alias + "\ncwd: " + str(cwd) + "\n## Enrichment\n"
             + fixture.get("prime_extra", "") + "git: available\nIndex: healthy, current working tree; all fixture source files indexed.\n")
    (shim / "tea-rags").write_text(
        "#!/bin/sh\necho \"tea-rags $*\" >> '" + str(log) + "'\ncase \"$1\" in\n"
        "  prime) /bin/cat <<'DIGEST'\n" + prime + "DIGEST\n;;\n"
        "  resource) /bin/cat <<'LABELS'\n" + fixture["label_maps"] + "LABELS\n;;\n  *) exit 0;;\nesac\n")
    (shim / "bd").write_text("#!/bin/sh\necho \"bd $*\" >> '" + str(log) + "'\n"
                             "case \"$1\" in\n  create) echo 'Created issue: widgets-1';;\n  *) echo '[]';;\nesac\n")
    (shim / "gh").write_text("#!/bin/sh\necho \"gh $*\" >> '" + str(log) + "'\nexit 0\n")
    for name in ("tea-rags", "bd", "gh"):
        (shim / name).chmod(0o755)
    mcp = {"mcpServers": {"tea-rags": {"command": PY, "args": [str(BASE / "fixture_mcp.py"), "--fixture", str(out / "fixture.json"),
                                                               "--audit", str(out / "fixture-tool-audit.jsonl"), "--plugin-root", str(plugin)]}}}
    (out / "mcp.json").write_text(json.dumps(mcp))
    skill_dir = plugin / "skills/risk-assessment"
    skill_text = ("Launching skill: tea-rags:risk-assessment\nBase directory for this skill: " + str(skill_dir) + "\n\n"
                  + (skill_dir / "SKILL.md").read_text())
    retained = [dict(m, content=m["content"].replace("__SKILL_TEXT:risk-assessment__", skill_text))
                for m in fixture.get("initial_context", [])]
    text = ""
    if retained:
        text = "Retained session context, in chronological order:\n" + json.dumps(retained, indent=2, ensure_ascii=False) + "\n\nCurrent user request:\n"
    text += case["prompt"]
    (out / "actor-input.txt").write_text(text)
    env = dict(os.environ, PATH=str(shim) + ":" + os.environ["PATH"], CLAUDE_PROJECT_DIR=str(cwd))
    cmd = ["claude", "-p", text, "--plugin-dir", str(plugin), "--mcp-config", str(out / "mcp.json"), "--strict-mcp-config",
           "--setting-sources", "project", "--output-format", "stream-json", "--verbose", "--model", "opus",
           "--allowedTools", "mcp__tea-rags__*", "Bash", "Read", "Grep", "Glob", "Skill", "ReadMcpResourceTool", "ListMcpResourcesTool"]
    started = time.monotonic()
    rc = None
    with (out / "stream.jsonl").open("w") as so, (out / "stderr.txt").open("w") as se:
        try:
            rc = subprocess.run(cmd, cwd=cwd, env=env, stdout=so, stderr=se, timeout=900).returncode
        except subprocess.TimeoutExpired:
            rc = "timeout"
    status = {"case": cid, "arm": arm, "rc": rc, "wall_seconds": round(time.monotonic() - started, 1), "plugin": str(plugin),
              "workspace": str(cwd)}
    (out / "status.json").write_text(json.dumps(status))
    print("CASE", arm, cid, rc, status["wall_seconds"], flush=True)


with ThreadPoolExecutor(max_workers=int(os.environ.get("RISK_EVAL_WORKERS", "5"))) as pool:
    list(pool.map(run_case, [c for c in cases if not only or c["id"] in only]))
print("RESULTS", out_root / arm)
