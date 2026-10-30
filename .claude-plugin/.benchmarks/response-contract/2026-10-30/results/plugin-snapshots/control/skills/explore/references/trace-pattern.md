# TRACE Pattern

Backward / forward symbol tracing without codegraph (codegraph on →
usage-pattern wins).

- Reuse retained ids and bodies. Traverse only the depth the question needs;
  there is no minimum number of calls or requirement to reach an entry point.
- **"What calls X?" (backward)** → exact-name occurrence search (filenames
  first) and needed enclosing bodies. Follow the callers' callers only for a
  requested chain; present it as content-inferred, not a static graph proof.
- **"What does X call?" / "What does X depend on?" (forward)** → two levels,
  both from find_symbol:
  1. **File-level:** find_symbol X → chunk payload `imports[]` = file
     dependencies.
  2. **Method-level:** use called methods in the held body; fetch only missing
     bodies needed to explain the requested flow, in one batch. Present file
     deps flat, method calls as tree:
     `X → { Y.method(), Z.method() } → { ... }`.

Citations `file:line`. Quote 3-5 lines, don't dump functions.
