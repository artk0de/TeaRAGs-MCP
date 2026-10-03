import csv
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from statistics import median

from .stats import bootstrap_ci, mcnemar, wilcoxon_p

PAIRED_FIELDS = ("input_tokens", "cache_write_tokens", "cache_read_tokens", "output_tokens", "cost_usd",
                 "turns", "tool_calls_total", "search_read_calls")


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


def render(rows: list[Row]) -> str:
    pairs = _pairs(rows)
    if not pairs:
        return "# SWE-bench Lite A/B\n\nNo paired results.\n"
    tr = sum(p[1].tea_rags_calls for p in pairs)
    sr = sum(p[1].search_read_calls for p in pairs)
    lines = ["# SWE-bench Lite A/B — Claude Code with vs without TeaRAGs", "",
             f"TeaRAGs share of search/read calls: {100 * tr / sr:.1f}%" if sr else "TeaRAGs share: n/a", ""]
    lines += _section("All tasks", pairs)
    lines += _section("Gold file named in issue", [p for p in pairs if p[0].mentioned])
    lines += _section("Gold file not named", [p for p in pairs if not p[0].mentioned])
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
            m = parse(path.read_text().splitlines(), gold_files(t.patch), usage_source)
            rows.append(Row(arm, t.instance_id, t.repo, mentions_gold_file(t), t.instance_id in resolved_by_arm[arm],
                            m.input_tokens, m.cache_write_tokens, m.cache_read_tokens, m.output_tokens, m.cost_usd,
                            m.turns, sum(m.tool_calls.values()), m.tea_rags_calls, m.search_read_calls,
                            m.gold_touched, m.turns_to_gold))
    return rows
