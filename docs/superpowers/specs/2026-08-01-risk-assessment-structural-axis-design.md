# Risk Assessment Structural Axis — Design

**Date:** 2026-08-01 **Status:** approved in brainstorm, pending spec review
**Scope:** symbol-mass payload signals, `godModule` preset, composite
`decomposition` + `godModule` presets, `risk-assessment` skill rework

## Problem

`tea-rags:risk-assessment` ranks candidates purely by git-risk overlap (bugHunt
/ hotspots / techDebt / dangerous). Two whole classes of debt are invisible to
it, and the report has no cost axis.

**God methods are never ranked.** `codegraph.chunk.fanOut` ships a calibrated
p95 label literally named `god-method`, yet no preset in the codebase weights
`chunkFanOut` — the signal exists in every payload and never influences a single
ranking. The `decomposition` preset runs only as a Phase 4.3 post-filter over
already-found risk zones, so a large but git-quiet method never reaches the
report at all.

**God classes / god modules are unmeasurable.** No payload signal captures
symbol mass. A class chunk carries only the header (measured on the live index:
`MarkdownLanguage` methodLines=5, `StaticTrajectory` methodLines=9; `Reranker`
spans lines 77–738 but its class chunk covers the header only). Member counts
exist only at query time via the `find_symbol` merged outline (`chunkCount: 34`
for `Reranker`). A preset ranks points by their payload — with no mass field
there is nothing to weight. Call-graph signals are not substitutes: a class with
40 private methods and fanIn=2 is a god class the graph cannot see.

**No fix-cost axis.** A big method with no callers and local impact (cheap
extract-method) is indistinguishable in the report from one wired into the
backbone (expensive). The user-facing notion "cheap decomposition candidate" has
no representation.

Dead-weight audit across all 22 presets (empirical): `pageRank`,
`transitiveImpact`, `chunkFanOut`, `isLeaf`, `instability`, `imports` — used by
0 presets; `fanOut`, `chunkFanIn`, `fanOutPerLine` — 1 preset each.

## Design overview

Four parts. A and B add payload fields (schema drift → force reindex,
user-gated). C is rerank-time only. D is skill text.

| #   | Part                                                          | Layer                      | Reindex |
| --- | ------------------------------------------------------------- | -------------------------- | ------- |
| A   | Symbol-mass payload signals (chunker post-pass)               | `chunker/`, static signals | yes     |
| B   | `symbolCount` derived signal + `godModule` preset             | `static/rerank/`           | uses A  |
| C   | Composite `decomposition` + `godModule` presets               | `composite/presets/`       | no      |
| D   | `risk-assessment` skill: structural phase, fix cost, fallback | skill files                | no      |

## A. Symbol-mass payload signals

A language-independent post-pass over a file's assembled chunk array, after
`parentSymbolId` resolution. One module
(`src/core/domains/ingest/pipeline/chunker/symbol-mass.ts`), not nine
per-language hooks — the pass reads only chunk metadata that every language
already emits.

| Field             | On                      | Definition                              |
| ----------------- | ----------------------- | --------------------------------------- |
| `memberCount`     | class chunks            | distinct member symbolIds of the class  |
| `classLines`      | class chunks            | `max(member endLine) − class startLine` |
| `fileSymbolCount` | every code chunk (flat) | distinct code symbolIds in the file     |

Counting rules: a member = a chunk whose `parentSymbolId` equals the class
symbolId; `#partN` split suffixes fold to one member; direct members only —
nested-class members belong to the nested class. `classLines` is the real class
span, not the header span. `fileSymbolCount` is stamped flat on every code chunk
of the file (the `imports` precedent); documentation chunks (`doc:` ids) are
excluded from both storage and count.

Descriptors added to `BASE_PAYLOAD_SIGNALS` with stats labels, extending the
existing label vocabulary:

| Signal            | Labels                                        | chunkTypeFilter |
| ----------------- | --------------------------------------------- | --------------- |
| `memberCount`     | p50 `typical` / p75 `large` / p95 `god-class` | `class`         |
| `classLines`      | p50 `small` / p75 `large` / p95 `megaclass`   | `class`         |
| `fileSymbolCount` | p50 `typical` / p75 `busy` / p95 `god-module` | none            |

