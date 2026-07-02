---
paths:
  - "src/core/domains/trajectory/static/**"
  - "src/core/domains/trajectory/codegraph/**"
  - "src/core/domains/trajectory/composite/**"
  - "src/core/contracts/types/codegraph.ts"
---

# `imports[]` Payload Field — Display Only

## Rule

`imports[]` on chunk's static payload = **visual mask**: lets MCP consumers
render file's import list in `rankingOverlay` + similar surfaces. MUST NOT be
source of statistical signals, derived metrics, or composite weights.

Any efferent-coupling signal (fan-out, instability, isHub-as-source, coupling
complexity, …) — **only acceptable source keys** = codegraph fan-graph payload
signals:

- `codegraph.file.fanIn` — file imported by N others (afferent)
- `codegraph.file.fanOut` — file imports N others (efferent)
- `codegraph.chunk.fanIn` / `codegraph.chunk.fanOut` — method-level

`imports[]` = raw data behind `codegraph.file.fanOut`; codegraph trajectory owns
populated value. Reading `imports[]` directly from derived signal:

- creates parallel data path with stale semantics (`ImportsSignal` Slice-1
  legacy proves this — description called "imports" but weights flowed as
  fanOut)
- prevents universal coverage rollout via Slice 2 D1 reverse-pass (which
  populates `codegraph.file.fanOut` for non-TS files from `imports[]`);
  downstream derived signals switching through `codegraph.file.fanOut`
  auto-inherit that coverage
- forces every consumer to redo imports/file-level/chunk-level semantic decision
  in isolation

## Where `imports[]` IS used legitimately

- `overlayMask.file: ["imports"]` — surface raw payload to MCP consumers for
  human inspection.
- Direct rendering of search result chunks (visual lists, doc previews).

## Where `imports[]` is NOT used

- Derived signal `extract()` functions — read `codegraph.file.fanOut` (or
  `chunk.fanOut`) instead.
- Stats accumulators — derive from codegraph layer.
- Composite preset weight inputs — same.

## Migration of legacy `ImportsSignal`

Static `ImportsSignal` derived signal predates codegraph, reads `imports.length`
directly. **Legacy** — no new code references it as weight key. Removal =
separate breaking change gated on:

1. Composite presets currently weighting `imports` migrating to `fanOut` (or
   `fanOutPerLine` where size normalisation matters).
2. Deprecation cycle publishing rename in CHANGELOG with `feat(presets)!`
   breaking marker.

Until then, treat `ImportsSignal` as fossil — read but do not extend.
