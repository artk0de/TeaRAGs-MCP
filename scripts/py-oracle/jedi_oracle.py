#!/usr/bin/env python3
"""Ground truth for the Python codegraph oracle (bd tea-rags-mcp-mmckn).

Thin by design. This process answers ONE question per call site — "where is the
callee defined?" — and never sees the resolver's answer, so it cannot be tuned
toward agreement. Every comparison lives in the TS host.

Run through `uv`, so jedi's own environment stays separate from the corpus's:

    uv run --no-project --python 3.13 --with jedi==0.20.0 \\
        python scripts/py-oracle/jedi_oracle.py

Two facts about jedi 0.20.0 that cost time to find, recorded so they are not
re-derived:

  * `jedi.Project(root, environment=...)` raises TypeError. The working form is
    `jedi.Project(path=root, environment_path=venv_python)`.
  * parso 0.8.7 (jedi's pin) has a stale grammar. PEP 758 `except A, B:`,
    `match` statements and `type X = ...` produce error nodes rather than an
    exception, so `grammar.parse()` silently succeeds while jedi loses the
    enclosing suite. That is reported per file as `parsoErrors`, and the host
    marks every row of such a file degraded rather than trusting or dropping it.
"""

from __future__ import annotations

import ast
import json
import multiprocessing as mp
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

import jedi
import parso

STDLIB_DIR_RE = re.compile(r"/lib/python3\.\d+/(?!site-packages/)")
JEDI_STUB_MARKERS = ("/jedi/third_party/typeshed/", "/jedi/third_party/django-stubs/")
IN_PROJECT_ORIGINS = frozenset({"project", "generatedInRepo"})


@dataclass(frozen=True)
class CallSite:
    """One AST node the oracle can query, located by the callee's END position."""

    start_line: int
    member: str
    receiver: str | None
    query_line: int
    query_col: int
    shape: str  # "call" | "decoratorBare" | "subscriptCall"
    is_decorator: bool
    receiver_is_annotated_param: bool
    enclosing_has_return_annotation: bool
    is_super_call: bool
    receiver_is_union: bool


_STATE: dict[str, Any] = {}


def classify_origin(module_path: Path | None, corpus_root: Path) -> str:
    """Where a jedi target lives.

    ORDER IS LOAD-BEARING and is not the obvious one. Three PATH tests come
    first. jedi's bundled stubs sit UNDER site-packages, so the stub test must
    precede the site-packages test or no target ever reads `typeshedStub`; and
    both, with the stdlib DIRECTORY test, must precede the corpus-root prefix
    test, because ugnest keeps its virtualenv INSIDE its own checkout and a
    root-prefix-first order called Django's own source "project" — 26 of 30
    sampled targets were misclassified that way.

    The stdlib NAME test is a different animal and now runs LAST, only for a
    path the corpus does not contain. It is a heuristic over the file's stem,
    and a project is free to own a module called `string`, `types` or `email`.
    Running it ahead of containment called netbox's `netbox/utilities/string.py`
    stdlib and polar's `sdk/generator/python/types.py` stdlib, which scored the
    chain's CORRECT answer a phantom: 432 netbox rows and 46 polar rows (7dsyq).
    """
    if module_path is None:
        return "builtin"
    text = module_path.as_posix()
    if any(marker in text for marker in JEDI_STUB_MARKERS):
        return "typeshedStub"
    if "/site-packages/" in text or "/dist-packages/" in text:
        return "sitePackages"
    if STDLIB_DIR_RE.search(text) is not None:
        return "stdlib"
    try:
        rel = module_path.resolve().relative_to(corpus_root)
    except ValueError:
        return "stdlib" if module_path.stem in sys.stdlib_module_names else "outsideRepo"
    return "generatedInRepo" if "migrations" in rel.parts else "project"


