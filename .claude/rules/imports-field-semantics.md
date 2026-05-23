---
paths:
  - "src/core/domains/trajectory/static/**"
  - "src/core/domains/trajectory/codegraph/**"
  - "src/core/domains/trajectory/composite/**"
  - "src/core/contracts/types/codegraph.ts"
---

# `imports[]` Payload Field — Display Only

## Rule

The `imports[]` payload field on a chunk's static payload is a **visual mask**:
it lets MCP consumers render the file's import list in `rankingOverlay` and
similar surfaces. It MUST NOT be used as a source of statistical signals,
derived metrics, or composite weights.

For any signal expressing efferent coupling (fan-out, instability,
isHub-as-source, coupling complexity, …) the **only acceptable source keys** are
the codegraph fan-graph payload signals:

- `codegraph.file.fanIn` — file is imported by N others (afferent)
- `codegraph.file.fanOut` — file imports N others (efferent)
- `codegraph.chunk.fanIn` / `codegraph.chunk.fanOut` — method-level

`imports[]` is the underlying raw data behind `codegraph.file.fanOut`; the
codegraph trajectory owns the populated value. Reading `imports[]` directly from
a derived signal:

- creates a parallel data path with stale semantics (the `ImportsSignal` Slice-1
  legacy proves this — its description called "imports" but weights flowed as
  fanOut)
- prevents universal coverage rolling out via the Slice 2 D1 reverse-pass (which
  populates `codegraph.file.fanOut` for non-TS files from `imports[]`);
  downstream derived signals that switch through `codegraph.file.fanOut`
  automatically inherit that coverage
- forces every consumer to redo the imports/file-level/chunk-level semantic
  decision in isolation

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

The static `ImportsSignal` derived signal predates codegraph and reads
`imports.length` directly. It is **legacy** — no new code should reference it as
a weight key. Removal is a separate breaking change gated on:

1. Composite presets that currently weight `imports` migrating to `fanOut` (or
   `fanOutPerLine` where size normalisation matters).
2. A deprecation cycle that publishes the rename in CHANGELOG with the
   `feat(presets)!` breaking marker.

Until then, treat `ImportsSignal` as a fossil — read but do not extend.
