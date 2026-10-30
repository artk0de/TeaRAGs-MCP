"""Component localization benchmark: rank a repository's files for an issue text, no LLM anywhere.

Each task's repository is indexed at its base commit. Every configuration ranks files for the ORIGINAL
issue text (SWE-bench_Pro-locagent `problem_statement`, which names no paths, unlike Pro's
instruction.md); the score is where the files of the gold patch land. tea-rags configurations differ
only in tool (semantic vs hybrid) and rerank preset, so the table separates what semantic search,
BM25 fusion and git-signal reranking each contribute. `bm25` is the lexical baseline, computed here.
"""
import json
import math
import re
import subprocess
import tempfile
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from . import config, indexing, repos
from .tasks import gold_files

LANGUAGE = "python"
EXTS = (".py",)
# Issue texts are a few KB; the cap only guards against a pathological one. Recorded per task.
MAX_QUERY_CHARS = 6000
TOP_PERSISTED = 50
KS = (1, 5, 10)


@dataclass(frozen=True)
class LocalizeConfig:
    name: str
    tool: str
    rerank: str | tuple[tuple[str, float], ...]  # preset name, or custom weights as (signal, weight) pairs
    production: bool = False  # restrict the searched chunk set with the `production` filter preset


TIEBREAK_WEIGHTS = (("similarity", 0.85), ("recency", 0.075), ("churn", 0.075))

TEA_RAGS_CONFIGS = (
    LocalizeConfig("semantic-relevance", "semantic_search", "relevance", False),
    LocalizeConfig("hybrid-relevance", "hybrid_search", "relevance", False),
    LocalizeConfig("hybrid-bugHunt", "hybrid_search", "bugHunt", False),
    LocalizeConfig("hybrid-hotspots", "hybrid_search", "hotspots", False),
    LocalizeConfig("semantic-relevance-prod", "semantic_search", "relevance", True),
    LocalizeConfig("hybrid-relevance-prod", "hybrid_search", "relevance", True),
    LocalizeConfig("hybrid-tiebreak-prod", "hybrid_search", TIEBREAK_WEIGHTS, True),
    LocalizeConfig("semantic-tiebreak-prod", "semantic_search", TIEBREAK_WEIGHTS, True),
)
CONFIG_NAMES = tuple(c.name for c in TEA_RAGS_CONFIGS) + ("bm25", "bm25-prod")

_NON_PRODUCTION_DIRS = {"tests", "test", "__tests__", "spec", "specs", "docs", "doc"}
_TEST_FILE = re.compile(r"^test_.*\.py$|_test\.py$")


def is_test_or_doc_path(path: str) -> bool:
    """Same classifier as the SWE-bench Pro verifier: test/doc directories, conftest.py, test_*.py, *_test.py."""
    *parents, base = path.split("/")
    return bool(_NON_PRODUCTION_DIRS.intersection(parents)) or base == "conftest.py" or bool(_TEST_FILE.search(base))


# --- pure core ---------------------------------------------------------------------------------

_WORD = re.compile(r"[A-Za-z0-9]+")
_CAMEL = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+")


def tokenize(text: str) -> list[str]:
    """Code-aware tokens: split on every non-alphanumeric (snake_case, dots, slashes) and on camelCase
    boundaries, lowercased; tokens shorter than 2 characters are dropped."""
    return [p.lower() for word in _WORD.findall(text) for p in _CAMEL.findall(word) if len(p) >= 2]


def files_from_chunks(chunks: list[dict]) -> list[str]:
    seen: dict[str, None] = {}
    for c in chunks:
        seen.setdefault(c["payload"]["relativePath"], None)
    return list(seen)


def bm25_scores(docs: dict[str, list[str]], query: list[str], k1: float = 1.2, b: float = 0.75) -> dict[str, float]:
    n = len(docs)
    if not n:
        return {}
    avgdl = sum(len(d) for d in docs.values()) / n or 1.0
    terms = set(query)
    df = Counter(t for d in docs.values() for t in terms.intersection(d))
    idf = {t: math.log(1 + (n - df[t] + 0.5) / (df[t] + 0.5)) for t in terms if df[t]}
    scores = {}
    for path, tokens in docs.items():
        tf = Counter(tokens)
        dl = len(tokens)
        s = sum(idf[t] * tf[t] * (k1 + 1) / (tf[t] + k1 * (1 - b + b * dl / avgdl)) for t in idf if tf[t])
        if s > 0:
            scores[path] = s
    return scores


def tracked_files(repo_dir: Path, exts: tuple[str, ...]) -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z"], cwd=repo_dir, check=True, capture_output=True, text=True).stdout
    return [p for p in out.split("\0") if p.endswith(exts)]


def bm25_rank(repo_dir: Path, query: str, exts: tuple[str, ...], exclude=None) -> list[str]:
    """Files ranked by BM25 against the query; a document is the path's tokens plus the file's.
    `exclude(path) -> bool` drops files from the corpus before scoring."""
    docs = {}
    for path in tracked_files(repo_dir, exts):
        if exclude and exclude(path):
            continue
        try:
            text = (Path(repo_dir) / path).read_text(errors="ignore")
        except OSError:
            continue
        docs[path] = tokenize(path) + tokenize(text)
    scores = bm25_scores(docs, tokenize(query))
    return sorted(scores, key=lambda p: (-scores[p], p))


