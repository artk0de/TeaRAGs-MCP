# Static Complexity (Cyclomatic + Cognitive) — Spec

**Status:** Draft, planning-ready. **Date:** 2026-05-21 **Owner:** tea-rags
**Parent epic:** `tea-rags-mcp-968v` (separate from codegraph epic
`tea-rags-mcp-l26`).

**Sibling specs (orthogonal tracks):**

- `2026-04-25-codegraph-symbols-vertical-slice.md` — codegraph (call/import
  graph) absorbs **universal fanIn/fanOut + composite presets** (Phase D of
  Slice 2 plan).
- `2026-05-22-temporal-coupling-trajectory-spec.md` — separate trajectory
  (process-derived co-change graph). Not folded into codegraph or this spec.

## Scope boundary

This spec is **complexity-only** — tree-sitter-driven control-flow metrics
inside a chunk + their file-level aggregates. Three independent tracks:

| Track                    | Spec                                              | Slice                     |
| ------------------------ | ------------------------------------------------- | ------------------------- |
| Static complexity (this) | `2026-05-21-static-complexity-fan-graph-spec.md`  | Static complexity epic    |
| Universal fan-graph      | codegraph Slice 2 plan, Phase D                   | Codegraph Slice 2         |
| Temporal coupling        | `2026-05-22-temporal-coupling-trajectory-spec.md` | Separate trajectory (TBD) |

Where this spec proposes a preset modification, it only assumes complexity
signals; presets needing fan-graph signals are described in the codegraph Slice
2 plan.

## Why complexity is its own track

Research-backed reality check (sources at bottom):

| Finding                                                                                                      | Adjustment                                                                                               |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **Process > Product** (Yatish 2020): churn/bugFix AUC 95% vs complexity AUC 54%                              | Complexity signals stay supplementary — NOT dominant. Down-weight in presets, keep process leading.      |
| **Cognitive complexity weak empirical evidence** (Lenarduzzi 2022): not significantly better than cyclomatic | `cognitiveLoad` defaultBound = 15 (SonarQube standard), not a dominant weight in any preset.             |
| **Keep cyclomatic and cognitive separate** (HCC paper, arxiv 2504.00477, 2025)                               | Two distinct derived signals, never merged into a composite. Both surfaced via overlayMask.              |
| **CodeScene uses LOC as complexity proxy, NOT McCabe**                                                       | Cyclomatic is an _improvement_, not a gap-closer. `chunkSize` (existing) already covers part of the gap. |
| **SonarQube threshold 15 for cognitive** — industry-standard                                                 | `cognitiveLoad.defaultBound = 15`.                                                                       |

These findings reshape the original proposal — complexity is a refinement on top
of existing process signals, not their replacement.

## Signal taxonomy

### Chunk-level (per function/method)

| Raw signal             | Computed by                                                                                                                           | Notes                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **`chunk.cyclomatic`** | McCabe over tree-sitter AST: `1 + N(if/while/for/case/&&/\|\|/?)`. Counts independent paths through the function (testability proxy). | Range 1 … 50+. Computed once per chunk inside the existing chunker AST walker. |
| **`chunk.cognitive`**  | SonarQube cognitive: McCabe + nesting penalty + bonus for `else if` chains + recursion penalty (readability proxy).                   | Range 0 … 100+. Same visitor pass; different accumulator.                      |

These are **not duplicates** — a 20-case `switch` has cyclomatic=20,
cognitive≈10 (flat, readable); a 3-level nested `if` has cyclomatic=4,
cognitive=12 (few paths but cognitively heavy). SonarQube research: cognitive
predicts review time, cyclomatic predicts test coverage.

### File-level (aggregates from chunks)

| Raw signal               | Formula                 | Use                                                   |
| ------------------------ | ----------------------- | ----------------------------------------------------- |
| **`file.cyclomaticMax`** | `max(chunk.cyclomatic)` | "Is there a monster method?" — refactoring inventory  |
| **`file.cyclomaticSum`** | `sum(chunk.cyclomatic)` | "Branching weight of the file" — architectural cost   |
| **`file.cognitiveMax`**  | `max(chunk.cognitive)`  | "Is there an unreadable section?" — onboarding filter |
| **`file.cognitiveAvg`**  | `mean(chunk.cognitive)` | "Is the whole file heavy or just one function?"       |

