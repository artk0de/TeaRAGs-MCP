# EXEMPLAR Pattern

Used for "best example of X", "antipatterns in Y", "canonical implementation"
intents — surfaces reference implementations or anti-patterns from the existing
corpus.

EXEMPLAR is a delegation pattern: explore does NOT search itself — it dispatches
to a specialized skill that handles search, output, and formatting end-to-end.

## Routing

The Step 0 keyword classifier picks Antipattern or Reference (see SKILL.md
intent table). After the match:

- **Antipattern + broad scope (no specific entity)** → read and follow
  `refactoring-scan/SKILL.md`
- **All other matches** (Antipattern with named entity, Reference, Collect,
  Spread) → read and follow `pattern-search/SKILL.md`

## Rules

- Delegated skill handles everything — search, output, formatting.
- Do NOT search yourself before or after delegating.
- Do NOT add an explore-style EXPLAIN summary on top of the delegated output.

## Direct-input shortcut

If the user provides a **code snippet or chunk** (not a question) → skip BREADTH
entirely. Go straight to find_similar with the code as input, then EXPLAIN
similarities. This is the EXEMPLAR fast path for "find more like this".
