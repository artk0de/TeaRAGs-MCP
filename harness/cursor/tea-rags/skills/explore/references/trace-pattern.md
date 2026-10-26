# TRACE Pattern

Backward / forward symbol tracing without codegraph (codegraph on →
usage-pattern wins).

- **"What calls X?" (backward)** → iterative hybrid_search: X → note callers →
  hybrid_search each caller → repeat until entry point or 3 levels. Present
  chain `A → B → C → X`.
- **"What does X call?" / "What does X depend on?" (forward)** → two levels,
  both from find_symbol:
  1. **File-level:** find_symbol X → chunk payload `imports[]` = file
     dependencies.
  2. **Method-level:** same result's body → called methods → find_symbol each →
     up to 3 levels. Present file deps flat, method calls as tree:
     `X → { Y.method(), Z.method() } → { ... }`.

Citations `file:line`. Quote 3-5 lines, don't dump functions.