File-level aggregates are **derived from chunk-level**, computed once per chunk
and aggregated in `domains/trajectory/static/stats/` accumulators. No second AST
pass.

## Derived signals (3 new)

| Derived signal       | Raw source           | Normalization                    | `defaultBound`              |
| -------------------- | -------------------- | -------------------------------- | --------------------------- |
| **`complexity`**     | `chunk.cyclomatic`   | `normalize(value, p95)` adaptive | **10**                      |
| **`cognitiveLoad`**  | `chunk.cognitive`    | `normalize(value, p95)` adaptive | **15** (SonarQube standard) |
| **`fileComplexity`** | `file.cyclomaticSum` | `log + p95` (long tail)          | per-codebase                |

Per HCC 2025: complexity and cognitiveLoad stay **separate** derived signals —
do not merge into one composite. Each contributes independently to overlayMask
and weights so agents can see them split.

## Composite preset overrides using complexity (research-corrected weights)

**Architecture (clarified 2026-05-21):** existing trajectory presets are NOT
modified. The reranker's `resolvePresets(registry, composite)` pipeline already
overrides by `(name, tool)` key — composite presets that share a name with a
trajectory preset win the resolution. This spec creates **new composite preset
classes** in `src/core/domains/explore/rerank/presets/composite/`; the original
trajectory presets (`git/rerank/presets/hotspots.ts`, etc.) stay untouched.

Process-metric domination (Yatish 2020) means complexity weights stay small.
Cognitive weight is intentionally smaller than cyclomatic for refactoring,
opposite to the original proposal — refactoring readability matters but the
empirical evidence (Lenarduzzi 2022) does not justify a dominant cognitive
weight.

| Composite preset (name)      | Original (trajectory) → composite weights override                                                | `overlayMask` (raw)                                    | Source                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| **`hotspots`**               | ~~git: complexity 0.15, cognitiveLoad 0.05~~ → composite: **complexity 0.08, cognitiveLoad 0.04** | chunk: `cyclomatic`, `cognitive`                       | Yatish 2020 — process metrics dominate                 |
| **`refactoring`**            | ~~git: complexity 0.15, cognitiveLoad 0.1~~ → composite: **complexity 0.1, cognitiveLoad 0.1**    | chunk: `cyclomatic`, `cognitive`                       | Refactoring needs both; readability dominates slightly |
| **`techDebt`**               | composite override adds: **complexity 0.1**                                                       | file: `cyclomaticSum`                                  | Legacy + complex = real debt                           |
| **`securityAudit`**          | composite override adds: **complexity 0.08**                                                      | chunk: `cyclomatic`                                    | Shin 2010: CCC ↔ vuln                                  |
| **`decomposition`** (static) | composite override adds: **complexity 0.15, cognitiveLoad 0.1**                                   | chunk: `cyclomatic`, `cognitive`                       | AST-based decomposition vs size-only                   |
| **`onboarding`**             | composite override adds: **complexity -0.1, cognitiveLoad -0.05** (cognitive NOT stronger)        | chunk: `cyclomatic`, `cognitive`; file: `cognitiveMax` | Lenarduzzi 2022 — cognitive evidence weak              |

Each row above maps to a new file in `composite/` that returns a `RerankPreset`
with the same `name` and `tools` as the trajectory original — `resolvePresets`
will swap them in. The composite list is populated from
`buildCompositePresets({...})` in `composite/index.ts`, threaded through
`composition.ts`.

**Untouched by this spec:** `bugHunt`, `recent`, `proven`, `relevance`,
`documentationRelevance`, `stable`, `dangerous`, `ownership`, `codeReview`. The
last four are touched by composite overrides in the codegraph Slice 2 plan
(fan-graph weights); those overrides will need to absorb complexity overlay
additions if both specs land simultaneously.

## Phased delivery

Independent of codegraph Slice 2 — runs in parallel.

### Phase C1 — chunk.cyclomatic + `complexity` derived

Why first: smallest unit, single AST visitor pass added to existing chunker.

- C1.1 — Tree-sitter visitor computes McCabe per chunk during chunker pipeline
- C1.2 — `chunk.cyclomatic` payload signal descriptor + raw field
- C1.3 — `complexity` derived signal (sources `chunk.cyclomatic`,
  defaultBound=10)
- C1.4 — Preset modifications using only `complexity`: `hotspots`, `techDebt`,
  `securityAudit`, `decomposition`
- Live MCP validation on tea-rags self-test.

