#!/usr/bin/env python3
"""SPIKE (bd tea-rags-mcp-w205u, E4.0.1) — list parso-degraded corpus files.

Every file under a corpus root whose parso 0.8.7 parse carries error nodes.
That set IS the `oracleDegraded` population the second oracle has to answer;
jedi reads those files from a damaged tree. parso is asked directly rather than
inferred from a row dump, because parso is the oracle's own dependency.
"""

import sys
from pathlib import Path

import parso


def main() -> int:
    root = Path(sys.argv[1]).resolve()
    roots = [root / entry for entry in sys.argv[2:]] or [root]
    grammar = parso.load_grammar()
    for base in roots:
        for path in sorted(base.rglob("*.py")):
            text = path.as_posix()
            if "/site-packages/" in text or "/.venv/" in text or "/node_modules/" in text:
                continue
            code = path.read_text(encoding="utf-8", errors="replace")
            errors = len(list(grammar.iter_errors(grammar.parse(code))))
            if errors:
                print(f"{path.relative_to(root).as_posix()}\t{errors}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