def compose_symbol_id(target_path: Path, def_line: int) -> tuple[str | None, str, bool]:
    """`(symbolId, defNodeKind, pinUncertain)` for a definition at `def_line`.

    Mirrors `DefaultSymbolIdComposer`: `Class#method` for an instance method,
    `Class.method` when the def carries `staticmethod` / `classmethod`, a bare
    name at module level, `Outer.Inner` for nesting.

    The two ways that fails are DIFFERENT facts and no longer share a kind.
    `unknown` is the file itself being unreadable — an instrument gap, and the
    target could be anything. `nonCallable` is the file parsing cleanly and jedi
    pointing at a line no `def` or `class` starts on: an assignment, which is
    what jedi's `goto` answers for `table = None` called as `self.table(...)`
    (`netbox/netbox/views/generic/base.py:72`) and for any local name bound to a
    callable. There is no callable target there for a chain to find, so the host
    scores those rows in their own bucket rather than as a miss (z796g). Both
    stay `pinUncertain`: neither can be compared at symbol granularity.
    """
    tree = _cached_tree(target_path)
    if tree is None:
        return None, "unknown", True

    stack: list[tuple[ast.AST, list[str]]] = [(tree, [])]
    while stack:
        node, scope = stack.pop()
        for child in ast.iter_child_nodes(node):
            if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            if child.lineno == def_line:
                return _compose_for(child, scope)
            inner = scope + [child.name]
            stack.append((child, inner))
    return None, "nonCallable", True


def _compose_for(node: ast.AST, scope: list[str]) -> tuple[str, str, bool]:
    if isinstance(node, ast.ClassDef):
        return (".".join(scope + [node.name]), "class", False)
    decorators = {
        d.id for d in getattr(node, "decorator_list", []) if isinstance(d, ast.Name)
    }
    name = getattr(node, "name", "")
    if not scope:
        return (name, "function", False)
    separator = "." if decorators & {"staticmethod", "classmethod"} else "#"
    return (f"{'.'.join(scope)}{separator}{name}", "function", False)


_TREE_CACHE: dict[str, ast.Module | None] = {}


def _cached_tree(path: Path) -> ast.Module | None:
    key = path.as_posix()
    if key not in _TREE_CACHE:
        try:
            _TREE_CACHE[key] = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        except (OSError, SyntaxError, ValueError):
            _TREE_CACHE[key] = None
    return _TREE_CACHE[key]


def _receiver_text(node: ast.AST, code: str) -> str | None:
    segment = ast.get_source_segment(code, node)
    return segment if segment is None else segment.strip()


def enumerate_call_sites(tree: ast.Module, code: str) -> list[CallSite]:
    """Every node the walker could have emitted a `CallRef` for.

    Sorted by `(query_line, query_col)` so a file's sites are enumerated in one
    fixed order regardless of how `ast.walk` happens to traverse. Three
    families, matching the walker: ordinary calls, decorator calls (which ARE
    `ast.Call` and so arrive through the same pass), and BARE decorators
    (`@setupmethod`), which are `Name` / `Attribute` and would otherwise be
    invisible even though `collectPythonDecoratorCalls` emits them.
    """
    annotated_params: set[str] = set()
    union_params: set[str] = set()
    returns_annotated: dict[int, bool] = {}
    decorator_nodes: set[int] = set()
    bare: list[CallSite] = []

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            returns_annotated[node.lineno] = node.returns is not None
            for arg in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]:
                if arg.annotation is None:
                    continue
                annotated_params.add(arg.arg)
                rendered = ast.get_source_segment(code, arg.annotation) or ""
                if "|" in rendered or rendered.startswith(("Union[", "Optional[")):
                    union_params.add(arg.arg)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            for dec in node.decorator_list:
                decorator_nodes.add(id(dec))
                if isinstance(dec, (ast.Name, ast.Attribute)):
                    member = dec.id if isinstance(dec, ast.Name) else dec.attr
                    receiver = None if isinstance(dec, ast.Name) else _receiver_text(dec.value, code)
                    bare.append(
                        CallSite(
                            start_line=dec.lineno,
                            member=member,
                            receiver=receiver,
                            query_line=dec.end_lineno or dec.lineno,
                            query_col=(dec.end_col_offset or 1) - 1,
                            shape="decoratorBare",
                            is_decorator=True,
                            receiver_is_annotated_param=False,
                            enclosing_has_return_annotation=False,
                            is_super_call=False,
                            receiver_is_union=False,
                        )
                    )

    sites: list[CallSite] = list(bare)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute):
            member, receiver_node = func.attr, func.value
            receiver = _receiver_text(receiver_node, code)
            shape = "subscriptCall" if isinstance(receiver_node, ast.Subscript) else "call"
            is_super = isinstance(receiver_node, ast.Call) and isinstance(receiver_node.func, ast.Name) and receiver_node.func.id == "super"
        elif isinstance(func, ast.Name):
            member, receiver, shape, is_super = func.id, None, "call", False
        elif isinstance(func, ast.Subscript):
            continue  # the walker emits these through `dispatch`, which the host skips
        else:
            continue
        root = receiver.split(".")[0] if receiver else ""
        sites.append(
            CallSite(
                start_line=node.lineno,
                member=member,
                receiver=receiver,
                query_line=func.end_lineno or node.lineno,
                query_col=(func.end_col_offset or 1) - 1,
                shape=shape,
                is_decorator=id(node) in decorator_nodes,
                receiver_is_annotated_param=root in annotated_params,
                enclosing_has_return_annotation=any(returns_annotated.values()),
                is_super_call=is_super,
                receiver_is_union=root in union_params,
            )
        )
    sites.sort(key=lambda s: (s.query_line, s.query_col, s.member))
    return sites