Constraint: the WHOLE stats frame for `fileSymbolCount` — count, min/max, mean,
stddev and percentiles alike — MUST be computed over distinct files (dedupe by
`relativePath`), not over chunks. The value is stamped flat on every chunk of
its file, so a chunk-level accumulator lets a 40-chunk file count itself 40
times: the mean is then chunk-weighted and the percentiles describe chunks
rather than files. Dedupe therefore belongs at the accumulator (one accepted
value per `relativePath` per stats bucket), not at the percentile step.

`memberCount` and `classLines` need no such handling —
`chunkTypeFilter: "class"` already admits one value per class chunk.

New fields ride the standard schema-drift path (`schemaDrift` detection → prompt
`forceReindex`), per `.claude/rules/.local/schema-drift-vs-migration.md`. No
partial migration.

## B. `godModule` preset (static, file-level)

One new derived signal `symbolCount` in the static trajectory, normalizing
`fileSymbolCount` with adaptive bounds (p95 with default floor — the standard
path).

```ts
// src/core/domains/trajectory/static/rerank/presets/god-module.ts
name = "godModule";
signalLevel = "file"; // ranks files; class attribution comes from overlay
tools = ["semantic_search", "hybrid_search", "rank_chunks", "find_similar"];
weights = { similarity: 0.2, symbolCount: 0.8 };
overlayMask = {
  file: ["fileSymbolCount"],
  chunk: ["memberCount", "classLines"],
};
```

The name tracks the granularity of the ranking, not the verdict: the preset
ranks FILES, and `fileSymbolCount`'s p95 label is already `god-module`. Whether
a hit is a god class or a god module is an attribution decision made afterwards
from the overlay (see below). `memberCount` keeps its `god-class` p95 label —
that one labels a class chunk, so the label is still literally what it says.

Static trajectory, not composite: the base preset needs neither git nor
codegraph, so it works on any collection once reindexed. "Top-10 god modules of
the project" becomes one call: `rank_chunks rerank=godModule limit=10`.

Attribution rule (consumer-side, documented in the skill): a dominant class
holding most of the file's members = **god class**; a spread of top-level
symbols with no dominant class = **god module**. The overlay carries the numbers
(`memberCount`, `classLines`, `fileSymbolCount`) to decide.

`fanIn` / `pageRank` are deliberately NOT in the static weights: they measure
call-graph connectivity, not interface mass, and the static preset must work on
collections with no call graph at all. The codegraph-enriched variant in §C2
folds connectivity back in as an amplifier; the fix-cost classifier (Part D)
reads the same signals from the overlay.

MCP tool schemas and `tea-rags://schema/presets` regenerate from the registry —
no manual schema edits.

## C. Composite `decomposition` preset

`src/core/domains/trajectory/composite/presets/decomposition.ts` shadows the
static `decomposition` when `codegraph.symbols` is registered — the same
name-keyed override already used by `techDebt`, `dangerous`, `hotspots`,
`codeReview`, `ownership`, `securityAudit`. The static class is untouched;
collections without codegraph resolve it as before (graceful degradation is a
property of the existing pattern, not new machinery).

```ts
requires = ["codegraph.symbols"]; // git not needed
signalLevel = "chunk";
weights = {
  similarity: 0.2,
  chunkSize: 0.35,
  chunkFanOut: 0.3,
  chunkDensity: 0.15,
};
overlayMask = {
  chunk: [
    "codegraph.chunk.fanOut",
    "codegraph.chunk.fanIn",
    "codegraph.chunk.pageRank",
  ],
  file: ["methodLines", "codegraph.file.transitiveImpact"],
};
groupBy = "parentSymbolId"; // preserved from the static preset
```

Weight rationale: the score answers "what should be split" — size × density ×
outgoing load (`chunkFanOut` = method doing too much, its p95 label is already
`god-method`). `fanIn` / `pageRank` answer "what it costs to touch / how
important it is" — that is the fix-cost axis, fed from the overlay. Putting them
into the score would conflate detection with prioritization (same argument that
keeps `instability` out of `architecturalHub` weights, per Santos 2017).

Existing consumers (`refactoring-scan`, dinopowers chains) upgrade for free —
same preset name, richer overlay.

## C2. Composite `godModule` preset