### Phase C2 — chunk.cognitive + `cognitiveLoad` derived

Why second: same chunker pipeline but different visitor (different algorithm).
Could be parallel with C1 but sequenced for review hygiene.

- C2.1 — Cognitive complexity visitor (SonarQube algorithm) computed alongside
  cyclomatic
- C2.2 — `chunk.cognitive` payload signal descriptor
- C2.3 — `cognitiveLoad` derived signal (sources `chunk.cognitive`,
  defaultBound=15)
- C2.4 — Preset modifications using `cognitiveLoad`: `refactoring`,
  `decomposition`, `onboarding`

### Phase C3 — File aggregates + `fileComplexity`

Why third: pure stats-accumulator work over existing chunk fields.

- C3.1 — `file.cyclomaticMax` / `file.cyclomaticSum` / `file.cognitiveMax` /
  `file.cognitiveAvg` accumulators in `static/stats/`
- C3.2 — `fileComplexity` derived signal (sources `file.cyclomaticSum`)
- C3.3 — Preset modifications using file aggregates: `techDebt` overlayMask
  additions

## Knowledge-base docs

After this spec lands, update KB articles in `website/docs`:

- `complexity-signals.md` — explain cyclomatic vs cognitive distinction with
  examples
- `process-vs-product.md` — explain why process metrics dominate (Yatish 2020
  reference)
- Existing preset docs (`hotspots`, `refactoring`, `onboarding`, etc.) — update
  with new weights + research citations

## Non-goals (this spec)

- Universal fanIn/fanOut (lives in codegraph spec).
- Temporal coupling / co-change preset (lives in codegraph spec — co-change
  shares stats infrastructure with codegraph graph metrics).
- Halstead complexity (separate proposal).
- Per-method `parameterCount` / `localVarCount` (separate proposal).
- Languages without sufficient tree-sitter grammar coverage for either algorithm
  — start with TypeScript, Python, Ruby; others fall back to no-signal until
  grammar support exists.

## Open questions

1. **AST visitor library**: write our own McCabe + cognitive visitors or adopt a
   community package (e.g. `tree-sitter-cyclomatic`)? Per-language parsing
   differences make `tree-sitter` queries cheaper than a generic library
   wrapper. Decision: write our own queries per language, colocated with
   existing chunker hooks.
2. **`chunkSize` vs `complexity` overlap**: CodeScene uses LOC as complexity
   proxy. If `chunkSize` already correlates with bug-fix rate, do we gain
   anything by adding cyclomatic? Empirical answer requires bench on tea-rags
   self-test post-C1.
3. **`cognitiveAvg` vs `cognitiveMax`**: which file-level cognitive aggregate
   makes it into reranker bounds — max for hot-spot detection or avg for
   whole-file heaviness? Default `cognitiveMax`; revisit per empirical evidence.

## Sources

- _Revisiting Process versus Product Metrics: A Large Scale Analysis_ — Yatish
  et al. 2020 (ICSME)
- _Co-Change Graph Entropy: A New Process Metric for Defect Prediction_ — arxiv
  2504.18511, April 2025
- _Unveiling Hybrid Cyclomatic Complexity_ — arxiv 2504.00477, April 2025
- _An empirical evaluation of the Cognitive Complexity measure_ — Lenarduzzi et
  al., JSS 2022
- _An Empirical Validation of Cognitive Complexity_ — ESEM 2020
- _Slice-Based Cognitive Complexity Metrics for Defect Prediction_ — SANER 2020
- _Software Instability Analysis Based on Afferent and Efferent Coupling
  Measures_ — Santos & Resende 2017
- _Does class size matter? Effect of class size in software defect prediction_ —
  arxiv 2106.04687
- _Novel metrics—novel coupling metrics for improved software fault prediction_
  — PMC 2021
- _CodeScene Hotspots Technical Documentation_
- _CodeScene Temporal Coupling Documentation v3.2.9_
- _SonarQube Cognitive Complexity Rule_
- _Which process metrics can significantly improve defect prediction models?_ —
  Springer

## Beads epic

To be created — separate from codegraph epic `tea-rags-mcp-l26` because:

- Different domain (static AST control-flow vs call/import graph)
- Different reviewer surface (chunker pipeline AST visitors vs
  trajectory/codegraph)
- Independent compute paths

Initial beads tasks added when this spec is approved; one parent epic captures
the C1-C3 phases.
