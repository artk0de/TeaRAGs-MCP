import hashlib
import json
import os
import re
import subprocess
import time
from collections import defaultdict

from . import config
from .repos import task_dir
from .tasks import Task


def alias_for(instance_id: str) -> str:
    return ("swe-" + instance_id.lower())[:64]


def chain_order(tasks: list[Task]) -> dict[str, list[Task]]:
    chains: dict[str, list[Task]] = defaultdict(list)
    for t in tasks:
        chains[t.repo].append(t)
    return {repo: sorted(ts, key=lambda t: t.created_at) for repo, ts in chains.items()}


def index_commands(task: Task, previous_alias: str | None, seed_mode: str) -> list[list[str]]:
    path, alias = str(task_dir(task.instance_id)), alias_for(task.instance_id)
    if previous_alias is None or seed_mode == "full":
        return [["tea-rags", "index-codebase", path, "--name", alias, "--no-worktree-seed", "--wait-enrichments", "--json"]]
    # `worktree create` registers the clone as `<from>-worktree-<name>`, which grows along a chain past
    # the 64-char registry cap; re-register it under the short alias (the collection follows the path).
    clone = "w" + hashlib.sha1(task.instance_id.encode()).hexdigest()[:8]
    return [
        ["tea-rags", "worktree", "create", clone, "--from", previous_alias, "--path", path, "--no-git", "--json"],
        ["tea-rags", "projects", "unregister", "--name", f"{previous_alias}-worktree-{clone}"],
        ["tea-rags", "projects", "register", "--path", path, "--name", alias],
        ["tea-rags", "index-codebase", "--project", alias, "--wait-enrichments", "--json"],
    ]


_INDEX_STAT_KEYS = ("overallMs", "filesCount", "chunksCount")


def index_stats(stdout: str) -> dict:
    """overallMs / filesCount / chunksCount from an `index-codebase --json` run; {} when unparseable."""
    data = _final_json(stdout)
    return {k: data[k] for k in _INDEX_STAT_KEYS if k in data} if data else {}


def _final_json(stdout: str) -> dict | None:
    for text in [stdout] + [line for line in reversed(stdout.splitlines()) if line.lstrip().startswith("{")]:
        try:
            data = json.loads(text)
        except ValueError:
            continue
        if isinstance(data, dict):
            return data
    return None


def index_outcome(stdout: str) -> dict | None:
    """The `outcome` block of an `index-codebase --json` run: which enrichments failed or degraded."""
    data = _final_json(stdout)
    return data.get("outcome") if data else None


_RESOLVE_KIND = re.compile(r"^(\w+) ([\d.]+) (\d+)/(\d+)$")


def parse_prime(text: str) -> dict:
    """Primary language, its realized codegraph resolve, per-receiver-kind rates and enrichment status
    from `tea-rags prime` — the only read path for the persisted per-kind rates."""
    sections: dict[str, list[str]] = defaultdict(list)
    current = ""
    for line in text.splitlines():
        if line.startswith("## "):
            current = line[3:].strip()
        elif line.strip():
            sections[current].append(line.strip())
    primary = next((m.group(1) for line in sections["Polyglot"] if (m := re.match(r"primary: (\S+)", line))), None)
    resolve = None
    for line in next((v for k, v in sections.items() if k.startswith("Language capability")), []):
        m = re.match(rf"{re.escape(primary or '')}: .*· resolve ([\d.]+)$", line)
        if primary and m:
            resolve = float(m.group(1))
    kinds = {m.group(1): {"rate": float(m.group(2)), "resolved": int(m.group(3)), "total": int(m.group(4))}
             for line in sections["Codegraph resolve"] if (m := _RESOLVE_KIND.match(line))}
    enrichment = dict(line.split(": ", 1) for line in sections["Enrichment"] if ": " in line)
    return {"primaryLanguage": primary, "resolve": resolve, "kinds": kinds, "enrichment": enrichment}


QUALITY_SIGNALS = ("git.file.commitCount", "git.chunk.commitCount", "codegraph.chunk.fanIn")


def signal_counts(metrics: dict, language: str | None) -> dict[str, int]:
    """Observations per key signal for the primary language, source + test scope. A signal missing from
    the metrics has no observation at all: 0 is the defect marker (e.g. git chunk signals never written)."""
    signals = metrics.get("signals", {}).get(language or "", {})
    return {key: sum(scope.get("count", 0) for scope in signals.get(key, {}).values() if isinstance(scope, dict))
            for key in QUALITY_SIGNALS}


PRIME_COLD = "Qdrant warm-up pending"
PRIME_ATTEMPTS = 3


def index_quality(path: str, alias: str, env: dict, run=subprocess.run, retry_delay: float = 5.0) -> dict:
    """What arm 1 searched over: realized codegraph resolve (prime) and whether the git / codegraph
    signals were actually written (index metrics). An enrichment can report healthy with empty values.

    prime is the only read path for per-kind resolve, but under load it answers "warm-up pending"
    while the daemon serves `call` fine, so it is retried and, if still cold, recorded as unmeasured
    (None). The language comes from the metrics, which do not depend on prime."""
    prime = None
    for attempt in range(PRIME_ATTEMPTS):
        out = run(["tea-rags", "prime", path], env=env, capture_output=True, text=True).stdout
        if PRIME_COLD not in out:
            prime = parse_prime(out)
            break
        if attempt + 1 < PRIME_ATTEMPTS:
            time.sleep(retry_delay)
    proc = run(["tea-rags", "call", "get_index_metrics", json.dumps({"project": alias})],
               env=env, capture_output=True, text=True)
    metrics = _final_json(proc.stdout) or {}
    languages = metrics.get("distributions", {}).get("language", {})
    language = max(languages, key=languages.get) if languages else (prime or {}).get("primaryLanguage")
    return {"language": language, "codegraphResolve": prime, "signalCounts": signal_counts(metrics, language)}


def run_chain(tasks: list[Task]) -> list[dict]:
    env = {**os.environ, **config.EMBEDDING_ENV}
    records = []
    for repo_tasks in chain_order(tasks).values():
        previous = None
        for task in repo_tasks:
            started = time.monotonic()
            ok = True
            stats: dict = {}
            for cmd in index_commands(task, previous, config.SEED_MODE):
                proc = subprocess.run(cmd, env=env, capture_output=True, text=True)
                ok = ok and proc.returncode == 0
                if cmd[1] == "index-codebase":
                    stats = {**index_stats(proc.stdout), "outcome": index_outcome(proc.stdout)}
            seconds = round(time.monotonic() - started, 1)
            quality = index_quality(str(task_dir(task.instance_id)), alias_for(task.instance_id), env) if ok else {}
            records.append({"instance_id": task.instance_id, "alias": alias_for(task.instance_id),
                            "seconds": seconds, "ok": ok, **stats, **quality})
            previous = alias_for(task.instance_id) if ok else previous
    out = config.RUNS / "index.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(r) + "\n" for r in records))
    return records
