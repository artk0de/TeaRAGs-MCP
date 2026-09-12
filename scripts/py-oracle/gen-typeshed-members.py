#!/usr/bin/env python3
"""Generate `python/vocabulary/typeshed-members.ts` (bd tea-rags-mcp-w205u.14).

Every method and attribute name declared in a `class` body across typeshed's
stdlib stubs, plus the third-party stubs pyright bundles for the libraries the
corpora actually import. Dunders excluded — `__init__` is never the member of an
unresolved call site.

The set is the untyped-name fan's DECLINE vocabulary: a member the typeshed
classes declare is, on an untyped receiver, far likelier a stdlib or framework
call than a project one. E4.1.3 measured the fan without it and booked 85
fabricated edges against 83 matches, most of them `.get` / `.append` / `.filter`
/ `.save` — names typeshed owns.

Typeshed ships INSIDE pyright, so the version stamp in the header is pyright's
plus the typeshed commit it vendored. Fetch it once:

    npx --yes --package pyright@1.1.414 node -e \\
        "console.log(require.resolve('pyright/package.json'))"

then point this script at the `dist/typeshed-fallback` directory next to it:

    python3 scripts/py-oracle/gen-typeshed-members.py --typeshed <pyright>/dist/typeshed-fallback \\
        > src/core/domains/language/python/vocabulary/typeshed-members.ts

Run it explicitly when the pyright pin moves; the output is committed, and
nothing in the build regenerates it.
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Iterable, Iterator

# Third-party stubs to fold in. Of the libraries the five measurement corpora
# import, pyright 1.1.414 bundles ONLY `requests` — sqlalchemy, jinja2,
# structlog, redis and django all ship their types inline or in a separate
# stubs package, so typeshed has nothing for them here.
THIRD_PARTY_STUBS = ("requests",)

# Modules whose members are kept unconditionally when the size rule trims.
CORE_MODULES = frozenset(
    {
        "builtins",
        "collections",
        "typing",
        "io",
        "os",
        "re",
        "json",
        "datetime",
        "pathlib",
        "subprocess",
        "logging",
        "threading",
        "asyncio",
        "dataclasses",
        "enum",
    }
)

# Above this the set stops being a vocabulary and starts being a dictionary:
# every name it holds is a recall hole on a project member of the same spelling.
SIZE_BUDGET = 6000


def declared_members(body: Iterable[ast.stmt]) -> Iterator[str]:
    """Names a class body declares DIRECTLY, descending through the version
    guards typeshed writes (`if sys.version_info >= (3, 12):`) but never into a
    nested class — `ast.walk` visits that one on its own."""
    for node in body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            yield node.name
        elif isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name):
                yield node.target.id
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    yield target.id
        elif isinstance(node, ast.If):
            yield from declared_members(node.body)
            yield from declared_members(node.orelse)
        elif isinstance(node, ast.Try):
            yield from declared_members(node.body)
            yield from declared_members(node.orelse)
            yield from declared_members(node.finalbody)
            for handler in node.handlers:
                yield from declared_members(handler.body)


def top_module(path: Path, root: Path) -> str:
    head = path.relative_to(root).parts[0]
    return head[:-4] if head.endswith(".pyi") else head


def scan(
    root: Path,
    owners: dict[str, set[str]],
    modules: dict[str, set[str]],
) -> None:
    for path in sorted(root.rglob("*.pyi")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        module = top_module(path, root)
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            owner = f"{path}::{node.name}@{node.lineno}"
            for name in declared_members(node.body):
                if name.startswith("__") and name.endswith("__"):
                    continue
                owners[name].add(owner)
                modules[name].add(module)


def pyright_version(typeshed: Path) -> str:
    manifest = typeshed.parent.parent / "package.json"
    if not manifest.is_file():
        return "unknown"
    return str(json.loads(manifest.read_text(encoding="utf-8")).get("version", "unknown"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--typeshed", required=True, type=Path, help="pyright's dist/typeshed-fallback directory")
    args = parser.parse_args()

    typeshed: Path = args.typeshed
    owners: dict[str, set[str]] = defaultdict(set)
    modules: dict[str, set[str]] = defaultdict(set)

    scan(typeshed / "stdlib", owners, modules)
    bundled = [name for name in THIRD_PARTY_STUBS if (typeshed / "stubs" / name).is_dir()]
    for name in bundled:
        scan(typeshed / "stubs" / name, owners, modules)

    raw = set(owners)
    if len(raw) > SIZE_BUDGET:
        kept = {
            name
            for name in raw
            if len(owners[name]) >= 2 or (modules[name] & CORE_MODULES) or name in bundled_members(modules, bundled)
        }
        rule = f"kept {len(kept)} of {len(raw)}: declared by >= 2 classes, or by a core module / bundled stub"
    else:
        kept = raw
        rule = f"kept all {len(raw)} names — under the {SIZE_BUDGET} budget"

    print(f"[gen-typeshed-members] {rule}", file=sys.stderr)

    commit = (typeshed / "commit.txt").read_text(encoding="utf-8").strip()
    version = pyright_version(typeshed)
    sources = ", ".join(["stdlib", *bundled])
    body = ",\n  ".join(f'"{name}"' for name in sorted(kept))
    sys.stdout.write(
        "/**\n"
        " * Member names typeshed declares on a class — the untyped-name fan's DECLINE\n"
        " * vocabulary (bd tea-rags-mcp-w205u.14).\n"
        " *\n"
        f" * Sources: typeshed {sources} stubs, as vendored by pyright {version}\n"
        f" * (typeshed commit {commit}). Dunders excluded.\n"
        " *\n"
        " * GENERATED by `scripts/py-oracle/gen-typeshed-members.py`. Do not edit by hand;\n"
        " * re-run the generator when the pyright pin in its header moves.\n"
        " *\n"
        " * A frozen module-level Set: it is consulted once per untyped call the fan\n"
        " * would otherwise answer, so this must be a hash lookup and never a scan.\n"
        " */\n"
        "export const PYTHON_TYPESHED_MEMBERS: ReadonlySet<string> = new Set([\n"
        f"  {body},\n"
        "]);\n"
    )
    return 0


def bundled_members(modules: dict[str, set[str]], bundled: list[str]) -> set[str]:
    wanted = set(bundled)
    return {name for name, mods in modules.items() if mods & wanted}


if __name__ == "__main__":
    raise SystemExit(main())
