# ENTRY-POINT Pattern

Plan line 1, copied: `Codegraph: on|off — <source>`, decided per SKILL.md
"Codegraph availability": THIS request states it → that; a graph tool seen in
your tool list → on; not seen → registry read decides. Never the digest.

**Codegraph off** (stated, or registry says off) — whole procedure, nothing
below applies:

1. `semantic_search rerank="relevance" pathPattern=<scope> testFile:"exclude" documentation:"exclude"`.
2. Drop rows with tiny `chunkSize` (one-line helpers); larger chunks remain
   candidates.
3. Answer carries this line:
   `Codegraph off — candidates are content-inferred (relevance + chunkSize filter), not call-graph entry points.`

Never `rerank="entryPoint"` / `minFanOut` / graph tools; strategy label names
the off route, not "codegraph".

**Codegraph on** — "Where does X start?" intents. Flow entry points (low fan-in,
high fan-out — drives others, not driven) via `entryPoint` rerank over codegraph
fan-graph signals, not content matching.

- **"Where does X start?" / "entry point" / "main flow" / "where does X begin"**
  →
  `semantic_search rerank="entryPoint" pathPattern=<scope> testFile:"exclude" documentation:"exclude"`
  (broad target = sources axis — `../../../rules/references/axis-splitting.md`).
  Overlay: `fanIn`, `fanOutPerLine`, `chunkSize`. Top = drivers of scope's flow.
- Scope extraction found NO directory for X → run UNSCOPED honestly, never
  hardcode alias. Unscoped + small-utility bias = worst case → apply
  chunkSize/minFanOut post-filter aggressively, say so.

## Pitfall — small-utility bias

`entryPoint` weights `fanIn` negatively → zero-fan-in one-line utility can rank
top as noise. Mitigate: drop results with tiny `chunkSize` (few lines), or pass
`minFanOut` + `level: "chunk"` so real entry (fans out) survives, leaf utility
doesn't. `level: "chunk"` mandatory: `minFanOut` defaults to FILE level (import
count); chunk = symbol's own outgoing calls. `level` only re-scopes filter;
ranking + result shape unchanged. State filter applied.

## Tail-suggestion (trace flow)

After top entry, offer `get_callees symbolId=<top-entry>` (resolve exact id via
`find_symbol` first — [usage-pattern.md](./usage-pattern.md)) → "where it
starts" becomes "what it does next".

Honest fallback: small/flat scope (no clear high-fan-out driver) → say ranking
degraded to relevance; never present utility as "the entry point".
