#!/usr/bin/env python3
"""Grade risk-assessment actionable-report transcripts against each case's `grading` checks.

Reads stream.jsonl (tool calls + answer), shim-calls.log (bd/gh/tea-rags), shas.json
(the run workspace's own commit SHAs) and the suite's picks/spans. Prints one JSON
line per check; writes grades.json into each case dir.

usage: grade.py <runs-root> [arm ...]
"""
import json, re, sys
from collections import OrderedDict
from pathlib import Path

BASE = Path(__file__).resolve().parent
SUITE = json.loads((BASE.parents[1] / "evals/2026-11-02-actionable-report.json").read_text())
PICKS, BUGFIX, SPANS = SUITE["picks"], set(SUITE["bugfix_subjects"]), SUITE["spans"]
ROWS = ["InvoiceCalculator#computeTotal", "RetryQueue#processBatch", "LedgerSync#reconcile"]
PHASE1 = {"bugHunt", "hotspots", "techDebt", "dangerous", "decomposition", "godModule"}


def load(case_dir):
    calls, texts, result = [], [], ""
    for line in (case_dir / "stream.jsonl").read_text().splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "assistant":
            msg = ev["message"]
            for block in msg.get("content", []):
                if block.get("type") == "tool_use":
                    calls.append({"i": len(calls), "mid": msg.get("id"), "name": block["name"], "input": block.get("input", {})})
                elif block.get("type") == "text":
                    texts.append(block["text"])
        elif ev.get("type") == "result":
            result = ev.get("result") or ""
    log = (case_dir / "shim-calls.log").read_text() if (case_dir / "shim-calls.log").exists() else ""
    shas = json.loads((case_dir / "shas.json").read_text())
    return calls, "\n".join(texts), result, log, shas


def short(name):
    return name.split("__")[-1]


def is_git_bash(c):
    return c["name"] == "Bash" and re.search(r"(^|[;&|\s(])git\s", c["input"].get("command", ""))


