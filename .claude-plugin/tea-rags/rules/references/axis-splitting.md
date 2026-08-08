# Axis Splitting Rule (sources / tests / docs)

**Applies when:** broad exploration — target is system / domain / directory, not
a named symbol.

**Problem:** Unfiltered broad search mixes three content classes in one result
limit. Dominant class takes all slots — same failure `polyglot-rule.md` fixes
for languages. Docs-heavy area drowns sources; test-heavy area drowns both.

**Axis roles (fixed vocabulary):**

| Axis    | Filter                                          | Role                                                        |
| ------- | ----------------------------------------------- | ----------------------------------------------------------- |
| sources | `testFile: "exclude", documentation: "exclude"` | **behavior truth** — only evidence of what code DOES        |
| tests   | `testFile: "only"`                              | **executable spec** — SHOULD do; intent proven by execution |
| docs    | `documentation: "only"`                         | **hypothesis / navigation** — why; claims need code check   |

**Rule:** broad exploration issues per-axis calls, sources FIRST. Tests axis
when question concerns expected behavior / contracts. Docs axis for intent,
rationale, ADRs — never as sole evidence of behavior.

```text
Target = named symbol / narrow question?
├─ Yes → NO split. Axis implied by question
│   ("is X tested" → tests; "what does X do" → sources).
│
└─ No (system / domain / directory)
   ├─ 1. sources: testFile:"exclude" documentation:"exclude" — behavior map
   ├─ 2. tests (behavior/contract questions): testFile:"only" — expected behavior
   └─ 3. docs (intent/rationale questions): documentation:"only" — the "why"
```

**Conflict resolution:**

- docs ↔ code → code wins; flag drift explicitly ("docs say X, code does Y").
  See search-cascade "Code is evidence, docs are hypothesis".
- tests ↔ src → report BOTH facts (test may pin desired behavior, src the
  actual) — don't silently pick one.

**Exceptions (no split):**

- Point question about known symbol — axis implied.
- Question ABOUT docs themselves ("what does README claim") — docs are the
  subject.
- rank_chunks with pathPattern scoping a single-axis directory (e.g.
  `**/tests/**`).

Composes with `polyglot-rule.md`: polyglot codebase + broad exploration → split
per language WITHIN the sources axis; tests/docs axes usually language-uniform,
split only when result languages skew.