UNLOCATED_LOOKAHEAD = 10


def match_site(record: dict[str, Any], sites: list[CallSite]) -> tuple[CallSite | None, str | None]:
    """Find the AST node a host record names, or say why it could not be found.

    `CallRef` carries no column, so the match is `(startLine, member)` with the
    receiver text as the tie-break. An unmatched record is reported BY SHAPE and
    never as one opaque number: the TS wave's `nodeNotLocated` bucket hid three
    distinct defects behind a single count until it was decomposed this way.
    """
    line, member = record["startLine"], record["member"]
    receiver = record.get("receiver")
    same_line = [s for s in sites if s.start_line == line and s.member == member]
    if len(same_line) == 1:
        return same_line[0], None
    if same_line:
        exact = [s for s in same_line if s.receiver == receiver]
        return (exact[0] if exact else same_line[0]), None

    if any(s.member == member and s.shape == "decoratorBare" for s in sites):
        return None, "decoratorBare"
    if any(s.member == member and line < s.start_line <= line + UNLOCATED_LOOKAHEAD for s in sites):
        return None, "multiLineCall"
    if any(s.member == member and s.shape == "subscriptCall" for s in sites):
        return None, "subscriptCall"
    return None, "coordinateMiss"


def query_site(script: jedi.Script, site: CallSite, corpus_root: Path) -> dict[str, Any]:
    """jedi's answer for one site: `goto`, then `infer` when `goto` says nothing.

    `follow_builtin_imports=False` keeps a builtin from being followed into C
    source that does not exist as Python — the answer wanted there is "builtin",
    which `module_path is None` already expresses.
    """
    try:
        names = script.goto(
            site.query_line, site.query_col, follow_imports=True, follow_builtin_imports=False
        )
        if not names:
            names = script.infer(site.query_line, site.query_col)
    except Exception:  # jedi raises a wide family on degraded parses; a failure is "unknown"
        return {"kind": "unknown"}
    if not names:
        return {"kind": "unknown"}

    targets: list[dict[str, Any]] = []
    origins: list[str] = []
    for name in names:
        module_path = name.module_path
        origin = classify_origin(module_path, corpus_root)
        origins.append(origin)
        if origin not in IN_PROJECT_ORIGINS or module_path is None:
            continue
        def_line = name.line or 0
        symbol_id, def_node_kind, uncertain = compose_symbol_id(module_path, def_line)
        targets.append(
            {
                "relPath": module_path.resolve().relative_to(corpus_root).as_posix(),
                "symbolId": symbol_id,
                "defLine": def_line,
                "defKind": name.type or def_node_kind,
                # jedi's own `name.type` is almost always truthy, so `defKind`
                # above is jedi's word and the composer's is invisible in it.
                # The host needs the composer's, unmasked: `nonCallable` there
                # is what says the target is an assignment (z796g).
                "defNodeKind": def_node_kind,
                "pinUncertain": uncertain,
            }
        )
    if targets:
        targets.sort(key=lambda t: (t["relPath"], t["defLine"]))
        in_project = [o for o in origins if o in IN_PROJECT_ORIGINS]
        return {"kind": "inProject", "origin": in_project[0], "targets": targets}
    return {"kind": "external", "origin": origins[0]}


