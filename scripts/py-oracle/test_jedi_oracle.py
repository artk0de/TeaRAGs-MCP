"""Unit tests for the two ORDER-SENSITIVE pure functions (bd tea-rags-mcp-7dsyq).

    uv run --no-project --python 3.13 --with jedi==0.20.0 --with pytest \\
        python -m pytest scripts/py-oracle/test_jedi_oracle.py -q

Everything jedi actually ANSWERS is asserted end to end against the fixture
corpus in `tests/scripts/jedi-oracle-spawn.test.ts`; a unit test of `query_site`
would be a test of a mock. What lives here is the two functions whose CLAUSE
ORDER is the whole behaviour, exercised on synthetic paths.

`build_sys_path` is unit-tested rather than driven through jedi because the
defect it fixes needs a site-packages distribution whose top-level module
collides with a corpus package (polar's `polar_sdk` shadowing `server/polar`),
and installing one into a fixture would make the suite depend on a package
index. The ordering the function produces is asserted here; that jedi honours
that ordering is evidenced live on polar, recorded in the 7dsyq commit body.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from jedi_oracle import build_sys_path, classify_origin  # noqa: E402

CORPUS = Path("/corpus")


def test_no_module_path_is_a_builtin() -> None:
    assert classify_origin(None, CORPUS) == "builtin"


def test_project_module_shadowing_a_stdlib_name_stays_project() -> None:
    # netbox/utilities/string.py — jedi is right and the stem heuristic was not.
    assert classify_origin(CORPUS / "netbox/utilities/string.py", CORPUS) == "project"
    assert classify_origin(CORPUS / "sdk/generator/python/types.py", CORPUS) == "project"


def test_migrations_inside_the_corpus_are_generated() -> None:
    assert classify_origin(CORPUS / "app/migrations/0001_initial.py", CORPUS) == "generatedInRepo"


def test_site_packages_inside_the_corpus_still_win_over_containment() -> None:
    # ugnest keeps its virtualenv in its own checkout; containment must not
    # claim Django's source as project code.
    vendored = CORPUS / ".venv/lib/python3.13/site-packages/django/db/models/base.py"
    assert classify_origin(vendored, CORPUS) == "sitePackages"


def test_jedi_bundled_stubs_are_read_before_site_packages() -> None:
    stub = Path("/env/lib/python3.13/site-packages/jedi/third_party/typeshed/stdlib/os.pyi")
    assert classify_origin(stub, CORPUS) == "typeshedStub"


def test_the_stdlib_directory_is_stdlib_even_inside_the_corpus() -> None:
    assert classify_origin(CORPUS / ".venv/lib/python3.13/json/decoder.py", CORPUS) == "stdlib"


def test_the_stem_heuristic_still_applies_outside_the_corpus() -> None:
    assert classify_origin(Path("/elsewhere/string.py"), CORPUS) == "stdlib"
    assert classify_origin(Path("/elsewhere/helpers.py"), CORPUS) == "outsideRepo"


def test_declared_roots_come_before_the_environment() -> None:
    ordered = build_sys_path(CORPUS, ["server"], ["/env/site-packages", "/env/lib"])
    assert ordered == ["/corpus/server", "/env/site-packages", "/env/lib"]


def test_absolute_roots_are_taken_as_given() -> None:
    ordered = build_sys_path(CORPUS, ["/corpus/src"], ["/env/site-packages"])
    assert ordered == ["/corpus/src", "/env/site-packages"]


def test_an_undeclared_corpus_falls_back_to_its_root() -> None:
    assert build_sys_path(CORPUS, [], ["/env/site-packages"]) == ["/corpus", "/env/site-packages"]


def test_the_empty_entry_and_duplicates_are_dropped() -> None:
    # `''` means the LAUNCHER's cwd, which is the harness, never the corpus —
    # `Project._get_base_sys_path` drops it for the same reason.
    ordered = build_sys_path(CORPUS, ["."], ["", "/corpus", "/env/site-packages", "/env/site-packages"])
    assert ordered == ["/corpus", "/env/site-packages"]


def test_the_containing_root_is_searched_first() -> None:
    # polar owns two packages called `polar`: `server/polar` and
    # `sdk/python/polar`. One global order is wrong for one of them by
    # construction, so the root CONTAINING the file leads.
    ordered = build_sys_path(
        CORPUS,
        ["server", "sdk/python"],
        ["/env/site-packages"],
        CORPUS / "sdk/python/polar/v2026_04/services/benefits.py",
    )
    assert ordered == ["/corpus/sdk/python", "/corpus/server", "/env/site-packages"]


def test_a_file_under_no_declared_root_keeps_the_declared_order() -> None:
    ordered = build_sys_path(
        CORPUS, ["server", "sdk/python"], ["/env/site-packages"], CORPUS / "docs/conf.py"
    )
    assert ordered == ["/corpus/server", "/corpus/sdk/python", "/env/site-packages"]


def test_the_deepest_containing_root_wins_when_roots_nest() -> None:
    ordered = build_sys_path(
        CORPUS, ["sdk", "sdk/python"], ["/env"], CORPUS / "sdk/python/polar/base.py"
    )
    assert ordered == ["/corpus/sdk/python", "/corpus/sdk", "/env"]


def test_a_root_is_not_claimed_by_a_sibling_it_only_prefixes() -> None:
    # `/corpus/server` must not swallow `/corpus/server-tools/app.py`.
    ordered = build_sys_path(CORPUS, ["server", "sdk"], ["/env"], CORPUS / "server-tools/app.py")
    assert ordered == ["/corpus/server", "/corpus/sdk", "/env"]


def test_the_reordering_still_dedupes_and_drops_the_empty_entry() -> None:
    ordered = build_sys_path(
        CORPUS,
        ["server", "sdk/python", "sdk/python"],
        ["", "/corpus/server", "/env"],
        CORPUS / "sdk/python/polar/base.py",
    )
    assert ordered == ["/corpus/sdk/python", "/corpus/server", "/env"]


def test_the_file_is_optional_and_absent_means_the_declared_order() -> None:
    assert build_sys_path(CORPUS, ["server", "sdk"], ["/env"]) == [
        "/corpus/server",
        "/corpus/sdk",
        "/env",
    ]