def report_checks(calls, answer, result, log, shas, remote):
    out = OrderedDict()
    ranks = [c for c in calls if short(c["name"]) == "rank_chunks"]
    gits = [c for c in calls if is_git_bash(c)]
    out["phase1-before-git"] = bool(ranks) and (not gits or ranks[0]["i"] < gits[0]["i"])
    ok = len(gits) == 1
    detail = f"{len(gits)} git Bash calls"
    if ok:
        cmd = gits[0]["input"]["command"]
        for sym in ROWS:
            f, s, e = SPANS[sym]
            if not re.search(rf"-L\s*{s},{e}:\S*{re.escape(f)}", cmd):
                ok, detail = False, f"missing -L{s},{e}:{f}"
        if re.search(r"git\s+blame", cmd):
            ok, detail = False, "git blame"
        for seg in re.split(r";|&&|\n|\|\|", cmd):
            if re.search(r"git\s+log", seg) and not re.search(r"-L|--follow", seg):
                ok, detail = False, "repo-wide git log: " + seg.strip()[:80]
    if any(re.search(r"git\s+blame", c["input"].get("command", "")) for c in gits):
        ok = False
    out["one-bash-line-scoped"] = (ok, detail)
    fetched = set()
    for c in calls:
        if short(c["name"]) == "find_symbol" and c["input"].get("metaOnly") is not True:
            ids = c["input"].get("symbols") or [c["input"].get("symbol")]
            fetched.update(str(x) for x in ids if x)
    out["bodies-fetched"] = (all(any(f.endswith(sym) or f == sym for f in fetched) for sym in ROWS), sorted(fetched))
    m = re.search(r"^##\s*Overview\s*\n+((?:\s*[-*] .*\n?){2,})", answer, re.M)
    out["overview"] = bool(m)
    headers = re.findall(r"^\|\s*#\s*\|\s*Symbol\s*\|.*\|\s*Commits\s*\|\s*$", answer, re.M)
    out["commits-column"] = (len(headers) >= 2, f"{len(headers)} headers")
    sha7 = {s: shas[s][:7] for row in PICKS.values() for s in row}
    if remote:
        missing = [s for s, h in sha7.items() if not re.search(rf"github\.com/acme/widgets/commit/{h}", answer)]
        out["github-links"] = (not missing, "missing " + "; ".join(missing))
    else:
        url = re.search(r"https?://\S*/commits?/[0-9a-f]{7}", answer)
        missing = [s for s, h in sha7.items() if h not in answer]
        note = "no web remote" in answer.lower()
        out["bare-shas"] = (not url and not missing and note, f"url={bool(url)} missing={missing} note={note}")
    totals = sorted(int(t) for _, t in re.findall(r"Commits\s*\((\d+)\s+of\s+(\d+)", answer))
    out["cards"] = (answer.count("Problem:") >= 3 and len(re.findall(r"What['’]s wrong:", answer)) >= 3 and totals[-3:] == [3, 6, 6] if len(totals) >= 3 else False,
                    f"Problem={answer.count('Problem:')} totals={totals}")
    order_ok, why = True, []
    for sym, subjects in PICKS.items():
        # card commit lines only ("- [sha7](url) …" or "- sha7 …"); prose bullets citing a SHA (Problem:) are not picks
        lines = [l for l in answer.splitlines()
                 if any(re.match(r"\s*[-*]\s*\[?" + sha7[s] + r"\b", l) for s in subjects)]
        found = [s for s in subjects if any(sha7[s] in l for l in lines)]
        if len(found) != 3:
            order_ok = False
            why.append(f"{sym}: picks found {len(found)}/3")
            continue
        tags = []
        for l in lines:
            subj = next(s for s in subjects if sha7[s] in l)
            tagged = "bug-fix" in l.lower() or "bugfix" in l.lower()
            if tagged != (subj in BUGFIX):
                order_ok = False
                why.append(f"{sym}: tag wrong on '{subj}'")
            tags.append(tagged)
        if tags != sorted(tags, reverse=True):
            order_ok = False
            why.append(f"{sym}: bug-fix not first")
    out["bugfix-first"] = (order_ok, "; ".join(why))
    ns = answer.split("## Next steps", 1)
    rows = [l for l in ns[1].splitlines() if l.startswith("|")] if len(ns) == 2 else []
    hdr = bool(re.search(r"^\|\s*#\s*\|\s*Case\s*\|\s*Action\s*\|\s*Call\s*\|", ns[1], re.M)) if len(ns) == 2 else False
    r1 = [l for l in rows if "computeTotal" in l]
    r2 = [l for l in rows if "processBatch" in l]
    r3 = [l for l in rows if "reconcile" in l]
    ok = (hdr and any("bug-hunt" in l for l in r1) and any("test-driven-development" in l for l in r1)
          and any("bug-hunt" in l for l in r2) and any(("Dana" in l or "test-driven-development" in l) for l in r3))
    out["next-steps"] = (ok, f"hdr={hdr} rows={len(rows)}")
    out["offer-line"] = bool(re.search(r"^\s*→.*(here and now|task per case|здесь и сейчас|задач)", answer, re.M | re.I))
    started = [c for c in calls if (c["name"] == "Skill" and "risk-assessment" not in json.dumps(c["input"]))
               or short(c["name"]) == "get_callers"]
    tracker = re.findall(r"^(bd|gh) .*", log, re.M)
    out["no-start-no-task"] = (not started and not tracker, f"started={[c['input'] for c in started]} tracker={tracker}")
    out["commits-print-line"] = bool(re.search(r"commits:\s*3 rows, remote", answer))
    return out