def order_roots(declared: list[str], file_path: Path | None) -> list[str]:
    """Declared roots, the one CONTAINING the file first.

    One global order cannot be right for a corpus that owns two packages of the
    same name, and polar owns three: `server/polar`, `sdk/python/polar` and the
    `polar` its venv installs from the `polar_sdk` distribution. With `server`
    declared alone, every caller under `sdk/python` reached the INSTALLED copy —
    4,999 sites answered `sitePackages` against 448 answered `project`, and the
    chain's correct in-repo answers were scored phantom (vua9f). Declaring both
    roots is not enough on its own: measured on
    `sdk/python/polar/v2026_04/services/benefits.py:111`, the order
    `[server, sdk/python]` still answers site-packages and `[sdk/python, server]`
    answers the repo.

    So the file decides. The declared order survives as the tie-break for a file
    under NO root — it is the corpus's own statement of search preference — and
    the DEEPEST containing root wins when roots nest, because the narrower one
    is the more specific claim. Containment is tested on the separator boundary:
    `server` must not swallow `server-tools`.
    """
    if file_path is None:
        return list(declared)
    text = file_path.resolve().as_posix()
    containing = [root for root in declared if text.startswith(root.rstrip("/") + "/")]
    if not containing:
        return list(declared)
    innermost = max(containing, key=len)
    return [innermost, *[root for root in declared if root != innermost]]


def build_sys_path(
    corpus_root: Path,
    roots: list[str],
    env_sys_path: list[str],
    file_path: Path | None = None,
) -> list[str]:
    """The order jedi searches modules in: the corpus's OWN roots, then the venv.

    Left to itself jedi orders `[project path] + environment sys path + script
    parent dirs`, so a corpus that keeps its sources under a source root —
    polar's `server`, flask's `src`, netbox's `netbox` — is only reachable
    through that parent-dir TAIL, i.e. after site-packages. polar installs a
    `polar_sdk` distribution whose top-level module is also called `polar`, so
    every `from polar.… import …` inside `server/polar` resolved to the
    installed package or to nothing at all, and 1,610 rows were scored phantom
    against a chain that had answered correctly (7dsyq).

    Declared roots may be absolute (what the host sends) or relative to the
    corpus; `Path.__truediv__` accepts both. An undeclared corpus keeps jedi's
    own behaviour by falling back to the root itself. `''` is dropped exactly as
    `Project._get_base_sys_path` drops it — it means "the launcher's cwd", which
    here is the harness, never the corpus.

    `file_path` is the file about to be answered, and `order_roots` owns what it
    changes. Absent, the declared order stands — which is what the host sent
    before vua9f and what a single-root corpus reduces to either way.
    """
    declared = [str((corpus_root / entry).resolve()) for entry in roots] or [str(corpus_root)]
    ordered: list[str] = []
    for entry in [*order_roots(declared, file_path), *env_sys_path]:
        if entry and entry not in ordered:
            ordered.append(entry)
    return ordered


def init_worker(corpus_root: str, venv_python: str | None, roots: list[str] | None = None) -> None:
    root = Path(corpus_root).resolve()
    _STATE["corpus_root"] = root
    _STATE["venv"] = venv_python
    _STATE["roots"] = list(roots or [])
    # `jedi.Project(root, environment=...)` raises TypeError on 0.20.0. This one
    # exists only to reach the corpus environment — its sys path, which every
    # per-ordering Project is handed EXPLICITLY because jedi consults the
    # environment only when `sys_path` is None, and the Environment OBJECT,
    # which they reuse.
    base = (
        jedi.Project(path=str(root), environment_path=venv_python)
        if venv_python
        else jedi.Project(path=str(root))
    )
    _STATE["environment"] = base.get_environment()
    _STATE["env_sys_path"] = list(_STATE["environment"].get_sys_path())
    _STATE["projects"] = {}
    _STATE["grammar"] = parso.load_grammar()


def project_for(file_path: Path) -> jedi.Project:
    """The Project whose sys path leads with `file_path`'s own source root.

    Cached by the ORDERING, not by the file: a corpus needs one Project per
    declared root plus one for the files under none of them — three for polar,
    one for every single-root corpus, which is the shape every earlier baseline
    ran under. Per-file construction would be worse than wasteful: each Project
    resolving `environment_path` starts its own interpreter subprocess, so the
    environment is carried over from the worker's first Project instead
    (`jedi.Project` accepts no `environment` argument, only a path to one).
    """
    sys_path = build_sys_path(_STATE["corpus_root"], _STATE["roots"], _STATE["env_sys_path"], file_path)
    key = tuple(sys_path)
    cached = _STATE["projects"].get(key)
    if cached is not None:
        return cached
    root, venv = str(_STATE["corpus_root"]), _STATE["venv"]
    project = (
        jedi.Project(path=root, environment_path=venv, sys_path=sys_path)
        if venv
        else jedi.Project(path=root, sys_path=sys_path)
    )
    project._environment = _STATE["environment"]
    _STATE["projects"][key] = project
    return project


