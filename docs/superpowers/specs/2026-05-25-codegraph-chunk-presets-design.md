# Codegraph Chunk-Level Rerank Presets — Design

**Status:** Approved (brainstorming complete) **Date:** 2026-05-25 **Area:**
`src/core/domains/trajectory/codegraph/symbols/rerank/presets/`,
`src/core/domains/trajectory/composite/presets/`,
`src/core/domains/explore/reranker.ts` (overlay resolution only)

## Problem

The codegraph chunk-level signals — `pageRank`, `chunkFanIn`, `chunkFanOut` —
are fully built (compute → store → filter → index → derived signals registered
as `PageRankSignal` / `ChunkFanInSignal` / `ChunkFanOutSignal`) but **no rerank
preset weights them**. They are reachable only via explicit `minPageRank` /
`minFanIn` filters or hand-written `custom` rerank weights. None of the named
presets surface method-level call-graph centrality out of the box.

This design adds presets that put these three method-level axes to work.

## Key mechanics (verified in code)

These findings gate the design — confirmed by reading the scoring path:

1. **Scoring honors chunk-level weights regardless of preset `signalLevel`.**
   `Reranker.scoreResults` → `extractAllDerived` (reranker.ts:345) iterates ALL
   descriptors and calls `extract()` for each; `calculateScore` applies every
   weight. A chunk-level weight (`pageRank`, `chunkFanIn`) in a file-level
   preset DOES contribute to the score — it is NOT zeroed.

2. **`signalLevel` affects two things only:**
   - git derived signals that blend file+chunk (`blendNormalized` +
     `payloadAlpha`): at `signalLevel:"file"` alpha=0 → file value only.
     Codegraph chunk signals do NOT consume `signalLevel` — they read chunk
     payload directly.
   - `Reranker.buildOverlay` (reranker.ts:466):
     `skipChunk = signalLevel === "file"` suppresses chunk signals from the
     OVERLAY (display) only, not scoring.

3. **File-level presets aggregate via `groupByFile`** (strategies/base.ts:100):
   the file result carries the payload of ONE representative chunk. So a
   chunk-level signal inside a file-level preset attaches to a single
   representative method — semantically noisy. **Therefore all method-centrality
   presets are `signalLevel:"chunk"`**, where each method scores independently.

4. **`OverlayMask` has only `file?` and `chunk?`**
   (contracts/types/reranker.ts:53) — there is NO `derived` field. Overlays
   render raw payload signals only; derived (normalized) values never appear in
   overlays by design.

5. **Default level when `signalLevel` is undefined = `"chunk"`**
   (scroll-rank.ts:82: `level: ctx.level ?? "chunk"`). So `bugHunt` (no
   signalLevel declared) already runs chunk-level — its composite override stays
   chunk-natural.

6. **Composite override pattern:** composite presets override trajectory presets
   by `(name, tool)` key (composition.ts). `requires` gating drops a composite
   whose trajectory isn't registered, falling back to the base preset. Used here
   for `decomposition` and `bugHunt`.

## OverlayMask key format

Per existing composite presets (architectural-hub.ts, blast-radius.ts), overlay
keys use **full logical keys** per trajectory:

- codegraph: `codegraph.chunk.pageRank`, `codegraph.chunk.fanIn`,
  `codegraph.chunk.fanOut`
- git: `git.chunk.bugFixRate`, `git.chunk.commitCount`

These are logical descriptor keys (the k6xu bare-key change touched only the
physical payload, not logical descriptor/mask keys). All chunk-level presets in
this design carry the full codegraph triad (`fanIn`/`fanOut`/`pageRank`) in
their overlayMask — cheap and informative.

## The six presets

All `signalLevel:"chunk"`. Three pure-codegraph (codegraph trajectory presets,
auto-gated by `CODEGRAPH_ENABLED`), three composite (codegraph+git or
codegraph+static, gated by `requires`).

### 1. `criticalMethod` (pure codegraph)

- **file:** `codegraph/symbols/rerank/presets/critical-method.ts`
- **tools:** `semantic_search, hybrid_search, rank_chunks, find_similar`
- **weights:** `{ similarity: 0.3, pageRank: 0.7 }`
- **overlayMask:**
  `{ chunk: ["codegraph.chunk.pageRank", "codegraph.chunk.fanIn", "codegraph.chunk.fanOut"] }`
- **Purpose:** transitive importance via PageRank — the "critical nodes" whose
  weight comes from caller importance, not raw call count. Catches "quiet
  centers" (modest fanIn, on key execution paths). Code-review prioritization,
  change-risk.

### 2. `criticalPath` (composite codegraph+git)

- **file:** `composite/presets/critical-path.ts`
- **tools:** `semantic_search, hybrid_search, rank_chunks, find_similar`
- **requires:** `["codegraph.symbols", "git"]`
- **weights:** `{ similarity: 0.2, pageRank: 0.3, bugFix: 0.3, churn: 0.2 }`
- **overlayMask:**
  `{ chunk: ["codegraph.chunk.pageRank", "codegraph.chunk.fanIn", "codegraph.chunk.fanOut", "git.chunk.bugFixRate", "git.chunk.commitCount"] }`
- **Purpose:** central AND historically unstable methods. Yatish 2020 balance
  (process bugFix+churn=0.5 > structure pageRank 0.3). QA prevention — "where a
  regression is most expensive."

### 3. `hotMethod` (pure codegraph)

- **file:** `codegraph/symbols/rerank/presets/hot-method.ts`
- **tools:** `semantic_search, hybrid_search, rank_chunks, find_similar`
- **weights:** `{ similarity: 0.3, chunkFanIn: 0.7 }`
- **overlayMask:**
  `{ chunk: ["codegraph.chunk.fanIn", "codegraph.chunk.fanOut", "codegraph.chunk.pageRank"] }`