`src/core/domains/trajectory/composite/presets/god-module.ts` shadows the static
`godModule` under the same name-keyed override, gated on `codegraph.symbols`
alone (git contributes nothing here).

```ts
requires = ["codegraph.symbols"];
signalLevel = "file";
weights = {
  similarity: 0.15,
  symbolCount: 0.5,
  fanIn: 0.15,
  transitiveImpact: 0.1,
  isHub: 0.1,
};
overlayMask = {
  file: [
    "fileSymbolCount",
    "codegraph.file.fanIn",
    "codegraph.file.fanOut",
    "codegraph.file.transitiveImpact",
    "codegraph.file.isHub",
  ],
  chunk: ["memberCount", "classLines"],
};
```

Symbol mass stays dominant at 0.5 — a god module is defined by interface mass,
and demoting that would turn the preset into a second `architecturalHub`. The
three structural signals (0.35 combined) amplify the mass ranking with how
deeply the file is wired in: mass × blast radius is what separates "big file
nobody touches" from "big file everything depends on". `transitiveImpact` and
`isHub` already exist as codegraph derived signals; no new signal is introduced.

Collections without codegraph resolve the static variant unchanged — the same
graceful degradation the shadow pattern already provides.

## D. `risk-assessment` skill changes

### Phase flow

```text
0  SCOPE          unchanged
1  SCAN           4 risk presets             ─┐ one parallel block
1b STRUCTURAL     decomposition + godModule  ─┘ (+2 calls)
2  MERGE          risk presets only — structural results DO NOT enter overlap tiers
3  EXPAND         unchanged
4  ENRICH         + fix-cost classifier, + god-class attribution; old step 4.3 deleted
5  OUTPUT         + "Structural debt" section
```

Phase 4.3 ("decomposition as post-filter") is deleted — it was the reason a
large but git-clean god method could never appear. Phase 1b replaces it and runs
independently of git risk.

### Phase 1b — STRUCTURAL scan

Two `rank_chunks` calls in the same parallel block as Phase 1, same
`pathPattern`, `limit: 10`:

- `rerank: "decomposition"` — method axis. With codegraph active the composite
  variant resolves and the overlay carries `chunk.fanOut/fanIn/pageRank`;
  without codegraph the static (size-only) variant resolves — the skill notes
  "god-method lens unavailable — codegraph off".
- `rerank: "godModule"` — file axis. Overlay carries `fileSymbolCount` /
  `memberCount` / `classLines`; with codegraph active the composite variant
  resolves and adds `fanIn` / `fanOut` / `transitiveImpact` / `isHub`, which the
  fix-cost classifier reuses directly.

### Phase 4 — fix-cost classifier

For every Critical/High risk candidate and every structural candidate, score
from overlay signals already fetched:

| Input                    | 0                | 1         | 2        |
| ------------------------ | ---------------- | --------- | -------- |
| `chunk.fanIn`            | unused / typical | frequent  | central  |
| `file.transitiveImpact`  | local            | regional  | systemic |
| `chunk.pageRank`         | peripheral       | important | critical |
| tests (Phase 4.2 result) | present          | absent    | —        |

Sum: 0–2 `cheap`, 3–4 `moderate`, 5+ `expensive`. Missing tests feed both risk
(defect likelihood) and cost (refactor safety) — intentional, one input serving
two different quantities; the skill states this explicitly.

### Phase 4 — god-class attribution

Primary path (index has symbol-mass fields): read `memberCount` / `classLines` /
`fileSymbolCount` straight from the `godModule` overlay — zero extra calls.
Apply the attribution rule from Part B: a dominant class holding most of the
file's members is a **god class**; a spread of top-level symbols with no
dominant class is a **god module**.

Fallback path (fields absent — index predates the signals): the payload
`chunkIndex` field plus a raw Qdrant filter give an exact, size-unbiased finder:

1. `rank_chunks` with
   `filter: { must: [{ key: "chunkIndex", range: { gte: 20 } }] }`,
   `metaOnly: true`, `limit: 20`. Any hit is a file with ≥21 chunks — an exact
   lower bound independent of method size (a class of 40 five-line methods is
   caught). Adaptive threshold: empty at 20 → probe 10; >20 files → probe 40.
   Max 2 probes.
2. Dedupe by `relativePath` → `find_symbol({relativePath})` per candidate
   (cap 5) → exact member counts per class from the merged outline (distinct
   member symbolIds, `#partN` folded), spans from `startLine`/`endLine`.

