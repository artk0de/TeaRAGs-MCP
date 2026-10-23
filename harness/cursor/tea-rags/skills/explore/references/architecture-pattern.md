# ARCHITECTURE Pattern

"Structure / backbone of X?" intents. Surfaces architectural hubs (high fan-in —
files many others depend on) via `architecturalHub` rerank over codegraph
fan-graph signals → answer reflects real dependency centrality, not prose that
says "architecture".

## Step 0 — ORIENT (entry points first)

Broad target (system / domain / directory) → ENTRY POINTS before hubs — hubs =
what everything routes THROUGH, entries = where flow STARTS; answer needs both:
`semantic_search rerank="entryPoint" pathPattern=<scope> limit=5 testFile:"exclude" documentation:"exclude"`.
= Explore Flow ORIENT, absorbed here (architecture phrasing routes here before
the flow). Same small-utility bias as entry-point-pattern.md — post-filter tiny
`chunkSize` / pass `minFanOut` + `level: "chunk"` (else `minFanOut` = file
import count); state filter applied.

## Step 1 — backbone (hubs)

- **"Architecture of X?" / "structure of Y" / "what's central" / "backbone" /
  "show me how X is organized"** →
  `semantic_search rerank="architecturalHub" pathPattern=<scope> testFile:"exclude" documentation:"exclude"`
  (broad target = sources axis — `../../../references/axis-splitting.md`).
  Overlay: `isHub`, `fanIn`, `fanOutPerLine`. Ranked hub list = backbone.

## Honest fallback (no hubs in scope)

No `isHub=true` files (flat module) → preset degrades to similarity. Say "no
architectural hubs in `<scope>`, falling back to relevance ranking" — never
present top similarity hit as "the architectural centre". Optional confirm:
`isHub=true` filter, zero results = no hubs.

**Codegraph off** (graph tools absent from tool list): `architecturalHub` has no
fan-graph signals, silently degrades to similarity. Say fan-in centrality
unavailable; offer git imports/churn or relevance — never similarity top hit as
"the architectural centre". Orientation then = ORIENT
`semantic_search rerank="onboarding"` (SKILL.md §1), flagged content-inferred.
Distinct from no-hubs case (codegraph on, scope flat).

## Tail-suggestion (drill into hub)

After top hub, offer dependents: `get_callers symbolId=<top-hub-symbol>`
(resolve exact id via `find_symbol` first —
[usage-pattern.md](./usage-pattern.md)) → WHO routes through hub = blast radius.

Citations `file:line`. Quote hub's defining lines, don't dump file.