- **Purpose:** direct call popularity (raw fanIn). De-facto method-level API.
  Signature-change cost, test-coverage priority, onboarding, deprecation
  planning. Contrast with criticalMethod: "how costly to TOUCH" (direct) vs "how
  deep it RIPPLES" (transitive).

### 4. `godMethod` (pure codegraph)

- **file:** `codegraph/symbols/rerank/presets/god-method.ts`
- **tools:** `semantic_search, hybrid_search, rank_chunks, find_similar`
- **weights:** `{ similarity: 0.3, chunkFanOut: 0.7 }`
- **overlayMask:**
  `{ chunk: ["codegraph.chunk.fanOut", "codegraph.chunk.fanIn", "codegraph.chunk.pageRank"] }`
- **Purpose:** outgoing-call overload — orchestrators that call too much
  (`orchestrator`/`god-method` fanOut tiers). Decomposition/refactoring
  candidates, SRP violations. Opposite axis from hotMethod (outgoing vs
  incoming).

### 5. `decomposition` (composite override of static decomposition)

- **file:** `composite/presets/decomposition.ts`
- **tools:** `semantic_search, hybrid_search, rank_chunks, find_similar`
- **requires:** `["codegraph.symbols"]` (codegraph off → static `decomposition`
  fallback)
- **weights:**
  `{ similarity: 0.3, chunkSize: 0.3, chunkFanOut: 0.25, chunkDensity: 0.15 }`
- **overlayMask:**
  `{ file: ["methodLines"], chunk: ["codegraph.chunk.fanOut", "codegraph.chunk.fanIn", "codegraph.chunk.pageRank"] }`
- **groupBy:** `parentSymbolId`
- **Purpose:** adds the call-graph axis (fanOut/god-method) to the classic
  size+density decomposition. Big + dense + over-coupled = strongest
  extract-method candidate. Overrides static decomposition when codegraph is on.

### 6. `bugHunt` (composite override of git bugHunt)

- **file:** `composite/presets/bug-hunt.ts`
- **tools:**
  `semantic_search, hybrid_search, search_code, find_similar, rank_chunks`
- **requires:** `["codegraph.symbols", "git"]` (codegraph off → git `bugHunt`
  fallback)
- **weights:**
  `{ similarity: 0.2, burstActivity: 0.18, volatility: 0.18, bugFix: 0.15, pageRank: 0.14, relativeChurnNorm: 0.1, recency: 0.05 }`
  (original git temporal signals + pageRank, rebalanced)
- **overlayMask:** original git file/chunk set + codegraph triad on chunk
- **Purpose:** keeps bugHunt's temporal-git nature
  (burst/volatility/churn/bugFix) and adds call-graph centrality — bug-prone
  zones that are ALSO central rank higher. Overrides git bugHunt when codegraph
  is on; falls back when off.

## Preset taxonomy (resolves overlap)

| Preset                      | Level | Dominant                 | Question answered                          |
| --------------------------- | ----- | ------------------------ | ------------------------------------------ |
| `criticalMethod`            | chunk | pageRank                 | which methods hold the call graph?         |
| `hotMethod`                 | chunk | chunkFanIn               | which methods does everything call?        |
| `godMethod`                 | chunk | chunkFanOut              | which methods do too much?                 |
| `criticalPath`              | chunk | pageRank+bugFix          | where is a regression most expensive? (QA) |
| `bugHunt` (composite)       | chunk | temporal+bugFix+pageRank | where are bugs hiding? (debug)             |
| `decomposition` (composite) | chunk | size+fanOut              | what to extract/refactor?                  |

## Out of scope (YAGNI)

- Standalone `bugMagnet` — folded into `bugHunt` composite override (bugHunt is
  already chunk-level; a separate preset would duplicate it).
- file-level pageRank — pageRank is per-method; file-level presets aggregate via
  groupByFile (representative chunk) → semantically noisy. Not pursued.
- chunk-level `isHub`/`isLeaf` — pageRank + fanIn tiers already express method
  centrality; booleans add no discriminating value at method level.

## Implementation notes

- **Overlay resolution for codegraph chunk keys:** verify `extractRawSource` /
  `applyLabelResolution` resolve `chunk.pageRank` → physical
  `codegraph.symbols.chunk.pageRank` (bare key post-k6xu). If not, wiring the
  overlay resolver for codegraph chunk keys is part of preset 1's task.
- **No new derived signals needed** — `PageRankSignal`, `ChunkFanInSignal`,
  `ChunkFanOutSignal` already registered; presets only reference them as weight
  keys.
- **MCP schema:** new preset names (`criticalMethod`, `hotMethod`, `godMethod`,
  `criticalPath`) become enum values via `SchemaBuilder` automatically from the
  reranker's preset registry. `decomposition`/`bugHunt` enum entries already
  exist (override keeps the name).
- **silo-pairing rule:** reranker.ts is deep-silo — any commit touching overlay
  resolution must include a `Why:` line.

## Testing

- Per-preset unit test: instantiate, assert
  name/tools/weights/overlayMask/signalLevel.
- Reranker scoring test: chunk-level preset with pageRank weight produces
  non-zero scores ranked by pageRank on a fixture with known method centrality.
- Override tests: `decomposition`/`bugHunt` composite wins over base when
  codegraph registered; base preset used when not (gating).
- Live MCP (tea-rags self-test): `rank_chunks rerank:criticalMethod` returns
  methods ranked by pageRank; overlay shows the fanIn/fanOut/pageRank triad with
  labels.