Fallback output is labeled "fallback path — index predates symbol-mass signals".
Reported numbers always come from the outline (exact), never from the finder
window.

### Phase 5 — OUTPUT

New section, present whenever Phase 1b ran:

```text
## Structural debt (independent of git risk)

| # | Symbol | File:Line | Smell | Size | Fix cost | Also risk? |
|---|--------|-----------|-------|------|----------|------------|
| 1 | Foo#bar() | foo.ts:120 | god-method | 180 LOC, fanOut:14 god-method | cheap | — |
| 2 | Baz | baz.ts:1-740 | god-class | 34 members, 661 LOC | expensive | High #3 |
```

Sorted by (size × cheapness) — "cheap decomposition candidates" are the top
rows. `Also risk?` is the only link to the risk map; the intersection
(structural debt AND risk tier) gets its own Summary line — that is the "do now"
quadrant. Existing tier semantics (N/N = all risk dimensions converge) are
unchanged.

### Housekeeping

- Fix 4 broken references: `references/signal-interpretation.md` does not exist
  under the skill's `references/`; the file lives at
  `.claude-plugin/tea-rags/rules/references/signal-interpretation.md`. Correct
  the relative links.
- `references/anti-patterns.md`: add the boundary — standalone refactoring hunts
  without risk context → `refactoring-scan`; `risk-assessment` surfaces
  structural debt annotated with risk and cost within the assessment scope.
- Call budgets: ≤14 domain / ≤18 broad on the primary path (was ≤12/≤16);
  fallback adds ≤7 (2 probes + 5 outlines).
- Skill body prose ships caveman-compressed per
  `.claude/rules/caveman-compression.md`; output-format blocks stay verbatim.

## Out of scope

- `refactoring-scan` changes (boundary note only).
- Adopting the remaining dead weight keys (`imports`, `isLeaf`, `instability`)
  in other presets — separate audit.
- A `godMethod` named preset — superseded by the composite `decomposition`.
- Cohesion metrics (LCOM-style) — would need method-level field-access facts
  codegraph does not extract today.

## Testing (TDD, red first)

- **symbol-mass post-pass** — fixtures: class with `#partN` split methods
  (folded to one member), nested classes (direct members only), file with no
  classes (only `fileSymbolCount` emitted), documentation file (no fields).
- **stats labels** — descriptors registered; `IndexMetricsQuery` does not skip
  the new signals (labels present → metrics visible); `fileSymbolCount`
  percentiles deduped by file.
- **godModule** — registered in static presets; resolves for all four tools;
  `symbolCount` derived signal normalizes against adaptive bounds; overlay mask
  keys exist in descriptors.
- **composite decomposition** — with codegraph registered the resolved
  `decomposition` weights include `chunkFanOut` and `groupBy` survives; without
  codegraph the static variant resolves (no structural keys).
  `tests/core/domains/explore/rerank-rank-chunks-fixes.test.ts` imports the
  static class directly and stays untouched (business-logic tests immutable).
- **composite godModule** — with codegraph registered the resolved `godModule`
  weights include `fanIn` / `transitiveImpact` / `isHub` and `symbolCount` stays
  dominant; without codegraph the static variant resolves (only `similarity` +
  `symbolCount`).
- Skill text (Part D) has no automated tests.

## Rollout

1. Land code on the worktree branch — additive `feat` commits, no BREAKING.
2. Bump tea-rags plugin version (patch — text changes to an existing skill) per
   `.claude/rules/plugin-versioning.md`.
3. Self-test: `npm run build && npm link` (single-worktree rule), reconnect MCP,
   force reindex tea-rags (user-gated) → prime thresholds show `memberCount` /
   `fileSymbolCount`, `rank_chunks rerank=godModule` returns ranked files, full
   risk-assessment run on one domain exercises 1b + fix cost + Structural debt
   section.
4. Client projects pick the signals up at their next force reindex; until then
   the skill's fallback path covers god-class detection.

## Beads

Per `.claude/rules/.local/plan-beads-sync.md`: the implementation plan (next
step) creates one epic with 1:1 tasks. The previously discussed "symbol-mass
signal bead" is absorbed into this scope — no separate deferred bead remains.
