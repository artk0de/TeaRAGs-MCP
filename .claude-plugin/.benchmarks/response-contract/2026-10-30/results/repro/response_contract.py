#!/usr/bin/env python3
"""Private final-answer-contract A/B preparation and explicitly gated native execution."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[1]
spec = importlib.util.spec_from_file_location("routing_helpers", BASE / "run.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
DESIGN = ROOT / ".claude-plugin/.benchmarks/response-contract/2026-10-30"
SELECTED = [("targeted", 1), ("targeted", 2),
            ("batch", "B1-Q34-config-spec"), ("batch", "B2-Q36-known-migrations"),
            ("architecture", 101), ("architecture", 102)]
ARMS = ("control", "candidate")


def load_cases():
    selected, source_hashes = [], {}
    for suite, source in helper.SOURCES:
        raw = json.loads(source.read_text())
        source_hashes[str(source)] = helper.sha(source)
        for case in raw.get("evals", raw.get("cases", [])):
            if (suite, case["id"]) in SELECTED:
                selected.append((suite, case))
    assert len(selected) == 6
    guards_path = DESIGN / "evals.json"
    guards = json.loads(guards_path.read_text())
    source_hashes[str(guards_path)] = helper.sha(guards_path)
    guards = guards.get("evals", guards.get("cases", []))
    assert len(guards) == 2 and {x["id"] for x in guards} == {201, 202}
    return selected + [("response", case) for case in guards], source_hashes


def canonical_bytes(value, meta):
    text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return text.replace(meta["cwd"], "__CASE_CWD__").replace(meta["alias"], "__CASE_ALIAS__").encode()


def actual_rule_injection(meta):
    plugin = Path(meta["plugin"])
    env = helper.native_env(meta["home"], Path(meta["directory"]) / "backend-bin")
    env["PLUGIN_ROOT"] = str(plugin)
    result = subprocess.run(["/bin/bash", str(plugin / "scripts/session-codex-rules.sh")],
        cwd=meta["cwd"], env=env, input=json.dumps({"session_id": "response-contract-no-turn", "cwd": meta["cwd"], "hook_event_name": "SessionStart"}),
        text=True, capture_output=True, timeout=30)
    out = Path(meta["directory"]) / "preflight-no-turn"
    (out / "codex-rules-hook-stdout.json").write_text(result.stdout)
    (out / "codex-rules-hook-stderr.txt").write_text(result.stderr)
    assert result.returncode == 0, result.stderr
    injected = json.loads(result.stdout)["hookSpecificOutput"]["additionalContext"]
    expected = (plugin / "scripts/codex-rules.txt").read_text().rstrip("\n")
    assert injected == expected, "Actual shipped hook did not inject this arm's rules verbatim"
    assert len(injected) <= 9500, "Codex rules injection exceeds 9500 characters"
    proof = {"characters": len(injected), "utf8_bytes": len(injected.encode()),
             "injected_sha256": hashlib.sha256(injected.encode()).hexdigest(), "actual_hook": True, "model_turns": 0}
    helper.dump(out / "codex-rules-injection-proof.json", proof)
    return proof


def prepare():
    for name in ("candidate.txt", "prereg.json", "prereg.md", "evals.json"):
        assert (DESIGN / name).is_file(), "Design is not ready: " + name
    cases, input_hashes = load_cases()
    prereg = json.loads((DESIGN / "prereg.json").read_text())
    assert [suite + "-" + str(case["id"]) for suite, case in cases] == [x["key"] for x in prereg["selected_cases"]]
    for relative, expected in prereg["source_sha256"].items():
        assert helper.sha(ROOT / relative) == expected, "Preregistered source changed: " + relative
    assert helper.sha(DESIGN / "candidate.txt") == prereg["candidate_sha256"]
    study = BASE / "response-contract-runs" / (time.strftime("%Y%m%d-%H%M%S") + "-" + str(time.time_ns() % 1000000000))
    study.mkdir(parents=True)
    shutil.copytree(DESIGN, study / "frozen-design")
    candidate = (study / "frozen-design/candidate.txt").read_bytes()
    assert candidate and len(candidate.decode()) < 9500
    shipped = ROOT / "harness/codex/tea-rags"
    control_inventory = helper.inventory(shipped)
    master = {"ROOTGO": False, "model": "gpt-6.1-sol", "effort": "medium", "plugin_version": "0.53.8",
              "study": "private-final-answer-contract", "source_inputs": input_hashes, "cases": [], "pairs": [], "arms": {},
              "candidate_sha256": hashlib.sha256(candidate).hexdigest(),
              "design_files_sha256": helper.inventory(study / "frozen-design"),
              "helper_sha256": helper.sha(BASE / "run.py"), "runner_sha256": helper.sha(__file__),
              "fixture_server_sha256": helper.sha(BASE / "fixture_mcp.py"),
              "model_turns_prepared": 0, "max_workers": 2, "max_turn_seconds": 180,
              "retry_policy": "One fresh native actor turn per case/arm; no retries or overwrites. Runtime failures remain in raw artifacts.",
              "production_edits": False, "read_delay_ms": 0}
    helper.dump(study / "manifest.json", master)
    for arm in ARMS:
        arm_dir = study / arm
        marketplace = arm_dir / "marketplace"
        snapshot = marketplace / "harness/codex/tea-rags"
        shutil.copytree(shipped, snapshot)
        assert helper.inventory(snapshot) == control_inventory, "Control source changed during freeze"
        if arm == "candidate":
            target = snapshot / "scripts/codex-rules.txt"
            target.write_bytes(target.read_bytes() + candidate)
        inventory = helper.inventory(snapshot)
        diffs = sorted(k for k in set(control_inventory) | set(inventory) if control_inventory.get(k) != inventory.get(k))
        assert diffs == ([] if arm == "control" else ["scripts/codex-rules.txt"]), diffs
        if arm == "candidate":
            assert (snapshot / "scripts/codex-rules.txt").read_bytes() == (shipped / "scripts/codex-rules.txt").read_bytes() + candidate
        assert len((snapshot / "scripts/codex-rules.txt").read_text().rstrip("\n")) <= 9500
        version = json.loads((snapshot / ".codex-plugin/plugin.json").read_text())["version"]
        assert version == "0.53.8"
        catalog = json.loads((ROOT / ".agents/plugins/marketplace.json").read_text())
        catalog["plugins"] = [p for p in catalog["plugins"] if p["name"] == "tea-rags"]
        (marketplace / ".agents/plugins").mkdir(parents=True)
        helper.dump(marketplace / ".agents/plugins/marketplace.json", catalog)
        arm_manifest = {"ROOTGO": False, "model": master["model"], "effort": master["effort"], "plugin_version": version,
                        "source_plugin_sha256": inventory, "cases": [], "fixture_server_sha256": master["fixture_server_sha256"],
                        "runner_sha256": master["helper_sha256"], "arm": arm}
        helper.dump(arm_dir / "manifest.json", arm_manifest)
        for suite, case in cases:
            pair_id = suite + "-" + str(case["id"])
            directory = arm_dir / "cases" / pair_id
            directory.mkdir(parents=True)
            meta = helper.compile_case(suite, case, directory)
            meta.update(pair_id=pair_id, arm=arm)
            helper.install_and_trust(meta, marketplace, version, inventory)
            meta["preflight"] = helper.preflight(meta)
            meta["injection_proof"] = actual_rule_injection(meta)
            meta["config_sha256"] = helper.sha(Path(meta["home"]) / "config.toml")
            actor = json.loads((directory / "actor-input.json").read_text())
            fixture = json.loads((directory / "fixture.json").read_text())
            meta["normalized_actor_sha256"] = hashlib.sha256(canonical_bytes(actor, meta)).hexdigest()
            meta["normalized_fixture_sha256"] = hashlib.sha256(canonical_bytes(fixture, meta)).hexdigest()
            arm_manifest["cases"].append(meta)
            master["cases"].append(meta)
            helper.dump(arm_dir / "manifest.json", arm_manifest)
            helper.dump(study / "manifest.json", master)
            print("PREFLIGHT", arm, pair_id, "trusted+connected+injected+isolated; zero model turns", flush=True)
        master["arms"][arm] = {"plugin_sha256": inventory, "diff_from_control": diffs,
                               "manifest": str(arm_dir / "manifest.json")}
    for suite, case in cases:
        pair_id = suite + "-" + str(case["id"])
        pair = [x for x in master["cases"] if x["pair_id"] == pair_id]
        assert len(pair) == 2
        assert pair[0]["normalized_actor_sha256"] == pair[1]["normalized_actor_sha256"], "Actor input differs across arms"
        assert pair[0]["normalized_fixture_sha256"] == pair[1]["normalized_fixture_sha256"], "Fixture differs across arms"
        master["pairs"].append({"pair_id": pair_id, "normalized_actor_sha256": pair[0]["normalized_actor_sha256"],
                                "normalized_fixture_sha256": pair[0]["normalized_fixture_sha256"]})
    assert helper.inventory(shipped) == control_inventory, "Production plugin changed during preparation"
    master["boundary_ready"] = True
    master["preparation_complete"] = True
    helper.dump(study / "manifest.json", master)
    print("PREPARED_NO_MODEL_TURNS", study, flush=True)


def extract_observed_metrics(directory):
    out = Path(directory) / "actor"
    events_file = out / "events.jsonl"
    events = [json.loads(line) for line in events_file.read_text().splitlines()] if events_file.exists() else []
    responses = {}
    for event in events:
        if event.get("method") == "rawResponse/completed":
            params = event.get("params", {})
            responses[params.get("responseId", str(len(responses)))] = params
    usages = [{"responseId": key, "usage": value.get("usage"), "usageMetadata": value.get("usageMetadata")} for key, value in responses.items()]
    fields = ("inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens")
    totals = {key: sum((x.get("usage") or {}).get(key, 0) for x in usages) for key in fields}
    last_usage = next((e["params"].get("tokenUsage") for e in reversed(events) if e.get("method") == "thread/tokenUsage/updated"), None)
    items = [e.get("params", {}).get("item", {}) for e in events if e.get("method") == "item/completed"]
    tool_types = ("commandExecution", "mcpToolCall", "dynamicToolCall")
    tool_counts = {kind: sum(i.get("type") == kind for i in items) for kind in tool_types}
    wrapper_count = sum(e.get("method") == "rawResponseItem/completed" and e.get("params", {}).get("item", {}).get("type") in ("custom_tool_call", "function_call") for e in events)
    status = json.loads((out / "status.json").read_text()) if (out / "status.json").exists() else {}
    final = ""
    threadfile = out / "thread-read.json"
    if threadfile.exists():
        state = json.loads(threadfile.read_text())
        final_items = [i for t in state.get("thread", {}).get("turns", []) for i in t.get("items", []) if i.get("type") == "agentMessage" and i.get("phase") == "final_answer"]
        final = "\n\n".join(i.get("text", "") for i in final_items)
    (out / "final-answer.txt").write_text(final)
    metrics = {"raw_responses": usages, "raw_response_totals": totals, "last_thread_token_usage": last_usage,
               "wall_seconds": status.get("wall_seconds"), "status": status.get("status"), "native_tool_counts": tool_counts,
               "outer_tool_call_count": wrapper_count, "final_answer_characters": len(final),
               "turn_started_notifications": sum(e.get("method") == "turn/started" for e in events),
               "hook_started_notifications": sum(e.get("method") == "hook/started" for e in events),
               "hook_completed_notifications": sum(e.get("method") == "hook/completed" for e in events),
               "compaction_events": [e for e in events if "compact" in e.get("method", "").lower()]}
    helper.dump(out / "observed-metrics.json", metrics)
    return metrics


def worker(study, arm, key):
    study = Path(study).resolve()
    master = json.loads((study / "manifest.json").read_text())
    assert master.get("ROOTGO") is True and master.get("boundary_ready") is True
    assert helper.sha(BASE / "run.py") == master["helper_sha256"]
    meta = next(x for x in master["cases"] if x["arm"] == arm and x["key"] == key)
    result = helper.worker(study / arm, key)
    extract_observed_metrics(meta["directory"])
    return result


def execute(study, rootgo):
    assert rootgo, "No A/B actors before explicit root review and GO"
    study = Path(study).resolve()
    master = json.loads((study / "manifest.json").read_text())
    assert master.get("boundary_ready") and master.get("preparation_complete") and len(master["cases"]) == 16
    assert helper.inventory(study / "frozen-design") == master["design_files_sha256"], "Frozen prereg/candidate changed"
    assert helper.sha(BASE / "run.py") == master["helper_sha256"]
    assert not any((Path(m["directory"]) / "actor").exists() for m in master["cases"]), "Never repeat an actor attempt"
    master["ROOTGO"] = True
    master["execution_runner_sha256"] = helper.sha(__file__)
    master["rootgo_source"] = "Explicit root GO after review of new preregistration, candidate and A/B byte boundary"
    schedule = []
    for index, pair in enumerate(master["pairs"]):
        order = ARMS if index % 2 == 0 else tuple(reversed(ARMS))
        schedule += [{"arm": arm, "key": pair["pair_id"]} for arm in order]
    master["execution_schedule"] = schedule
    helper.dump(study / "manifest.json", master)
    for arm in ARMS:
        path = study / arm / "manifest.json"
        manifest = json.loads(path.read_text())
        manifest["ROOTGO"] = True
        helper.dump(path, manifest)
    running, exits, index = [], [], 0
    while index < len(schedule) or running:
        while len(running) < 2 and index < len(schedule):
            entry = schedule[index]
            index += 1
            process = subprocess.Popen([helper.PY, str(BASE / "response_contract.py"), "worker", str(study), entry["arm"], entry["key"]])
            running.append((process, entry))
        time.sleep(0.2)
        for process, entry in list(running):
            if process.poll() is not None:
                exits.append(dict(entry, exit_code=process.returncode))
                running.remove((process, entry))
                helper.dump(study / "worker-exits.json", exits)
    print("RESPONSE_CONTRACT_RAW_RESULTS", study, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="action", required=True)
    subs.add_parser("prepare")
    run_parser = subs.add_parser("run")
    run_parser.add_argument("study")
    run_parser.add_argument("--rootgo", action="store_true")
    worker_parser = subs.add_parser("worker")
    worker_parser.add_argument("study")
    worker_parser.add_argument("arm", choices=ARMS)
    worker_parser.add_argument("key")
    args = parser.parse_args()
    if args.action == "prepare":
        prepare()
    elif args.action == "run":
        execute(args.study, args.rootgo)
    else:
        sys.exit(worker(args.study, args.arm, args.key))
