"""The oracle's symbolId spelling, hop by hop, against the walker's rule (w205u).

    uv run --no-project --python 3.13 --with jedi==0.20.0 \\
        python scripts/py-oracle/test_compose_symbol_id.py

Plain `unittest`, no pytest, so `tests/scripts/py-compose-symbol-id.test.ts` can
spawn it under the same interpreter the fixture harness already uses.

Why a dedicated file. `compose_symbol_id` used to join the WHOLE enclosing scope
with `"."` and choose a separator only for the LAST hop, so a def nested in a
method read `Blueprint._merge_blueprint_funcs#extend` where the walker composes
`Blueprint#_merge_blueprint_funcs#extend`. Nothing about the TARGET was wrong —
same file, same line — only the spelling, and the host compares symbolIds as
strings, so 38 rows across flask / httpx / netbox / polar were booked `fileOnly`
instead of `match`. Separator-only artefacts are invisible in a per-file check,
which is why they survived the fixture corpus: every def there is one hop deep.

The expectations below are MEASURED off the walker
(`src/core/domains/language/python/walker/name-of.ts` +
`domains/language/kernel/collect-symbols.ts` + `DefaultSymbolIdComposer`) on the
same source, not reasoned about. The walker is the source of truth; when it
moves, this file is updated to whatever it now emits.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from jedi_oracle import compose_symbol_id  # noqa: E402

# Every nesting shape Python can build a def out of, in one file so the line
# numbers below can be read straight off it.
SHAPES = '''\
def module_level():
    def inner():
        pass
    return inner


class Cls:
    def method(self):
        def nested():
            pass
        return nested

    @staticmethod
    def static_m():
        pass

    @classmethod
    def class_m(cls):
        pass

    @property
    def prop(self):
        return 1

    class Inner:
        def inner_method(self):
            def deep():
                pass
            return deep

        @staticmethod
        def inner_static():
            pass


async def amod():
    async def ainner():
        pass


def outer_holding_a_class():
    class Local:
        def local_method(self):
            pass

    return Local
'''

# `(def line, symbolId, defNodeKind)`, verbatim from the walker's own output for
# `SHAPES` — see the module docstring for how it was read.
EXPECTED = [
    (1, "module_level", "function"),
    (2, "module_level#inner", "function"),
    (7, "Cls", "class"),
    (8, "Cls#method", "function"),
    (9, "Cls#method#nested", "function"),
    (14, "Cls.static_m", "function"),
    (18, "Cls.class_m", "function"),
    (22, "Cls#prop", "function"),
    (25, "Cls.Inner", "class"),
    (26, "Cls.Inner#inner_method", "function"),
    (27, "Cls.Inner#inner_method#deep", "function"),
    (32, "Cls.Inner.inner_static", "function"),
    (36, "amod", "function"),
    (37, "amod#ainner", "function"),
    (41, "outer_holding_a_class", "function"),
    (42, "outer_holding_a_class.Local", "class"),
    (43, "outer_holding_a_class.Local#local_method", "function"),
]


class ComposeSymbolIdTest(unittest.TestCase):
    shapes_path: Path
    _tmp: tempfile.TemporaryDirectory[str]

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        cls.shapes_path = Path(cls._tmp.name) / "shapes.py"
        cls.shapes_path.write_text(SHAPES, encoding="utf-8")

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def test_every_hop_is_spelled_the_way_the_walker_spells_it(self) -> None:
        for line, symbol_id, kind in EXPECTED:
            with self.subTest(line=line, symbolId=symbol_id):
                self.assertEqual(
                    compose_symbol_id(self.shapes_path, line),
                    (symbol_id, kind, False),
                )

    def test_a_def_nested_in_a_method_keeps_the_hash_of_the_hop_above_it(self) -> None:
        # The 38-row defect, minimised: the middle hop is a METHOD, and joining
        # the scope with "." spelled it `Cls.method#nested`.
        composed, _, _ = compose_symbol_id(self.shapes_path, 9)
        self.assertEqual(composed, "Cls#method#nested")
        self.assertNotIn("Cls.method", composed or "")

    def test_a_line_no_definition_starts_on_is_still_nonCallable(self) -> None:
        # Line 3 is a `pass` inside `inner`. The spelling change must not move
        # the bucket a non-definition lands in (z796g).
        self.assertEqual(compose_symbol_id(self.shapes_path, 3), (None, "nonCallable", True))

    def test_an_unreadable_target_is_still_unknown(self) -> None:
        missing = self.shapes_path.parent / "does_not_exist.py"
        self.assertEqual(compose_symbol_id(missing, 1), (None, "unknown", True))


if __name__ == "__main__":
    unittest.main(verbosity=2)
