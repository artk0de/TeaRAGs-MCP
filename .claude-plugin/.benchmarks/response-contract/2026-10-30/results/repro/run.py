#!/usr/bin/env python3
"""Prepare isolated native-plugin routing cases; one explicitly authorized turn per case."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("routing_rpc", ROOT / ".tmp/codex61_app_rpc.py")
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)
PY = str(Path("/opt/homebrew/bin/python3").resolve())
NODE, CODEX, RG = transport.NODE, transport.CODEX, transport.RG
SOURCES = [
    ("targeted", ROOT / ".claude-plugin/.benchmarks/explore/evals/2026-10-30-targeted-context-reads.json"),
    ("batch", ROOT / ".claude-plugin/.benchmarks/search-cascade/evals/2026-10-30-independent-read-batches.json"),
    ("architecture", ROOT / ".claude-plugin/.benchmarks/architecture-diagnostics/evals/2026-10-30-explicit-activation.json"),
]


def dump(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def inventory(path):
    return {str(p.relative_to(path)): sha(p) for p in sorted(Path(path).rglob("*")) if p.is_file() and not p.is_symlink()}


def replace_raw(value, cwd, alias, old_alias="context-read-fixture"):
    if isinstance(value, str):
        return value.replace("__FIXTURE_ROOT__", cwd).replace("/workspace/context-read-fixture", cwd).replace("/work/auth-demo", cwd).replace(old_alias, alias)
    if isinstance(value, list):
        return [replace_raw(x, cwd, alias, old_alias) for x in value]
    if isinstance(value, dict):
        return {replace_raw(k, cwd, alias, old_alias): replace_raw(v, cwd, alias, old_alias) for k, v in value.items()}
    return value


def compile_case(suite, case, directory):
    cwd, home = directory / "workspace", directory / "home"
    cwd.mkdir(parents=True)
    alias = "routing-" + suite + "-" + str(case["id"]).lower()
    actor = case.get("actor", {})
    prompt = case.get("prompt", actor.get("prompt"))
    context = case.get("actor_context", "")
    old_alias = actor.get("project", context.get("project", "context-read-fixture") if isinstance(context, dict) else "auth-demo")
    fixture = replace_raw(case.get("fixture", {}), str(cwd), alias, old_alias)
    files = fixture.get("files", {})
    for relative, text in files.items():
        path = cwd / relative
        assert path.resolve().is_relative_to(cwd), relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    tool_responses = fixture.get("tool_responses", {})
    raw = replace_raw(case.get("tool_fixtures", tool_responses), str(cwd), alias, old_alias)
    bodies = dict(fixture.get("find_symbol_bodies", {}))
    for item in raw if isinstance(raw, list) else []:
        if item.get("tool") == "find_symbol" and item.get("symbol"):
            for row in item.get("result", {}).get("results", []):
                if isinstance(row, dict) and row.get("payload", {}).get("content"):
                    bodies[item["symbol"]] = row["payload"]
    compiled = {"cwd": str(cwd), "alias": alias, "files": files, "raw_tool_responses": raw,
                "find_symbol_bodies": bodies,
                "architecture_report": tool_responses.get("get_architecture_report", {}),
                "metrics": tool_responses.get("resolve_metrics", {"signals": {}, "labelMap": {}, "codegraphEnabled": True, "built": True, "resolvedRate": 1.0})}
    dump(directory / "fixture.json", compiled)
    # Actor input is assembled exclusively from raw retained facts and the request.
    if isinstance(context, dict):
        retained = context.get("messages", [])
    else:
        retained = ([{"role": "workspace_context", "content": context}] if context else []) + fixture.get("initial_context", [])
    retained = replace_raw(retained, str(cwd), alias, old_alias)
    text = ""
    if retained:
        text += "Retained session context, in chronological order:\n" + json.dumps(retained, ensure_ascii=False, indent=2) + "\n\n"
    text += "Current user request:\n" + replace_raw(prompt, str(cwd), alias, old_alias)
    actor_input = {"cwd": str(cwd), "project": alias, "text": text}
    dump(directory / "actor-input.json", actor_input)
    return {"key": suite + "-" + str(case["id"]), "suite": suite, "id": case["id"],
            "directory": str(directory), "cwd": str(cwd), "home": str(home), "alias": alias,
            "actor_input_sha256": sha(directory / "actor-input.json"), "fixture_sha256": sha(directory / "fixture.json")}


def native_env(home, shim):
    return {"PATH": str(shim) + ":" + str(Path(NODE).parent) + ":/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": "/Users/artk0re", "CODEX_HOME": str(home), "ASDF_NODEJS_VERSION": "24.15.0", "LANG": "en_US.UTF-8"}


def write_config(meta, plugin, toolbin):
    home, cwd = Path(meta["home"]), meta["cwd"]
    home.mkdir(parents=True)
    (home / "auth.json").symlink_to("/Users/artk0re/.codex/auth.json")
    pyframework = next(p for p in Path(PY).parents if p.name == "Python.framework")
    roots = [cwd, str(plugin), CODEX, NODE, RG, str(Path(RG).resolve()), PY, str(pyframework),
             "/opt/homebrew/opt/pcre2", str(Path("/opt/homebrew/opt/pcre2").resolve()), str(toolbin)]
    path = ":".join([str(toolbin), str(Path(PY).parent), str(Path(RG).parent), str(Path(NODE).parent), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
    text = '''model = "gpt-6.1-sol"
model_reasoning_effort = "medium"
approval_policy = "never"
default_permissions = "routing_eval"
allow_login_shell = false
web_search = "disabled"
project_doc_max_bytes = 0

[features]
apps = false
browser_use = false
browser_use_external = false
in_app_browser = false
computer_use = false
image_generation = false
view_image = false
multi_agent = false
memories = false
shell_snapshot = false
skip_host_skill_discovery = true
remote_plugin = false
plugin_sharing = false
plugin_discovery_prefetch = false
skill_search = false
skill_mcp_dependency_install = false
plugins = true
hooks = true
'''
    text += "\n[projects." + json.dumps(cwd) + "]\ntrust_level = \"trusted\"\n"
    text += "\n[shell_environment_policy]\ninherit = \"none\"\nset = " + "{ " + ", ".join(k + " = " + json.dumps(v) for k, v in {
        "PATH": path, "HOME": "/nonexistent", "TMPDIR": "/nonexistent", "LANG": "en_US.UTF-8", "ASDF_NODEJS_VERSION": "24.15.0"}.items()) + " }\n"
    text += '\n[permissions.routing_eval.filesystem]\n":root" = "deny"\n":minimal" = "read"\n":slash_tmp" = "deny"\n":tmpdir" = "deny"\n'
    text += "".join(json.dumps(p) + ' = "read"\n' for p in dict.fromkeys(roots))
    text += '\n[permissions.routing_eval.network]\nenabled = false\n'
    for name in ["imagegen", "openai-docs", "review-agent", "skill-creator", "skill-installer"]:
        text += '\n[[skills.config]]\npath = ' + json.dumps(str(home / "skills/.system" / name / "SKILL.md")) + '\nenabled = false\n'
    (home / "config.toml").write_text(text)


def write_shims(meta, plugin):
    directory = Path(meta["directory"])
    shim = directory / "backend-bin"
    shim.mkdir()
    prime = "# TeaRAGs project context\nproject: " + meta["alias"] + "\ncwd: " + meta["cwd"] + "\n## Enrichment\ncodegraph.symbols: available\ncodegraph.imports: available\nIndex: healthy, current working tree; all fixture source files indexed.\n"
    command = [PY, str(BASE / "fixture_mcp.py"), "--fixture", str(directory / "fixture.json"), "--audit", str(directory / "fixture-tool-audit.jsonl"), "--plugin-root", str(plugin)]
    import shlex
    script = "#!/bin/sh\ncase \"$1\" in\n  server) exec " + shlex.join(command) + ";;\n  prime) /bin/cat <<'DIGEST'\n" + prime + "DIGEST\n;;\n  *) exit 2;;\nesac\n"
    (shim / "tea-rags").write_text(script)
    (shim / "tea-rags").chmod(0o755)
    toolbin = directory / "read-tools"
    toolbin.mkdir()
    return shim, toolbin


def rpc_for(meta, logdir, allow=False):
    transport.REPO = meta["cwd"]
    rpc = transport.RPC(meta["home"], logdir, extra_env=native_env(meta["home"], Path(meta["directory"]) / "backend-bin"), allow_model_turns=allow)
    original_next = rpc.next
    timeline = (Path(logdir) / "received-timeline.jsonl").open("w")
    def observed_next(timeout=180):
        event = original_next(timeout)
        timeline.write(json.dumps({"received_ns": time.time_ns(), "monotonic_ns": time.monotonic_ns(), "event": event}, ensure_ascii=False) + "\n")
        timeline.flush()
        return event
    rpc.next = observed_next
    rpc.timeline = timeline
    return rpc


def close_rpc(rpc):
    try:
        rpc.close()
    finally:
        rpc.timeline.close()


def install_and_trust(meta, marketplace, version, source_inventory):
    directory = Path(meta["directory"])
    plugin = Path(meta["home"]) / "plugins/cache/tea-rags/tea-rags" / version
    shim, toolbin = write_shims(meta, plugin)
    write_config(meta, plugin, toolbin)
    env = native_env(meta["home"], shim)
    installs = []
    for command in [[CODEX, "plugin", "marketplace", "add", str(marketplace), "--json"], [CODEX, "plugin", "add", "tea-rags@tea-rags", "--json"]]:
        result = subprocess.run(command, cwd=meta["cwd"], env=env, capture_output=True, text=True, timeout=120)
        installs.append({"command": command, "returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
        dump(directory / "native-install.json", installs)
        assert result.returncode == 0, result.stderr
    assert inventory(plugin) == source_inventory, "Installed plugin differs from shipped snapshot"
    meta["plugin"] = str(plugin)
    rpc = rpc_for(meta, directory / "trust-no-turn")
    try:
        response = rpc.call("hooks/list", {"cwds": [meta["cwd"]]})
        dump(directory / "hooks-before-trust.json", response)
    finally:
        close_rpc(rpc)
    hooks = [hook for row in response["data"] for hook in row["hooks"]]
    assert hooks and all(h.get("pluginId") == "tea-rags@tea-rags" for h in hooks)
    with (Path(meta["home"]) / "config.toml").open("a") as out:
        for hook in hooks:
            out.write("\n[hooks.state." + json.dumps(hook["key"]) + "]\ntrusted_hash = " + json.dumps(hook["currentHash"].split("/sha256:")[0]) + "\n")


def preflight(meta):
    directory = Path(meta["directory"])
    out = directory / "preflight-no-turn"
    rpc = rpc_for(meta, out)
    try:
        thread = rpc.call("thread/start", {"cwd": meta["cwd"], "model": "gpt-6.1-sol", "permissions": "routing_eval", "approvalPolicy": "never", "ephemeral": True, "experimentalRawEvents": True})
        tid = thread["thread"]["id"]
        dump(out / "thread-start.json", thread)
        assert thread["activePermissionProfile"]["id"] == "routing_eval"
        assert thread["model"] == "gpt-6.1-sol" and thread.get("reasoningEffort") == "medium"
        assert not thread.get("instructionSources"), "Unexpected host/project instructions"
        hooks = rpc.call("hooks/list", {"threadId": tid, "cwds": []})
        dump(out / "hooks.json", hooks)
        flat = [h for row in hooks["data"] for h in row["hooks"]]
        assert flat and all(h["trustStatus"] == "trusted" for h in flat), "Untrusted hooks"
        skills = rpc.call("skills/list", {"cwds": [meta["cwd"]], "forceReload": True})
        dump(out / "skills.json", skills)
        enabled = [s for row in skills["data"] for s in row["skills"] if s.get("enabled")]
        assert enabled and all(s.get("pluginId") == "tea-rags@tea-rags" for s in enabled), "Unexpected skill discovery"
        deadline = time.monotonic() + 90
        while True:
            status = rpc.call("mcpServerStatus/list", {"threadId": tid, "limit": 100})
            if not any(x.get("runtimeStatus") == "starting" for x in status["data"]):
                break
            assert time.monotonic() < deadline, "MCP connection timeout"
            time.sleep(0.2)
        dump(out / "mcp.json", status)
        assert len(status["data"]) == 1 and status["data"][0]["name"] == "tea-rags" and status["data"][0]["runtimeStatus"] == "connected", status
        protected = [str(ROOT / "package.json"), str(BASE / "run.py"), str(BASE / "fixture_mcp.py"), str(SOURCES[0][1]), str(directory / "fixture.json"), str(directory / "actor-input.json"), str(Path(meta["home"]) / "auth.json"), "/Users/artk0re/.codex/auth.json"]
        probe = "paths=" + repr(protected) + "\nfor p in paths:\n try:\n  f=open(p,\"rb\"); f.read(1); f.close(); print(\"ALLOWED\")\n except OSError as e: print(\"DENIED\",e.errno)\n"
        result = rpc.call("command/exec", {"command": [PY, "-c", probe], "cwd": meta["cwd"], "permissionProfile": "routing_eval", "timeoutMs": 10000})
        dump(out / "filesystem-denials.json", result)
        assert result["stdout"].count("DENIED 1") == len(protected), result
        readprobe = "from pathlib import Path\np=Path(" + repr(meta["cwd"]) + ")\nprint(\"WORKSPACE\",p.is_dir())\nprint(\"PLUGIN\",Path(" + repr(str(Path(meta["plugin"]) / "skills/explore/SKILL.md")) + ").is_file())"
        allowed = rpc.call("command/exec", {"command": [PY, "-c", readprobe], "cwd": meta["cwd"], "permissionProfile": "routing_eval", "timeoutMs": 10000})
        dump(out / "filesystem-allowed.json", allowed)
        assert "WORKSPACE True" in allowed["stdout"] and "PLUGIN True" in allowed["stdout"], allowed
        summary = {"ready": True, "model_turns": 0, "trusted_hooks": len(flat), "enabled_skills": len(enabled), "mcp": "connected", "denied_paths": len(protected)}
        dump(directory / "preflight.json", summary)
        return summary
    finally:
        close_rpc(rpc)


def prepare():
    run = BASE / "runs" / (time.strftime("%Y%m%d-%H%M%S") + "-" + str(time.time_ns() % 1000000000))
    run.mkdir(parents=True)
    marketplace = run / "marketplace"
    shipped = ROOT / "harness/codex/tea-rags"
    snapshot = marketplace / "harness/codex/tea-rags"
    shutil.copytree(shipped, snapshot)
    catalog = json.loads((ROOT / ".agents/plugins/marketplace.json").read_text())
    catalog["plugins"] = [p for p in catalog["plugins"] if p["name"] == "tea-rags"]
    (marketplace / ".agents/plugins").mkdir(parents=True)
    dump(marketplace / ".agents/plugins/marketplace.json", catalog)
    version = json.loads((snapshot / ".codex-plugin/plugin.json").read_text())["version"]
    assert version == "0.53.8", version
    source_inventory = inventory(shipped)
    assert inventory(snapshot) == source_inventory
    manifest = {"ROOTGO": False, "model": "gpt-6.1-sol", "effort": "medium", "plugin_version": version,
                "source_plugin_sha256": source_inventory, "source_inputs": {}, "cases": [], "read_delay_ms": 0,
                "transport_sha256": sha(ROOT / ".tmp/codex61_app_rpc.py"), "runner_sha256": sha(__file__), "fixture_server_sha256": sha(BASE / "fixture_mcp.py"),
                "actor_boundary": "Native managed routing_eval filesystem/network profile. Backend-only auth symlink. No grader/controller/source repository read access. Prompts sent through JSON-RPC stdin."}
    dump(run / "manifest.json", manifest)
    for suite, source in SOURCES:
        raw = json.loads(source.read_text())
        manifest["source_inputs"][str(source)] = sha(source)
        for case in raw.get("evals", raw.get("cases", [])):
            directory = run / "cases" / (suite + "-" + str(case["id"]))
            directory.mkdir(parents=True)
            meta = compile_case(suite, case, directory)
            install_and_trust(meta, marketplace, version, source_inventory)
            meta["preflight"] = preflight(meta)
            meta["config_sha256"] = sha(Path(meta["home"]) / "config.toml")
            manifest["cases"].append(meta)
            dump(run / "manifest.json", manifest)
            print("PREFLIGHT", meta["key"], "trusted+connected+isolated; zero model turns", flush=True)
    print("PREPARED", run, flush=True)


def worker(run, key):
    run = Path(run).resolve()
    manifest = json.loads((run / "manifest.json").read_text())
    assert manifest.get("ROOTGO") is True, "Explicit ROOTGO required"
    meta = next(m for m in manifest["cases"] if m["key"] == key)
    directory = Path(meta["directory"])
    out = directory / "actor"
    out.mkdir()  # Never overwrite or retry an actor attempt.
    assert sha(directory / "actor-input.json") == meta["actor_input_sha256"]
    assert sha(directory / "fixture.json") == meta["fixture_sha256"]
    assert sha(Path(meta["home"]) / "config.toml") == meta["config_sha256"]
    assert inventory(Path(meta["plugin"])) == manifest["source_plugin_sha256"]
    assert sha(BASE / "fixture_mcp.py") == manifest["fixture_server_sha256"]
    actor = json.loads((directory / "actor-input.json").read_text())
    rpc = rpc_for(meta, out, allow=True)
    started = time.monotonic()
    status = {"key": key, "model": "gpt-6.1-sol", "effort": "medium", "actor_input_sha256": meta["actor_input_sha256"], "attempt": 1, "valid": False}
    try:
        thread = rpc.call("thread/start", {"cwd": meta["cwd"], "model": "gpt-6.1-sol", "permissions": "routing_eval", "approvalPolicy": "never", "ephemeral": False, "experimentalRawEvents": True})
        tid = thread["thread"]["id"]
        status["thread_id"] = tid
        dump(out / "thread-start.json", thread)
        assert thread["activePermissionProfile"]["id"] == "routing_eval" and not thread.get("instructionSources")
        assert thread["model"] == "gpt-6.1-sol" and thread.get("reasoningEffort") == "medium"
        turn = rpc.call("turn/start", {"threadId": tid, "cwd": meta["cwd"], "permissions": "routing_eval", "approvalPolicy": "never", "model": "gpt-6.1-sol", "effort": "medium", "input": [{"type": "text", "text": actor["text"]}]})
        turn_id = turn["turn"]["id"]
        status["turn_id"] = turn_id
        events, rpc.pending = rpc.pending, []
        deadline = time.monotonic() + 180
        completed = None
        while time.monotonic() < deadline:
            completed = next((e for e in events if e.get("method") == "turn/completed" and e.get("params", {}).get("turn", {}).get("id") == turn_id), None)
            if completed:
                break
            try:
                events.append(rpc.next(timeout=min(30, max(1, deadline - time.monotonic()))))
            except queue.Empty:
                pass
        if completed is None:
            rpc.call("turn/interrupt", {"threadId": tid, "turnId": turn_id}, timeout=10)
            raise TimeoutError("180-second actor deadline; no retry")
        dump(out / "turn-events.json", events)
        thread_state = rpc.call("thread/read", {"threadId": tid, "includeTurns": True})
        dump(out / "thread-read.json", thread_state)
        status["status"] = completed["params"]["turn"]["status"]
        status["valid"] = status["status"] == "completed"
    except BaseException as error:
        status["error"] = str(error)
        status.setdefault("status", "runtime_error")
    finally:
        status["wall_seconds"] = round(time.monotonic() - started, 3)
        dump(out / "status.json", status)
        close_rpc(rpc)
    print("CASE", key, status["status"], status["wall_seconds"], "seconds", flush=True)
    return 0 if status["valid"] else 1


def execute(run, rootgo):
    assert rootgo, "Use --rootgo only after explicit root authorization"
    run = Path(run).resolve()
    manifest = json.loads((run / "manifest.json").read_text())
    assert all(m["preflight"]["ready"] for m in manifest["cases"])
    assert not any((Path(m["directory"]) / "actor").exists() for m in manifest["cases"]), "No case retries or overwrites"
    manifest["ROOTGO"] = True
    manifest["execution_runner_sha256"] = sha(__file__)
    manifest["rootgo_source"] = "Explicit parent instruction authorizing these 13 current-plugin eval cases only"
    dump(run / "manifest.json", manifest)
    pending = iter(manifest["cases"])
    running, exits = [], []
    while True:
        while len(running) < 2:
            try:
                meta = next(pending)
            except StopIteration:
                break
            process = subprocess.Popen([PY, str(BASE / "run.py"), "worker", str(run), meta["key"]])
            running.append((process, meta))
        if not running:
            break
        time.sleep(0.2)
        for process, meta in list(running):
            if process.poll() is not None:
                exits.append({"key": meta["key"], "exit_code": process.returncode})
                running.remove((process, meta))
                dump(run / "worker-exits.json", exits)
    print("RESULTS", run, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="action", required=True)
    subs.add_parser("prepare")
    run_parser = subs.add_parser("run")
    run_parser.add_argument("run")
    run_parser.add_argument("--rootgo", action="store_true")
    work_parser = subs.add_parser("worker")
    work_parser.add_argument("run")
    work_parser.add_argument("key")
    args = parser.parse_args()
    if args.action == "prepare":
        prepare()
    elif args.action == "run":
        execute(args.run, args.rootgo)
    else:
        sys.exit(worker(args.run, args.key))
