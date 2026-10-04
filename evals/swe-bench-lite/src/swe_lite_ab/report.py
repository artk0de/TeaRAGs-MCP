import csv
import json
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from statistics import median

from .stats import bootstrap_ci, mcnemar, wilcoxon_p

PAIRED_FIELDS = ("input_tokens", "cache_write_tokens", "cache_read_tokens", "output_tokens", "cost_usd",
                 "turns", "tool_calls_total", "search_read_calls", "wall_seconds", "wall_seconds_raw", "index_in_run_seconds", "api_seconds")


@dataclass
class Row:
    arm: str
    instance_id: str
    repo: str
    mentioned: bool
    resolved: bool
    input_tokens: int
    cache_write_tokens: int
    cache_read_tokens: int
    output_tokens: int
    cost_usd: float
    turns: int
    tool_calls_total: int
    tea_rags_calls: int
    search_read_calls: int
    gold_touched: bool
    turns_to_gold: int | None
    wall_seconds: float          # agent wall clock minus in-run reindexing
    wall_seconds_raw: float
    index_in_run_seconds: float
    api_seconds: float
    gold_before_search: bool


def _pairs(rows: list[Row]) -> list[tuple[Row, Row]]:
    a0 = {r.instance_id: r for r in rows if r.arm == "arm0"}
    a1 = {r.instance_id: r for r in rows if r.arm == "arm1"}
    return [(a0[i], a1[i]) for i in sorted(a0.keys() & a1.keys())]


def _pct(k: int, n: int) -> str:
    return f"{k}/{n} ({100 * k / n:.1f}%)" if n else "0/0"


def _section(title: str, pairs: list[tuple[Row, Row]]) -> list[str]:
    n = len(pairs)
    if n == 0:
        return [f"## {title} (n=0)", "", "No tasks in this stratum.", ""]
    r0 =[p[0].resolved for p in pairs]
    r1 = [p[1].resolved for p in pairs]
    out = [f"## {title} (n={n})", "", "| Metric | arm0 | arm1 | p |", "|---|---|---|---|",
           f"| Resolved | {_pct(sum(r0), n)} | {_pct(sum(r1), n)} | {mcnemar(r0, r1):.3f} (McNemar) |"]
    for f in PAIRED_FIELDS:
        v0 = [getattr(p[0], f) for p in pairs]
        v1 = [getattr(p[1], f) for p in pairs]
        lo, hi = bootstrap_ci([y - x for x, y in zip(v0, v1)])
        out.append(f"| median {f} | {median(v0):.4g} | {median(v1):.4g} | "
                   f"{wilcoxon_p(v0, v1):.3f} (Wilcoxon); Δ mean 95% CI [{lo:.4g}, {hi:.4g}] |")
    g0 = [p[0].gold_touched for p in pairs]
    g1 = [p[1].gold_touched for p in pairs]
    out += [f"| Gold file touched | {_pct(sum(g0), n)} | {_pct(sum(g1), n)} | {mcnemar(g0, g1):.3f} (McNemar) |", ""]
    return out


def index_time_line(index_records: list[dict]) -> str | None:
    seconds = [r["seconds"] for r in index_records]
    if not seconds:
        return None
    return (f"Arm 1 index time per task: median {median(seconds):.1f} s, total {sum(seconds):.1f} s "
            "(not included in agent wall time)")


def _outcome_label(record: dict) -> str | None:
    outcome = record.get("outcome") or {}
    bad = [f"{kind}: {', '.join(outcome[kind])}" for kind in ("failed", "degraded") if outcome.get(kind)]
    return "; ".join(bad) or None


def _index_defect(record: dict) -> str | None:
    if label := _outcome_label(record):
        return label
    counts = record["signalCounts"]
    empty = [key for key in ("git.chunk.commitCount", "codegraph.chunk.fanIn") if counts.get(key, 0) == 0]
    return f"empty: {', '.join(empty)}" if empty else None


def index_quality_section(index_records: list[dict]) -> list[str]:
    """What arm 1 searched over, per task. An arm-1 result on a defective index is not evidence about
    TeaRAGs, so defects are counted up front rather than left for the reader to spot."""
    records = [r for r in index_records if "signalCounts" in r]
    if not records:
        return []
    out = ["## Arm 1 index quality", "",
           "| Task | Language | Codegraph resolve | git.file signals | git.chunk signals | codegraph.chunk signals | Enrichment |",
           "|---|---|---|---|---|---|---|"]
    for r in records:
        cg, counts = r["codegraphResolve"], r["signalCounts"]
        resolve = cg.get("resolve") if cg else None
        out.append(f"| {r['instance_id']} | {r.get('language')} | {'n/a' if resolve is None else resolve} | "
                   f"{counts['git.file.commitCount']} | {counts['git.chunk.commitCount']} | "
                   f"{counts['codegraph.chunk.fanIn']} | {_outcome_label(r) or 'ok'} |")
    defective = [r["instance_id"] for r in records if _index_defect(r)]
    if defective:
        out += ["", f"WARNING: {len(defective)} of {len(records)} arm-1 indexes are defective "
                    f"(failed / degraded enrichment or empty chunk signals): {', '.join(defective)}"]
    return out + [""]


