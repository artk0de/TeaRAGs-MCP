# ENTRY-POINT Pattern

"Where does X start?" intents. Surfaces flow entry points (low fan-in, high
fan-out — code that drives others but isn't driven) via the `entryPoint` rerank
preset over codegraph fan-graph signals, not content matching.

- **"Where does X start?" / "entry point" / "main flow" / "where does X begin"**
  → `semantic_search rerank="entryPoint" pathPattern=<scope>`. Overlay shows
  `fanIn`, `fanOutPerLine`, `chunkSize`. Top results are the drivers of the
  scope's flow.

## Pitfall — small-utility bias

`entryPoint` weights `fanIn` negatively (entry points are called by few). A
zero-fan-in one-line utility can therefore rank top despite being noise.
Mitigate by **post-filtering tiny chunks**: drop results whose `chunkSize` is
below a small threshold (a few lines), or pass `minFanOut` so a real entry
(which fans out into the flow) survives but a leaf utility doesn't. State the
filter you applied.

## Tail-suggestion (trace the flow)

After naming the top entry, offer to trace its flow forward:
`get_callees symbolId=<top-entry>` (resolve the exact id with `find_symbol`
first — see [usage-pattern.md](./usage-pattern.md)). That turns "here's where it
starts" into "here's what it does next", a natural drill-down chain.

Honest fallback: if the scope is small or flat (no clear high-fan-out driver),
say the ranking degraded to relevance — don't present a utility as "the entry
point" with false confidence.
