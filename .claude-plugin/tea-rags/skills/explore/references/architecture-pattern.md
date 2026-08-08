# ARCHITECTURE Pattern

"What's the structure / backbone of X?" intents. Surfaces architectural hubs
(high fan-in — the files many others depend on) via the `architecturalHub`
rerank preset over codegraph fan-graph signals, so the answer reflects real
dependency centrality, not prose that happens to say "architecture".

## Step 0 — ORIENT (entry points first)

Broad target (system / domain / directory) → see the flow's ENTRY POINTS before
ranking hubs — hubs say what everything routes THROUGH, entries say where flow
STARTS; an architecture answer needs both:
`semantic_search rerank="entryPoint" pathPattern=<scope> limit=5 testFile:"exclude" documentation:"exclude"`.
This IS the Explore Flow ORIENT step, absorbed here — architecture phrasing
routes to this pattern before the flow, orientation must not be lost. Same
small-utility bias as entry-point-pattern.md — post-filter tiny `chunkSize` /
pass `minFanOut`, state the filter applied.

## Step 1 — backbone (hubs)

- **"Architecture of X?" / "structure of Y" / "what's central" / "backbone" /
  "show me how X is organized"** →
  `semantic_search rerank="architecturalHub" pathPattern=<scope> testFile:"exclude" documentation:"exclude"`
  (broad target = sources axis by construction — see
  `rules/references/axis-splitting.md`). Overlay shows `isHub`, `fanIn`,
  `fanOutPerLine`. The ranked hub list IS the backbone — the files everything
  else routes through.

## Honest fallback (no hubs in scope)

If the scope has **no `isHub=true` files** (flat module, no dominant dependency
centre), the preset degrades to similarity ranking. Say so: "no architectural
hubs in `<scope>`, falling back to relevance ranking" — never present the top
similarity hit as "the architectural centre" when no hub exists. Optionally
confirm with `isHub=true` as a filter: zero results = no hubs.

**Codegraph off** (no `codegraph.symbols` in prime): `architecturalHub` has no
fan-graph signals and silently degrades to similarity. Say fan-in centrality is
unavailable and offer git imports/churn or relevance instead — do NOT present a
similarity top hit as "the architectural centre". This is distinct from the
no-hubs case above (there codegraph is on but the scope is flat).

## Tail-suggestion (drill into the hub)

After naming the top hub, offer the dependents view:
`get_callers symbolId=<top-hub-symbol>` (resolve the exact id with `find_symbol`
first — see [usage-pattern.md](./usage-pattern.md)) shows WHO routes through the
hub, turning "this is central" into "and here's its blast radius". Natural
drill-down chain.

Code citations: `file:line`. Quote the hub's defining lines, don't dump the
file.