def grade(case, case_dir):
    calls, answer, result, log, shas = load(case_dir)
    cid = case["id"]
    if cid in ("R1", "R2"):
        out = report_checks(calls, answer, result, log, shas, remote=(cid == "R1"))
    elif cid == "R3":
        out = OrderedDict()
        out["drafts"] = all(k in answer for k in ("computeTotal", "processBatch", "reconcile"))
        out["tracker-beads"] = bool(re.search(r"\bbeads\b|\bbd\b", answer, re.I))
        out["awaiting-line"] = bool(re.search(r"tasks:\s*3\s+drafted\s*→\s*[^;\n]*\b(beads|bd)\b[^;\n]*;\s*awaiting confirmation", answer, re.I))
        creates = re.findall(r"^(bd create|gh issue create).*", log, re.M) + [c["input"]["command"] for c in calls if c["name"] == "Bash" and re.search(r"bd\s+create|gh\s+issue\s+create", c["input"].get("command", ""))]
        out["no-create"] = (not creates, creates[:3])
        out["no-rescan"] = not any(short(c["name"]) == "rank_chunks" for c in calls)
    elif cid == "R4":
        out = OrderedDict()
        skill = any((c["name"] == "Skill" and "bug-hunt" in json.dumps(c["input"])) or
                    (c["name"] == "Read" and "bug-hunt/SKILL.md" in c["input"].get("file_path", "")) for c in calls)
        aimed = any(short(c["name"]) not in ("Skill", "Read", "Bash") and re.search(r"computeTotal|billing|InvoiceCalculator", json.dumps(c["input"])) for c in calls)
        out["case1-call"] = (skill and aimed, f"skill={skill} aimed={aimed}")
        other = [c["input"] for c in calls if re.search(r"processBatch|RetryQueue|reconcile|LedgerSync|payments/|sync/", json.dumps(c["input"]))]
        out["only-case1"] = (not other, str(other[:2])[:300])
        tail = [l for l in result.strip().splitlines() if l.strip()][-3:]
        out["next-line"] = (any(l.strip().lstrip("*").startswith("→ Next: #2") for l in tail), tail[-1:] if tail else [])
        out["no-task"] = (not re.findall(r"^(bd create|gh issue create).*", log, re.M), "")
    else:  # C1
        out = OrderedDict()
        by_mid = OrderedDict()
        for c in calls:
            if short(c["name"]) == "rank_chunks":
                by_mid.setdefault(c["mid"], []).append(c)
        block = next((b for b in by_mid.values() if PHASE1 <= {c["input"].get("rerank") for c in b}), None)
        out["parallel-block"] = (block is not None, {m: [c["input"].get("rerank") for c in b] for m, b in by_mid.items()})
        excl = block is not None and all(c["input"].get("testFile") == "exclude" and c["input"].get("documentation") == "exclude"
                                          and c["input"].get("metaOnly") is True for c in block)
        out["exclusions"] = excl
        gits = [c for c in calls if is_git_bash(c)]
        out["git-after-scan"] = block is not None and (not gits or gits[0]["i"] > block[0]["i"])
        out["pathPattern"] = (True, sorted({str(c["input"].get("pathPattern")) for c in (block or [])}))
    required = {c["id"]: c.get("required", True) for c in case["grading"]["checks"]}
    rows, passed = [], True
    for cid_, val in out.items():
        ok, detail = (val if isinstance(val, tuple) else (val, ""))
        req = required.get(cid_, False)
        rows.append({"check": cid_, "required": req, "pass": bool(ok), "detail": detail})
        if req and not ok:
            passed = False
    tools = [short(c["name"]) for c in calls]
    verdict = {"case": cid, "pass": passed, "checks": rows, "tool_calls": len(calls), "tools": tools}
    (case_dir / "grades.json").write_text(json.dumps(verdict, indent=1, ensure_ascii=False, default=str))
    return verdict


if __name__ == "__main__":
    root = Path(sys.argv[1])
    for arm in sys.argv[2:] or ["baseline", "current"]:
        for case in SUITE["evals"]:
            d = root / arm / case["id"]
            if not (d / "stream.jsonl").exists():
                continue
            v = grade(case, d)
            fails = [r["check"] for r in v["checks"] if r["required"] and not r["pass"]]
            print(json.dumps({"arm": arm, "case": case["id"], "pass": v["pass"], "calls": v["tool_calls"], "failed": fails}))