def score(ranking: list[str], gold: list[str]) -> dict | None:
    if not gold:
        return None
    gold_set = set(gold)
    rank = next((i + 1 for i, f in enumerate(ranking) if f in gold_set), None)
    m: dict = {"rank_of_first_gold": rank}
    for k in KS:
        found = len(gold_set.intersection(ranking[:k]))
        m[f"recall@{k}"] = found / len(gold_set)
        m[f"hit@{k}"] = int(found > 0)
    m["mrr"] = 1 / rank if rank else 0.0
    return m


def scored_gold(patch: str) -> dict[str, list[str]]:
    files = gold_files(patch)
    return {"primary": [f for f in files if f.endswith(EXTS)], "secondary": files}


def truncate_query(text: str, max_chars: int) -> tuple[str, bool]:
    return (text, False) if len(text) <= max_chars else (text[:max_chars], True)


def search_params(cfg: LocalizeConfig, alias: str, query: str, limit: int, offset: int,
                  repo_dir: Path | None = None) -> dict:
    # `filter: {}` clears the production filter bugHunt / hotspots would add; `production` configs ask
    # for the preset explicitly, so the chunk-set restriction is always stated by the config itself.
    rerank = cfg.rerank if isinstance(cfg.rerank, str) else {"custom": dict(cfg.rerank)}
    return {"project": alias, "query": query, "limit": limit, "offset": offset, "language": LANGUAGE,
            "filter": {"presets": "production"} if cfg.production else {},
            "fields": ["relativePath"], "rerank": rerank,
            **({"path": str(repo_dir)} if repo_dir is not None else {})}


# --- thin I/O ----------------------------------------------------------------------------------

def _env() -> dict:
    import os

    return {**os.environ, **config.EMBEDDING_ENV}


def search_files(cfg: LocalizeConfig, alias: str, query: str, want: int = TOP_PERSISTED, page: int = 300,
                 max_pages: int = 4, run=subprocess.run, repo_dir: Path | None = None) -> list[str]:
    """Distinct files in rank order, paging chunks until `want` files or the tool runs dry. Raises
    RuntimeError with the tool's error text. Runs outside any task repo: a repo-pinned node version
    would break the CLI's node shim."""
    chunks: list[dict] = []
    for i in range(max_pages):
        proc = run(["tea-rags", "call", cfg.tool, json.dumps(search_params(cfg, alias, query, page, i * page, repo_dir)), "--json"],
                   env=_env(), capture_output=True, text=True, cwd=tempfile.gettempdir())
        data = indexing._final_json(proc.stdout or "")
        if proc.returncode != 0 or not data or data.get("isError"):
            raise RuntimeError(f"{cfg.tool} exit {proc.returncode}: "
                               f"{((proc.stderr or '') + (proc.stdout or ''))[-400:].strip()}")
        results = (data.get("structuredContent") or {}).get("results", [])
        if isinstance(results, dict):
            # Current MCP answers fold two or more rows into a column table.
            column = results["columns"].index("payload.relativePath")
            results = [{"payload": {"relativePath": row[column]}} for row in results["rows"]]
        chunks += results
        if len(files_from_chunks(chunks)) >= want or len(results) < page:
            break
    return files_from_chunks(chunks)


def _persist(instance_id: str, name: str, files: list[str], extra: dict) -> None:
    out = config.RUNS / "localize" / instance_id / f"{name}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"files": files[:TOP_PERSISTED], **extra}, indent=2) + "\n")


def localize_task(instance_id: str, problem: str, patch: str, alias: str, repo_dir: Path,
                  run=subprocess.run) -> dict:
    query, truncated = truncate_query(problem, MAX_QUERY_CHARS)
    gold = scored_gold(patch)
    configs: dict[str, dict] = {}
    rankers = [(c.name, lambda c=c: search_files(c, alias, query, run=run, repo_dir=repo_dir)) for c in TEA_RAGS_CONFIGS]
    rankers.append(("bm25", lambda: bm25_rank(repo_dir, query, EXTS)))
    rankers.append(("bm25-prod", lambda: bm25_rank(repo_dir, query, EXTS, exclude=is_test_or_doc_path)))
    for name, rank in rankers:
        started = time.monotonic()
        try:
            files, error = rank(), None
        except (RuntimeError, OSError, subprocess.CalledProcessError) as e:
            files, error = [], str(e)
        seconds = round(time.monotonic() - started, 1)
        _persist(instance_id, name, files, {"error": error, "seconds": seconds})
        ok = error is None
        configs[name] = {"error": error, "files": len(files), "seconds": seconds,
                         "primary": score(files, gold["primary"]) if ok else None,
                         "secondary": score(files, gold["secondary"]) if ok else None}
    return {"instance_id": instance_id, "alias": alias, "query_chars": len(problem),
            "query_truncated": truncated, "gold": gold, "configs": configs}


