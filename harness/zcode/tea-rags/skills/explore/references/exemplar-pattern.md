# EXEMPLAR Pattern

"Best example of X", "antipatterns in Y", "canonical implementation" → reference
implementations or anti-patterns from corpus.

Use only for an explicit example/template/reuse request. Explaining an existing
integration is not a request to mine exemplary implementations.

## Routing

Choose the requested outcome, not a keyword in a symbol or surrounding
discussion:

- **One suitable example** → reuse a known fitting body first. Otherwise find a
  candidate with semantic/hybrid search (`metaOnly:true`, small set such as
  `limit:5`; `proven` when quality matters). Choose an anchor, then read only
  needed methods, not containing classes. Explain its fit and stop. Similarity
  expansion is optional when the candidate does not meet the requested
  constraints.

- **Antipattern + broad scope (no specific entity, no named pattern —
  "antipatterns in src/")** → read + follow `refactoring-scan/SKILL.md`
- **Collect/Spread, comparison of reference implementations, or a named
  Antipattern** ("sync I/O in hot path", "N+1") → read + follow
  `pattern-search/SKILL.md`

## Rules

- When delegation is needed, let that selected skill own the search; reuse its
  results rather than repeating discovery before or afterwards.
- No collection, test mining or specification search merely to justify a fitting
  example.

Snippet/chunk input (not question) → SKILL.md "Direct-input intents".

## Collection keywords (only after collection/comparison is requested)

| Strategy        | Keywords (any match)                                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Collect**     | all, every, each, find all, list all, enumerate, gather, all implementations, all uses, all instances, everywhere, wherever                                     |
| **Spread**      | across, across modules, between modules, compare implementations, variations of, side by side, divergence, per module                                           |
| **Antipattern** | antipattern, smell, debt, violation, deprecated, fragile, risky, refactor, cleanup, too complex, duplicate, decompose                                           |
| **Reference**   | collect/compare reference implementations; rank candidates with `proven` when quality comparison is requested — not a requirement to expand one fitting example |

**Exception:** "all call sites / all usages of X" names ONE symbol's usages →
TRACE / codegraph row 2 wins over generic Collect.
