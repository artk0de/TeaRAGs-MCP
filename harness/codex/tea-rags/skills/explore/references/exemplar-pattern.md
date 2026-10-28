# EXEMPLAR Pattern

"Best example of X", "antipatterns in Y", "canonical implementation" → reference
implementations or anti-patterns from corpus.

Delegation pattern: explore does NOT search — dispatches to specialized skill
that owns search, output, formatting end-to-end.

## Routing

Step 0 keyword classifier picks group (SKILL.md keyword table). Then:

- **Antipattern + broad scope (no specific entity, no named pattern —
  "antipatterns in src/")** → read + follow `refactoring-scan/SKILL.md`
- **All other matches** (Antipattern with named entity OR named pattern — "sync
  I/O in hot path", "N+1" — Reference, Collect, Spread) → read + follow
  `pattern-search/SKILL.md`

## Rules

- Delegated skill handles everything. Answer names it (`pattern-search` /
  `refactoring-scan`) + its strategy; no own `hybrid_search` plan.
- Do NOT search yourself before or after delegating.
- Do NOT add explore-style EXPLAIN summary on top.

Snippet/chunk input (not question) → SKILL.md "Direct-input intents".

## Keyword groups (pick the pattern-search strategy)

| Strategy        | Keywords (any match)                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Collect**     | all, every, each, find all, list all, enumerate, gather, all implementations, all uses, all instances, everywhere, wherever                                                  |
| **Spread**      | across, across modules, between modules, compare implementations, variations of, side by side, divergence, per module                                                        |
| **Antipattern** | antipattern, smell, debt, violation, deprecated, fragile, risky, refactor, cleanup, too complex, duplicate, decompose                                                        |
| **Reference**   | best, correct, canonical, reference implementation, cleanest, template, pattern to follow, recommended way, good example — SEED rerank `proven` preset, never custom weights |

**Exception:** "all call sites / all usages of X" names ONE symbol's usages →
TRACE / codegraph row 2 wins over generic Collect.
