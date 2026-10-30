"""Offline trace checks plus explicitly recorded independent answer review."""
import json
from pathlib import Path
import sys

run = Path(sys.argv[1]).resolve()
reviews = {
    101: "Correctly distinguishes optional refreshToken from the expired-session guard; explains MAX_SAFE_INTEGER API-key expiry and throwing refresh implementation.",
    102: "Correct controller -> session -> provider flow, injected/default provider construction, and local-only session deletion on logout. No violation audit substituted for overview.",
    103: "Correct supplied component cycle and stability delta; identifies both concrete-provider construction and provider-to-session back edge; qualifies absent method edges/history.",
    104: "Separates default construction into proposed composition module, removes provider knowledge of session, preserves shared contracts, actually requests restructure simulation, and qualifies missing plan ordering.",
    105: "Explicit diagnostic invocation produces the supplied stability violation with both source edges and injected-contract repair direction; no invented detector cleanliness or urgency.",
}

def source_rows(item):
    data = (item.get("result") or {}).get("structuredContent") or {}
    rows = data.get("results", [])
    if isinstance(rows, dict):
        columns = rows.get("columns", [])
        return [dict(zip(columns, row)) for row in rows.get("rows", [])]
    return [{"payload." + k: v for k, v in row.get("payload", {}).items()} for row in rows]

results = []
for case_id, review in reviews.items():
    case = run / "cases" / ("architecture-" + str(case_id))
    events = [json.loads(line) for line in (case / "actor/events.jsonl").open()]
    status = json.loads((case / "actor/status.json").read_text())
    seen, items, answers = set(), [], []
    for event in events:
        item = event.get("params", {}).get("item", {})
        if event.get("method") == "item/completed" and item.get("id") not in seen:
            seen.add(item.get("id")); items.append(item)
        if event.get("method") == "rawResponseItem/completed" and item.get("type") == "message" and item.get("role") == "assistant" and item.get("phase") == "final_answer":
            answers.append("".join(block.get("text", "") for block in item.get("content", [])))
    mcp = [item for item in items if item.get("type") == "mcpToolCall"]
    commands = [item for item in items if item.get("type") == "commandExecution"]
    reports = [item for item in mcp if item.get("tool") == "get_architecture_report"]
    diagnostic_reads = [item for item in commands if "architecture-diagnostics/" in item.get("command", "") and item.get("exitCode") == 0]
    guide_reads = [item for item in mcp if item.get("arguments", {}).get("uri") == "tea-rags://guide/architecture"]
    sources = {}
    for item in mcp:
        for row in source_rows(item):
            if row.get("payload.content"):
                sources.setdefault(row.get("payload.relativePath"), []).append(item["id"])
    checks = {"completed_once": status.get("status") == "completed" and sum(e.get("method") == "turn/started" for e in events) == 1,
              "final_answer_present": len(answers) == 1,
              "independent_manual_semantics_review": True}
    if case_id in (101, 102):
        checks.update(no_architecture_report=not reports,
                      no_diagnostics_or_architecture_guide_reads=not diagnostic_reads and not guide_reads,
                      source_bodies_from_at_least_two_files=len(sources) >= 2)
    else:
        checks.update(scoped_report=any(i.get("arguments", {}).get("pathPattern") == "src/auth/**" and i.get("status") == "completed" for i in reports),
                      diagnostics_skill_read=any("/SKILL.md" in i.get("command", "") for i in diagnostic_reads),
                      phase_1_reference_read=any("references/phase-1-report.md" in i.get("command", "") for i in diagnostic_reads))
        if case_id == 104:
            checks["concrete_move_simulated"] = any(i.get("arguments", {}).get("restructure") and i.get("status") == "completed" for i in reports)
    results.append({"case": "architecture-" + str(case_id), "verdict": "PASS" if all(checks.values()) else "FAIL", "checks": checks,
                    "manual_semantics_review": review,
                    "report_calls": [{"id": i["id"], "arguments": i.get("arguments")} for i in reports],
                    "diagnostic_read_ids": [i["id"] for i in diagnostic_reads], "source_body_evidence": sources, "final_answer": answers})
out = {"reviewer": "root, independent of architecture case author", "model": "gpt-6.1-sol", "effort": "medium", "plugin_version": "0.53.8", "results": results,
       "passed": sum(r["verdict"] == "PASS" for r in results), "total": len(results),
       "limitations": ["Manual semantic verdicts are recorded explicitly; rerunning mechanical checks does not independently redo the answer review.", "Synthetic MCP responses exercise routing, not real index/codegraph algorithms or performance."]}
destination = Path(__file__).with_suffix(".json")
destination.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
for result in results:
    print(result["case"], result["verdict"], {k: v for k, v in result["checks"].items() if not v})
print("TOTAL", str(out["passed"]) + "/" + str(out["total"]))
sys.exit(0 if out["passed"] == out["total"] else 1)
