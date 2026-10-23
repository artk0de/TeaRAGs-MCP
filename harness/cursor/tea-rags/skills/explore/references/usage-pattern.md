# USAGE Pattern

**Codegraph off** (explicit statement or tools absent) → `find_symbol` +
`hybrid_search` name-match (no edge truth — say so); path A→B = manual chain,
"no static path tool". Never call/plan `get_callers` / `get_callees` /
`trace_path`.

Caller / callee intents via `get_callers` / `get_callees` edge truth (codegraph
call edges), not content matching. Beats `hybrid_search` for "who calls X" — no
false hits on comments, strings, same-named unrelated symbols.

## Step 1 — resolve exact symbolId (MANDATORY)

`get_callers` / `get_callees` match exact id; wrong id → silent empty. Always
resolve first: `find_symbol symbol=<name>` → pick exact id (`Class#method`
instance, `Class.method` static, `functionName` top-level). Bare
`find_symbol symbol=Foo` returns class + all members — choose precise member.

## Step 2 — route by direction

- **"Who uses X?" / "who calls X?" / "callers of X"** →
  `get_callers symbolId=<id>` → invoking symbols + `call_expression` preview +
  `file:line`.
- **"What does X call?" / "callees of X" / "what does X use"** →
  `get_callees symbolId=<id>` → invoked symbols + `file:line`.
- **"Who imports this file?" / "what does this file depend on?"** — target =
  FILE: skip Step 1, pass `relativePath=<path>` (repo-relative) instead of
  `symbolId`. `get_callers` → `importers[]`, `get_callees` → `imports[]`; each
  with `importText` + `callWeight` (resolved calls across import, heaviest
  first; 0 = type / constant / re-export only). Unknown path → empty list +
  `message` — fix path, never report "nothing imports it".

## Step 3 — multi-hop ("trace flow X → Y")

`trace_path from=<X> to=<Y>` — all paths, one call (per core routing "chain
A→B"). `namesakes` in answer / `paths: []` with `namesakes` → disambiguate via
`fromPath` / `toPath` (exact relativePath from prior result), not absence of
path. Model hops carry `p`; path `minP` = weakest link — say so. Present
`X → A.run() → B.help() → Y`. Genuinely no path → say so; never pad with
content-search guesses.

## Output

Caller/callee list with `call_expression` preview + `file:line`. Quote call
site, don't dump calling function.

Codegraph on → this pattern WINS over TRACE for usage.
