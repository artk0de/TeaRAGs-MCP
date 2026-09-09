"""Stdlib, builtin and third-party receivers — the external denominator."""

import json
import os.path

import jedi


def dump(payload: dict[str, str]) -> str:
    return json.dumps(payload)


def join_here(name: str) -> str:
    return os.path.join(os.path.dirname(__file__), name)


def probe(source: str) -> int:
    return len(jedi.Script(source).get_names())