def load_locagent() -> dict[str, dict]:
    """OpenHands/SWE-bench_Pro-locagent rows by id; snapshot written once, read offline afterwards."""
    if not config.LOCAGENT_SNAPSHOT.exists():
        from datasets import load_dataset

        rows = [{k: r[k] for k in ("instance_id", "repo", "base_commit", "problem_statement", "patch")}
                for r in load_dataset(config.LOCAGENT_DATASET, split="test")]
        config.LOCAGENT_SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
        config.LOCAGENT_SNAPSHOT.write_text("".join(json.dumps(r) + "\n" for r in rows))
    rows = [json.loads(line) for line in config.LOCAGENT_SNAPSHOT.read_text().splitlines() if line]
    return {r["instance_id"]: r for r in rows}


def task_list_path(name: str) -> Path:
    """tasks/<name>.json, else a temporary list under runs/ (e.g. the subset whose indexes are ready)."""
    path = config.TASKS_DIR / f"{name}.json"
    return path if path.exists() else config.RUNS / f"{name}.json"


def run(ids: list[str]) -> list[dict]:
    rows = load_locagent()
    records = []
    for iid in ids:
        r = rows[iid]
        records.append(localize_task(iid, r["problem_statement"], r["patch"], indexing.alias_for(iid),
                                     repos.task_dir(iid)))
    out = config.RUNS / "localize.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(r) + "\n" for r in records))
    return records


# --- report ------------------------------------------------------------------------------------

_METRICS = (("R@1", "recall@1"), ("R@5", "recall@5"), ("R@10", "recall@10"), ("Hit@5", "hit@5"), ("MRR", "mrr"))


def _config_names(records: list[dict]) -> list[str]:
    names: dict[str, None] = {}
    for r in records:
        names.update(dict.fromkeys(r["configs"]))
    return list(names)


def _metric_table(records: list[dict], gold: str) -> list[str]:
    lines = ["| config | n | " + " | ".join(h for h, _ in _METRICS) + " |",
             "|---|---:|" + "---:|" * len(_METRICS)]
    for name in _config_names(records):
        ms = [r["configs"][name][gold] for r in records if name in r["configs"] and r["configs"][name][gold]]
        cells = [f"{sum(m[k] for m in ms) / len(ms):.2f}" if ms else "–" for _, k in _METRICS]
        lines.append(f"| {name} | {len(ms)} | " + " | ".join(cells) + " |")
    return lines


def _rank_cell(c: dict | None) -> str:
    if c is None:
        return "–"
    if c["error"]:
        return "err"
    if c["primary"] is None:
        return "n/a"
    rank = c["primary"]["rank_of_first_gold"]
    return "–" if rank is None else str(rank)


def render(records: list[dict], tasks_name: str, wall_seconds: float | None = None) -> str:
    names = _config_names(records)
    md = [f"# Component localization — {tasks_name}", "",
          "Files ranked for the original issue text (SWE-bench_Pro-locagent `problem_statement`), no LLM. "
          f"tea-rags configurations search `language: {LANGUAGE}` chunks, with the preset filter cleared or, "
          f"for `-prod` configurations, set to `production`; `bm25` ranks git-tracked `{'/'.join(EXTS)}` "
          f"files and `bm25-prod` the same minus test and doc files. A gold file outside the top "
          f"{TOP_PERSISTED} counts as not found (rank –).", ""]
    if wall_seconds is not None:
        md += [f"Wall time: {wall_seconds:.0f} s for {len(records)} tasks.", ""]
    md += ["## Primary gold (gold `.py` files)", ""] + _metric_table(records, "primary")
    md += ["", "## Secondary gold (every gold file)", ""] + _metric_table(records, "secondary")
    md += ["", "## Rank of the first primary gold file per task", "",
           "| task | gold .py | " + " | ".join(names) + " |", "|---|---:|" + "---:|" * len(names)]
    for r in records:
        md.append(f"| {r['instance_id']} | {len(r['gold']['primary'])} | "
                  + " | ".join(_rank_cell(r["configs"].get(n)) for n in names) + " |")
    notes = []
    truncated = [r["instance_id"] for r in records if r["query_truncated"]]
    if truncated:
        notes.append(f"Queries truncated: {', '.join(truncated)} (cap {MAX_QUERY_CHARS} chars)")
    unscored = [r["instance_id"] for r in records if not r["gold"]["primary"]]
    if unscored:
        notes.append(f"Unscored (no gold .py file): {', '.join(unscored)}")
    for r in records:
        for name, c in r["configs"].items():
            if c["error"]:
                notes.append(f"Errored: {r['instance_id']} {name}: {c['error']}")
            elif c["files"] == 0:
                notes.append(f"Empty ranking: {r['instance_id']} {name}")
    if notes:
        md += ["", "## Notes", ""] + [f"- {n}" for n in notes]
    return "\n".join(md) + "\n"
