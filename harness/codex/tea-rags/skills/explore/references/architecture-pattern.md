# ARCHITECTURE Pattern

"Structure / backbone of X?" intents. Surfaces architectural hubs (high fan-in —
files many others depend on) via `architecturalHub` rerank over codegraph
fan-graph signals → answer reflects real dependency centrality, not prose that
says "architecture".

Plan line 1, copied: `Codegraph: on|off — <source>`, decided per SKILL.md
"Codegraph availability": THIS request states it → that; a graph tool seen in
your tool list → on; not seen → registry read decides. Never the digest.

**Codegraph off** (stated, or registry says off) → skip Step 0 and Step 1:
ORIENT `semantic_search rerank="onboarding"`, flagged content-inferred; never
`rerank="entryPoint"` / `rerank="architecturalHub"` / graph tools (no fan-graph
signals — they silently degrade to similarity). Say fan-in centrality
unavailable; offer git imports/churn or relevance — never similarity top hit as
"the architectural centre". Distinct from no-hubs case (codegraph on, flat
scope).

## Step 0 — ORIENT (entry points first; codegraph on)

Broad target (system / domain / directory) → ENTRY POINTS before hubs — hubs =
what everything routes THROUGH, entries = where flow STARTS; answer needs both:
`semantic_search rerank="entryPoint" pathPattern=<scope> limit=5 testFile:"exclude" documentation:"exclude"`.
= explore-flow.md ORIENT, absorbed here (architecture phrasing routes here
before the flow). Same small-utility bias as entry-point-pattern.md —
post-filter tiny `chunkSize` / pass `minFanOut` + `level: "chunk"` (else
`minFanOut` = file import count); state filter applied.

## Step 1 — backbone (hubs)

- **"Architecture of X?" / "structure of Y" / "what's central" / "backbone" /
  "show me how X is organized" / "end to end"** →
  `semantic_search rerank="architecturalHub" pathPattern=<scope> testFile:"exclude" documentation:"exclude"`
  — sources only, no tests / docs axis split; Step 2 follows, never skipped.
  Overlay: `isHub`, `fanIn`, `fanOutPerLine`. Ranked hub list = backbone.

## Step 2 — flow walk (codegraph on)

`get_callees symbolId=<top entry id from Step 0> depth=2` (exact id via
`find_symbol` first) — ONE call, its `tree` is the path from entry through the
backbone (Step 1 hubs among its rows). Then ONE `find_symbol(symbols: [...])` of
only the walked symbols the answer needs.

## Honest fallback (no hubs in scope)

No `isHub=true` files (flat module) → preset degrades to similarity. Say "no
architectural hubs in `<scope>`, falling back to relevance ranking" — never
present top similarity hit as "the architectural centre". Optional confirm:
`isHub=true` filter, zero results = no hubs.

## Tail-suggestion (drill into hub)

After top hub, offer dependents: `get_callers symbolId=<top-hub-symbol>`
(resolve exact id via `find_symbol` first —
[usage-pattern.md](./usage-pattern.md)) → WHO routes through hub = blast radius.

Citations `file:line`. Quote hub's defining lines, don't dump file.