def _total_input(r: Row) -> int:
    return r.input_tokens + r.cache_write_tokens + r.cache_read_tokens


def _repo_strata(pairs: list[tuple[Row, Row]]) -> list[str]:
    out = ["## By repository × stratum", "",
           "| Repo | Gold file | n | resolved arm0 | resolved arm1 | median total input arm0 | arm1 "
           "| median wall_seconds arm0 | arm1 |", "|---|---|---|---|---|---|---|---|---|"]
    groups: dict[tuple[str, bool], list[tuple[Row, Row]]] = {}
    for p in pairs:
        groups.setdefault((p[0].repo, p[0].mentioned), []).append(p)
    for (repo, mentioned), ps in sorted(groups.items(), key=lambda kv: (kv[0][0], not kv[0][1])):
        t0, t1 = median(_total_input(p[0]) for p in ps), median(_total_input(p[1]) for p in ps)
        w0, w1 = median(p[0].wall_seconds for p in ps), median(p[1].wall_seconds for p in ps)
        out.append(f"| {repo} | {'named' if mentioned else 'not named'} | {len(ps)} | "
                   f"{sum(p[0].resolved for p in ps)} | {sum(p[1].resolved for p in ps)} | "
                   f"{t0:.0f} | {t1:.0f} | {w0:.4g} | {w1:.4g} |")
    return out + [""]


def render(rows: list[Row], index_records: list[dict] | None = None) -> str:
    pairs = _pairs(rows)
    if not pairs:
        return "# SWE-bench Lite A/B\n\nNo paired results.\n"
    tr = sum(p[1].tea_rags_calls for p in pairs)
    sr = sum(p[1].search_read_calls for p in pairs)
    lines = ["# SWE-bench Lite A/B — Claude Code with vs without TeaRAGs", "",
             f"TeaRAGs share of search/read calls: {100 * tr / sr:.1f}%" if sr else "TeaRAGs share: n/a", ""]
    index_line = index_time_line(index_records or [])
    if index_line:
        lines += [index_line, ""]
    lines += index_quality_section(index_records or [])
    lines += _section("All tasks", pairs)
    n = len(pairs)
    for i, arm in enumerate(("arm0", "arm1")):
        lines.append(f"Gold file opened before any search ({arm}): {_pct(sum(p[i].gold_before_search for p in pairs), n)}")
    lines.append("")
    lines += _section("Gold file named in issue", [p for p in pairs if p[0].mentioned])
    lines += _section("Gold file not named", [p for p in pairs if not p[0].mentioned])
    lines += _repo_strata(pairs)
    lines += _section("Exploratory: not searched-for in arm 0", [p for p in pairs if not p[0].gold_before_search])
    return "\n".join(lines) + "\n"


def write_csv(rows: list[Row], path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[fl.name for fl in fields(Row)])
        writer.writeheader()
        writer.writerows(asdict(r) for r in rows)
    return path


def build_rows(tasks, resolved_by_arm: dict[str, set[str]], usage_source: str) -> list[Row]:
    from . import config
    from .tasks import gold_files, mentions_gold_file
    from .transcript import parse

    rows = []
    for arm in ("arm0", "arm1"):
        for t in tasks:
            path = config.RUNS / arm / t.instance_id / "transcript.jsonl"
            if not path.exists():
                continue
            arrivals_path = path.parent / "arrivals.txt"
            arrivals = [float(x) for x in arrivals_path.read_text().split()] if arrivals_path.exists() else None
            m = parse(path.read_text().split("\n"), gold_files(t.patch), usage_source, arrivals)
            status_path = path.parent / "status.json"
            status = json.loads(status_path.read_text()) if status_path.exists() else {}
            wall_raw = status.get("wall_seconds") or 0
            rows.append(Row(arm, t.instance_id, t.repo, mentions_gold_file(t), t.instance_id in resolved_by_arm[arm],
                            m.input_tokens, m.cache_write_tokens, m.cache_read_tokens, m.output_tokens, m.cost_usd,
                            m.turns, sum(m.tool_calls.values()), m.tea_rags_calls, m.search_read_calls,
                            m.gold_touched, m.turns_to_gold, max(0.0, wall_raw - m.index_in_run_seconds),
                            wall_raw, m.index_in_run_seconds, m.duration_api_ms / 1000, m.gold_before_search))
    return rows


def load_index_records(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
