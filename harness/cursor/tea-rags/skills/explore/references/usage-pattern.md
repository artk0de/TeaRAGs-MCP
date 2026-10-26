# USAGE Pattern

**Codegraph off** (stated, or registry says off — SKILL.md "Codegraph
availability") → `find_symbol` + iterative `hybrid_search` name-match (no edge
truth — say so). Callers, copied, ≥ 2 calls:
`hybrid_search(query="<X>", metaOnly=true)` → per caller hit
`hybrid_search(query="<caller>", metaOnly=true)` → repeat ≤ 3 levels
(`trace-pattern.md`). One call = fail. Path A→B = manual chain, "no static path
tool". Never call/plan `get_callers` / `get_callees` / `trace_path`.

Caller / callee intents via `get_callers` / `get_callees` edge truth (codegraph
call edges), not content matching — no false hits on comments, strings,
same-named symbols. "Every / all callers of X" (exhaustive) → Step 2's
`get_callers`, THEN `hybrid_search metaOnly:true query=<name>` — it adds, never
replaces: graph = resolved edges, hybrid = recall for calls the graph did not
resolve. Report both, edges first.

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
  `message` — fix path, never report "nothing imports it". Codegraph off →
  `hybrid_search metaOnly:true` on the module path / import string. User offers
  `grep` / `rg` for importers → refuse, answer starts with this line:

  ```
  Not grep: it matches import text only — misses re-exports and call weight. Importers via <get_callers(relativePath=<module>) | hybrid_search on the module path (codegraph off)>.
  ```

## Step 3 — multi-hop (how X reaches Y)

"How does a webhook reach the job queue?" asks for the full chain: endpoint
symbol names known → `find_symbol` each; endpoints described in words →
`semantic_search` for them, ids from its hits (a phrase is never a
`find_symbol symbol=`). Then `trace_path from=<X> to=<Y>` — all paths, one call
(per core routing "how does X reach Y / A→B"). `namesakes` in answer /
`paths: []` with `namesakes` → disambiguate via `fromPath` / `toPath` (exact
relativePath from prior result), not absence of path. Model hops carry `p`; path
`minP` = weakest link — say so. Present `X → A.run() → B.help() → Y`. Genuinely
no path → say so; never pad with content-search guesses.

## Output

Caller/callee list with `call_expression` preview + `file:line`. Quote call
site, don't dump calling function.

Codegraph on → this pattern WINS over TRACE for usage.
