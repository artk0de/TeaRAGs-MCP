# USAGE Pattern

Caller / callee intents answered with `get_callers` / `get_callees` edge truth
(actual call edges from the codegraph DuckDB) instead of content matching.
Higher precision than `hybrid_search` for "who calls X" — no false hits on
comments, strings, or same-named-but-unrelated symbols.

## Step 1 — resolve the exact symbolId (MANDATORY)

`get_callers` / `get_callees` match on an exact symbol id and fail silently
(empty result) on a wrong one. Always resolve first:

`find_symbol symbol=<name>` → pick the exact id. Convention: `Class#method`
(instance), `Class.method` (static), `functionName` (top-level). A bare
`find_symbol symbol=Foo` returns the class and all members — choose the precise
member before calling get_callers/get_callees.

## Step 2 — route by direction

- **"Who uses X?" / "who calls X?" / "callers of X"** →
  `get_callers symbolId=<id>`. Returns the invoking symbols with
  `call_expression` preview + `file:line`.
- **"What does X call?" / "callees of X" / "what does X use"** →
  `get_callees symbolId=<id>`. Returns invoked symbols + `file:line`.

## Step 3 — multi-hop trace ("trace flow X → Y")

Iterative `get_callees` walk from X, **depth cap 3**, with a cycle guard (track
visited symbol ids; never re-expand one). Stop on the first hop whose callee
matches Y, or when depth is exhausted. Present the path:
`X → A.run() → B.help() → Y`. If Y is never reached within depth 3, say so and
show the frontier explored — do NOT silently widen the depth.

## Output

Caller/callee list with the `call_expression` preview and `file:line` refs.
Quote the call site, don't dump the whole calling function.

This pattern WINS over the TRACE pattern for usage queries when codegraph is
available — TRACE's `hybrid_search` / `imports[]` route is the fallback when the
project has no codegraph index (prime shows no `codegraph.symbols`, so
`get_callers` / `get_callees` are not registered, not returning empty). Check
prime first; don't call an absent tool to discover it is missing.
