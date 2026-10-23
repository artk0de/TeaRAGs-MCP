# TRACE Pattern

Sub-patterns for backward and forward symbol tracing.

- **"What calls X?" (backward trace)** → iterative hybrid_search. Start:
  hybrid_search for X → note callers from results → hybrid_search for each
  caller → repeat until entry point or 3 levels deep. Present as chain:
  `A → B → C → X`.
- **"What does X call?" / "What does X depend on?" (forward trace)** → two
  levels of resolution, both from find_symbol (instant, no embedding):
  1. **File-level:** find_symbol for X → chunk payload has `imports[]` array
     showing all file dependencies. This is the dependency graph.
  2. **Method-level:** from the same find_symbol result, read the method body →
     note called methods → find_symbol for each → repeat up to 3 levels. Present
     both: file deps as flat list, method calls as tree:
     `X → { Y.method(), Z.method() } → { ... }`.

Code citations: `file:line`. Quote 3-5 relevant lines, don't dump functions.