def answer_file(batch: dict[str, Any]) -> dict[str, Any]:
    """One file: parse, enumerate, one `jedi.Script`, one answer per host record."""
    rel_path = batch["relPath"]
    root: Path = _STATE["corpus_root"]
    absolute = root / rel_path
    try:
        code = absolute.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {"relPath": rel_path, "parseFailed": True, "parsoErrors": 0, "answers": []}

    # Two independent parses on purpose. `ast.parse` is the ORACLE's own ability
    # to read the file — its failure means there is no ground truth at all.
    # parso is JEDI's parser, and it never raises: it returns error nodes, so the
    # only way to see that jedi is working from a damaged tree is to count them.
    parso_errors = 0
    try:
        parso_errors = len(list(_STATE["grammar"].iter_errors(_STATE["grammar"].parse(code))))
    except Exception:
        parso_errors = 0
    try:
        tree = ast.parse(code)
    except (SyntaxError, ValueError):
        return {
            "relPath": rel_path,
            "parseFailed": True,
            "parsoErrors": parso_errors,
            "answers": [
                {"startLine": r["startLine"], "member": r["member"], "outcome": {"kind": "parseFailed"}}
                for r in batch["sites"]
            ],
        }

    sites = enumerate_call_sites(tree, code)
    script = jedi.Script(code, path=str(absolute), project=project_for(absolute))
    answers: list[dict[str, Any]] = []
    for record in batch["sites"]:
        site, unlocated = match_site(record, sites)
        if site is None:
            answers.append(
                {
                    "startLine": record["startLine"],
                    "member": record["member"],
                    "outcome": {"kind": "unknown"},
                    "unlocated": unlocated,
                }
            )
            continue
        outcome = query_site(script, site, root)
        targets = outcome.get("targets") or []
        answers.append(
            {
                "startLine": record["startLine"],
                "member": record["member"],
                "outcome": outcome,
                "siteFacts": {
                    "receiverIsAnnotatedParam": site.receiver_is_annotated_param,
                    "enclosingHasReturnAnnotation": site.enclosing_has_return_annotation,
                    "viaReexport": any(t["relPath"].endswith("/__init__.py") for t in targets),
                    "viaStarImport": False,
                    "isSuperCall": site.is_super_call,
                    "targetIsProperty": any(t["defKind"] == "property" for t in targets),
                    "targetIsStaticOrClassMethod": any(
                        t["symbolId"] is not None and "." in (t["symbolId"] or "") for t in targets
                    ),
                    "receiverIsUnion": site.receiver_is_union,
                    "isDecoratorSite": site.is_decorator,
                },
            }
        )
    return {"relPath": rel_path, "parseFailed": False, "parsoErrors": parso_errors, "answers": answers}


def answer_group(batches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One worker's whole share, answered in a fixed order inside one process."""
    return [answer_file(batch) for batch in batches]


def read_batches(stream: Any) -> Iterator[dict[str, Any]]:
    for line in stream:
        line = line.strip()
        if line:
            yield json.loads(line)


def main() -> int:
    batches = read_batches(sys.stdin)
    config = next(batches)
    if config.get("kind") != "config":
        sys.stderr.write("first stdin line must be the config record\n")
        return 2
    corpus_root, venv = config["corpusRoot"], config.get("venvPython") or None
    # Absent `roots` is not an error: a host that predates 7dsyq, and the fixture
    # corpus, both have no source root, and `build_sys_path` falls back to the
    # corpus root — which is what jedi would have used anyway.
    roots = list(config.get("roots") or [])
    files = [b for b in batches if b.get("kind") == "file"]
    workers = max(1, min(int(config.get("workers", 1)), len(files) or 1))

    if workers == 1:
        init_worker(corpus_root, venv, roots)
        results = (answer_file(batch) for batch in files)
    else:
        # Determinism needs a FIXED file -> process assignment, not just a fixed
        # output order. jedi's per-process module cache makes one file's answer
        # depend on what that process parsed before it, and `imap(chunksize=4)`
        # hands chunks out as workers free up — which run to run moved a flask
        # site between `external` and `unknown`. A striped partition plus
        # `maxtasksperchild=1` gives every process exactly one group, the same
        # files in the same order, every run. The host keys replies by relPath,
        # so emitting group by group costs nothing.
        groups = [files[index::workers] for index in range(workers)]
        pool = mp.get_context("fork").Pool(workers, init_worker, (corpus_root, venv, roots), maxtasksperchild=1)
        results = (answer for group in pool.imap(answer_group, groups) for answer in group)

    for result in results:
        sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
