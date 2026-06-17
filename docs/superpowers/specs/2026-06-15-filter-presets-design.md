# Filter Presets — Design

**Date:** 2026-06-15 **Status:** Approved (brainstorming) — pending
implementation plan **Scope:** `domains/trajectory/*`, `domains/explore` (search
stage), `api/internal/infra/schema-builder.ts`, `api/internal/composition.ts`,
`contracts/types`, `.claude-plugin/tea-rags/skills/*`

## Problem

The raw `filter` param works but has two ergonomic gaps:

1. **The client must know which raw payload values pair with a given rerank
   preset.** Pairing `rerank: "techDebt"` with the right population (exclude
   tests/docs, old + churning) requires the caller to hand-author a Qdrant
   filter from knowledge they don't have.
2. **Even knowing the values, they live nowhere.** Thresholds are re-typed per
   call as magic numbers (`commitCount >= 9`) that don't port across
   repositories — `9` is high churn here, noise elsewhere.

## Goal

Named, **adaptive** filter bundles ("filter presets") that:

- are referenced through the **existing** `filter` param (no new param, no
  parallel "preset" class hierarchy);
- can be set as a **per-rerank-preset default** so the caller just picks a
  rerank preset and the right population comes with it;
- express thresholds as **adaptive boundaries** (collection percentiles) that
  scale per repository, not hardcoded numbers.

## Non-goals

- **Filtering on derived signals** (`chunkChurn`, `bugFix`, `recency`). Derived
  values are computed at rerank time from raw payload with query-time adaptive
  bounds; they are not in the payload and their distributions are not in Stats,
  so they cannot be pushed to a Qdrant pre-filter. Filters operate on **raw
  signals only**. (A derived signal's population is approximated by filtering
  its raw source — e.g. high `chunkChurn` ≈ `git.chunk.commitCount >= p75` — but
  the filter DSL references the raw key directly, not the derived name.)
- **Per-language pre-filtering.** A pushed pre-filter is a single threshold;
  per-language thresholds would require one query per language. Out of scope.
- **Filter composition algebra.** Multiple named presets AND together
  (`presets: "a,b"`); arbitrary combination beyond that is the raw `filter`
  escape hatch.

## Core constraint

**Qdrant filters operate on payload fields during the vector search (filtered
HNSW).** Two consequences shape the whole design:

- The filter can reference only what is physically in the payload — raw signals,
  not derived ones.
- The threshold must be a single concrete number at query time. "Adaptive" means
  the number is resolved from **collection Stats percentiles** (stable, computed
  at index time) — NOT the reranker's batch-relative p95 (which doesn't exist
  until after the query) and NOT per-language percentiles.

## User-facing interface

The existing `filter` param is overloaded. One discriminator key, `presets`,
accepting one or more names:

```ts
type FilterSpec =
  | QdrantFilter // raw — existing, backward-compatible
  | { presets: string }; // "name" OR "a,b,c" — comma-split, trimmed, AND'd, 1+ names
```

Discrimination: `"presets" in x` → named (split on `,`, trim, reject empty
segments, AND the resolved fragments); otherwise treat as raw `QdrantFilter`.

Symmetry with `rerank` (`string | {custom: weights}`): named bundles are the
curated points, the raw `filter` object is the custom/escape form. Polarity of
the wrapper is mirrored (rerank wraps the raw form, filter wraps the named form)
because the raw `filter` object already shipped and cannot break.

## RerankPreset default population

`RerankPreset` gains one optional field of the **same type** as the user param
(Uniform Access):

```ts
interface RerankPreset {
  weights: ScoringWeights;
  filter?: FilterSpec; // default population for this ranking
  // ...existing: overlayMask, groupBy, signalLevel, tools, name, description
}
```

### Resolution — replace semantics

```
effective = userFilter ?? preset.filter             // REPLACE, not merge
final     = resolve(effective) AND typedParams(minAgeDays, language, documentation, …)
```

- The explicit `filter` param **replaces** the preset default entirely (default
  only fills the empty slot — default-argument semantics, least surprise).
- `filter: {}` (empty raw) explicitly clears a preset default → unfiltered.
- Typed params and the resolved filter always AND (separate user axes).
- `relevance` NEVER carries a default filter (else a bare search silently
  filters).

## FilterPresetDef and adaptive conditions

Registry entry — a lightweight data declaration (no weights / tools /
overlayMask; it is NOT a `RerankPreset`):

```ts
interface FilterPresetDef {
  name: string;
  description: string;
  requires?: string[]; // trajectory gating, e.g. ["codegraph.symbols"]
  conditions: AdaptiveFilterCondition[];
}

type FilterThreshold =
  | number
  | {
      percentile: "p10" | "p25" | "p50" | "p75" | "p90" | "p95";
      fallback: number;
    };

interface AdaptiveFilterCondition {
  signal: string; // RAW payload key (logical form, e.g. "git.chunk.commitCount",
  //   "codegraph.file.instability", "isTest", "chunkType")
  op: "gte" | "lte" | "eq";
  value: FilterThreshold | string | boolean; // number/threshold for ranges; string/boolean for match
  occur?: "must" | "should" | "must_not"; // default "must"
}
```

Conditions compile to a `QdrantFilter` (`must` / `should` / `must_not` groups).

**Compilation semantics of `occur: "should"`.** A top-level Qdrant `should`
alongside any `must` is **score-only** — it does not exclude anything, so it is
meaningless in a pre-filter. Therefore `occur: "should"` conditions compile to a
**nested `must: [{ should: [...] }]` group** (at-least-one-required), not a
top-level `should`. This makes "any of these" populations expressible
(`panicZone`: recencyWeightedFreq required AND at least one of
bugFixRate/churnVolatility).

### Adaptive boundary resolution

- A `{percentile, fallback}` threshold resolves to
  `collectionStats.perSignal.get(<logicalKey>).percentiles[N]` — the **global**
  (collection-wide) percentile, mirroring `Reranker.resolveDampeningThreshold`.
- `fallback` (mandatory) is used when stats are cold / the percentile is absent
  (stale index). Never a silent zero.
- Fallback values are cold-start only; each repository's Stats override them.

### Three infrastructure requirements

1. **Global percentile, not per-language.** A pushed pre-filter is one threshold
   for the whole query. Filters read `perSignal` (global), accepting that a
   polyglot repo mixes languages in the percentile — acceptable for population
   selection, documented. **Follow-up:** when the `language` typed param (or a
   `fileExtension` that resolves to exactly one language) already scopes the
   query to a single language, resolve the threshold from `perLanguage` Stats
   for that language instead of the global `perSignal` — still a single number,
   but a more accurate boundary. Falls back to global when the language is
   ambiguous (multiple extensions / no language param).
2. **`percentilesToCompute` + validation.** The filter resolves at SEARCH stage,
   BEFORE rerank, so referenced percentiles must exist without lazy machinery.
   Every `pN` referenced by a filter preset is declared in the owning
   `PayloadSignalDescriptor.stats.percentilesToCompute` → computed at index
   time. `validateSignalDependencies` (composition-time, in
   `collection-stats.ts`) is extended to walk filter-preset percentile
   references and loud-fail on any undeclared `pN`. Mirrors the existing
   confidence-reference validation.
3. **Stats at search stage.** The filter resolver needs `collectionStats` at the
   search-strategy / `ExploreFacade` level (the Reranker already has them, but
   the filter is built earlier in the pipeline). New wiring touchpoint.

### Logical vs physical key (codegraph)

Codegraph signals are stored nested as `payload.codegraph.symbols.{scope}.X`.
Filter conditions author the **logical** key (`codegraph.file.instability`); the
resolver maps logical → physical Qdrant path
(`codegraph.symbols.file.instability`) via the same mapping used by
`resolvePayloadValue` in `collection-stats.ts` (extract to a shared helper —
single source). Percentile lookup uses the logical key (Stats are keyed
logically); the Qdrant condition uses the physical path. git/static keys are
already physical.

## Directory layout & ownership

Additive — sits beside the existing `filters.ts` (typed descriptors untouched;
they are deep-silo files). Mirrors `rerank/presets/` (one file per preset +
barrel):

```
domains/trajectory/
  static/
    filters.ts                      # existing typed FilterDescriptor[] — unchanged
    filter-presets/                 # NEW
      index.ts                      # STATIC_FILTER_PRESETS
      production.ts
      core-logic.ts
      security-paths.ts
  git/
    filters.ts                      # unchanged
    filter-presets/                 # NEW
      index.ts                      # GIT_FILTER_PRESETS
      fresh-legacy-edits.ts
      fragile-silo.ts
      panic-zone.ts
      god-methods.ts
  codegraph/symbols/
    filters.ts                      # unchanged
    filter-presets/                 # NEW (requires codegraph.symbols)
      index.ts                      # CODEGRAPH_FILTER_PRESETS
      hubs.ts
      dead-candidates.ts
      unstable-core.ts
  composite/
    presets/                        # existing composite rerank presets
    filter-presets/                 # NEW (requires git + codegraph)
      index.ts                      # COMPOSITE_FILTER_PRESETS
      battle-tested.ts
      abandoned-hotspots.ts
```

- Contracts: `FilterSpec`, `FilterPresetDef`, `AdaptiveFilterCondition`,
  `FilterThreshold` → `contracts/types/filter-preset.ts` (pure types, no Zod —
  contracts rule). Export via barrel.
- Each `filter-presets/` gets an `index.ts` barrel (barrel-files rule).
- Assembly in `composition.ts`: merge all `*_FILTER_PRESETS`, gate
  composite/codegraph entries via `requires` (mechanic of
  `buildCompositePresets`). A filter preset whose deps are not all registered
  drops from the enum AND from any rerank preset default (graceful — ranking
  stays, filter omitted).

## Filter preset catalog (initial)

Fallback values are cold-start only (informed by current tea-rags Stats).

| Preset              | requires          | Conditions (occur · signal · op · value)                                                                                                     |
| ------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `production`        | —                 | must_not isTest=true · must_not isDocumentation=true · must_not chunkType=block                                                              |
| `coreLogic`         | —                 | must chunkType ∈ {function,class} · must_not isTest=true                                                                                     |
| `securityPaths`     | —                 | must relativePath matches auth/crypto/secret/token/password/credential/permission/acl/oauth/jwt (pathPattern OR-group; static analog of the `pathRisk` derived signal) |
| `freshLegacyEdits`  | git               | must git.file.ageDays ≥ {p75, fb 60} · must git.chunk.ageDays ≤ 7                                                                            |
| `fragileSilo`       | git               | must git.file.blameContributorCount ≤ 1 · must git.chunk.commitCount ≥ {p75, fb 5}                                                           |
| `panicZone`         | git               | must git.file.recencyWeightedFreq ≥ {p50, fb 1} · should git.file.bugFixRate ≥ {p75, fb 30} · should git.file.churnVolatility ≥ {p75, fb 25} (should-group → nested must[{should}], at-least-one — see compilation semantics) |
| `godMethods`        | git               | must git.chunk.churnRatio ≥ 0.8 · must git.file.commitCount ≥ {p50, fb 5}                                                                    |
| `hubs`              | codegraph.symbols | must codegraph.file.isHub = true                                                                                                             |
| `deadCandidates`    | codegraph.symbols | must codegraph.chunk.fanIn = 0 · must chunkType = function (⚠ description must note: relies on method-edge resolution with low resolveSuccessRate — `lgt4`; hypothesis generator with false positives, not a verdict) |
| `unstableCore`      | codegraph.symbols | must codegraph.file.instability ≥ {p90, fb 0.9} · must codegraph.file.connectionCount ≥ {p50, fb 5}                                          |
| `battleTested`      | git               | must git.file.ageDays ≥ {p50, fb 30} · must git.file.bugFixRate ≤ {p25, fb 10} · must git.file.blameContributorCount ≥ 2                     |
| `abandonedHotspots` | git               | must git.file.commitCount ≥ {p75, fb 9} · must git.file.ageDays ≥ {p75, fb 42}                                                               |

Hygiene (`production`, `coreLogic`) overlaps with typed params by design — it
exists as a one-word convenience and as the target default for risk rankers.

## Default filter per rerank preset (target state)

`production` = must_not [isTest, isDocumentation, chunkType=block]. `coreLogic`
= chunkType ∈ {function,class} ∧ ¬isTest.

**Preset defaults are hygiene-only.** Specific filter presets (panicZone,
abandonedHotspots, hubs, …) are deliberately NOT preset defaults — they are
applied by **inventory-mode skills** and available to any caller via `{presets}`.
The rationale is functional and is detailed in the "Skill integration" section:
a hard specific filter as a default destroys recall for query-driven triage (the
bug/target often lives in non-churned code a specific filter would exclude),
while hygiene removal of tests/docs/block is safe in every mode.

| Rerank preset          | Default filter | Rationale                                  |
| ---------------------- | -------------- | ------------------------------------------ |
| relevance              | —              | bare search — never filter                 |
| documentationRelevance | —              | needs docs; `production` would strip them  |
| recent                 | —              | breadth matters                            |
| stable                 | —              | breadth (lightweight search_code preset)   |
| onboarding             | —              | needs docs                                 |
| codeReview             | —              | needs tests                                |
| proven                 | production     | reference = production code                 |
| ownership              | production     | silos of production code                    |
| bugHunt                | production     | drop test/doc/block noise, keep rank breadth |
| techDebt               | production     | same                                       |
| hotspots               | production     | same                                       |
| dangerous              | production     | same                                       |
| securityAudit          | production     | audit of production code (file-level)      |
| decomposition          | coreLogic      | only a method/class is a decomposition target |
| refactoring            | coreLogic      | same                                       |
| blastRadius            | production     | rank by fanIn, drop noise                  |
| architecturalHub       | production     | same                                       |
| entryPoint             | production     | composition roots are production           |

**Correctness landmines:** `documentationRelevance`, `onboarding`, `codeReview`
MUST NOT default to `production` — it strips the tests/docs those presets exist
to surface.

Specific filters move from "preset default" to **skill-applied policy** — see
the next section.

## Skill integration

The tea-rags skills (`.claude-plugin/tea-rags/skills/*`) are the layer that
decides _when_ to narrow a population with a specific filter preset. This is a
distinct workstream from the engine/registry.

### Governing principle — narrowing belongs to query-absent inventory

A **hard** specific filter belongs to **query-absent inventory** mode, where an
empty result is a valid answer ("nothing risky here"). In **query-driven
triage**, the engine must rank broadly and let the agent triage: the target
(a bug, a usage) frequently lives in **non-churned code that a specific filter
would exclude entirely** — e.g. a fresh edit in an otherwise stable file. There,
ranking (soft) strictly dominates gating (hard). Hygiene removal
(tests/docs/block) is safe in both modes.

Consequences:

- No engine-level auto-relaxation, no `populationRelaxed` DTO flag. The empty
  cliff is avoided **by construction** — query-driven skills never apply a hard
  specific filter, inventory skills treat empty as a valid answer.
- The specific filter presets exist for: (1) inventory skills applying them
  explicitly, (2) any caller using `{presets}` as a one-word narrowing shorthand.

### Skill taxonomy

| Mode | Skills | Filter behavior |
| --- | --- | --- |
| **Inventory** (query-absent, empty-valid) | risk-assessment, refactoring-scan (scan mode) | apply the dimension's specific filter via `{presets}`; empty dimension → report "clean", do NOT widen |
| **Reference-lookup** (need ≥1 template, empty-bad) | data-driven-generation, extract-project-patterns | apply `battleTested`; on empty, relax specific → hygiene, annotate |
| **Query-driven triage** (empty-bad, recall matters) | bug-hunt, explore | broad + ranking + agent triage; NO hard specific filter |
| **Meta / teaching** | analytics-rerank, filter-building | document the named filter presets, the inventory-vs-query rule, and `{presets}` syntax |

### Per-skill target policy

| Skill | Today | Target with filter presets |
| --- | --- | --- |
| **risk-assessment** | `rank_chunks` ×4 presets + manual `pathPattern` + manual two-pass dedup | each dimension applies its specific filter via `{presets}` (hotspots→godMethods, techDebt→abandonedHotspots, dangerous→fragileSilo, bugHunt-dim→panicZone); empty dimension reported as "clean"; the manual dedup hack is reduced since populations are pre-narrowed |
| **refactoring-scan** | 3 presets, query+pathPattern | apply `godMethods` / `coreLogic`; if a query is present and the strict result is empty, widen to `coreLogic` only and note it |
| **bug-hunt** | `rerank="bugHunt"`, top-10, agent triages | ranking UNCHANGED (keeps fresh-bug recall); MAY document an opt-in `{presets:"panicZone"}` "audit mode", but symptom search never hard-narrows |
| **explore** | rerank + hybrid fallback on 0 results | unchanged; no specific filter |
| **data-driven-generation / extract-project-patterns** | `proven` | apply `battleTested`; relax → `production` on empty (a reference is required) |
| **analytics-rerank** | teaches manual `preset + pathPattern` pairing | document the named filter presets, `{presets}` shorthand, adaptive-percentile semantics, and the inventory-vs-query narrowing rule |
| **filter-building** | builds raw/typed filter shapes | document `{presets}` shorthand and how it composes (AND) with typed params + raw filter |

### Empty handling by mode

- **Inventory:** empty = valid → report "no `<X>` in scope", do not widen.
- **Reference-lookup:** empty = bad → relax specific → hygiene, annotate the
  relaxation in the agent-facing summary.
- **Query-driven:** no specific filter applied → no filter-induced empty.

### Workstream

Teaching the skills is a separate set of epic tasks — one per skill in the
taxonomy. SKILL.md edits follow the skill-authoring rules; per the "no silent
skill patches" rule each edit lists what / why / how before applying.

## SchemaBuilder

- `filter` param schema → union `QdrantFilter | { presets: string }`. The
  `presets` value is a CSV string (an enum-of-CSV isn't natively expressible);
  the server splits and validates each name against the filter registry, unknown
  → typed `InputValidationError`. Registry names are surfaced in the param
  description and as an MCP resource for discovery.
- The rerank-preset enum is unchanged.
- `buildFilterParamSchema` mirrors the existing `buildPresetSchema`. This file
  recently churned (chunk bugFixRate "concerning") — change strictly via TDD.

## Backward compatibility & rollout

**Chosen: B2 — ship hygiene defaults immediately.** The hygiene-only preset
defaults (the table above) are enabled in this work as a single `feat(presets)!`:
every risk ranker begins excluding tests/docs/block. This is a behavior change
(noise removal) but a safe one — hygiene exclusion never causes a harmful empty
(see Skill integration → governing principle). `relevance` never gets a default.

The narrower **specific** filter presets are NOT part of the default rollout —
they are a separate, parallel workstream (the per-skill policy in Skill
integration) and reach users through skills and the `{presets}` param, not
through preset defaults.

Two coordinated streams, sequenced:

1. **Engine + registry + hygiene defaults** — `FilterSpec`, `FilterPresetDef`,
   resolver, validation, SchemaBuilder, the full filter-preset catalog, and the
   hygiene defaults wired onto presets. Lands as one `feat(presets)!`.
2. **Skill teaching** — one task per skill in the taxonomy, applying specific
   filters where the mode warrants (inventory / reference-lookup) and leaving
   query-driven skills broad. Depends on stream 1.

No engine auto-relaxation / `populationRelaxed` flag is built — the empty cliff
is avoided by construction (see Skill integration).

## Error handling

- Unknown filter-preset name (param or `presets` segment) → typed
  `InputValidationError` (facade-level validation), never silent drop.
- Empty `presets` string or all-empty segments → `InputValidationError`.
- Percentile referenced but support signal lacks it in Stats → `fallback`
  (stale-index escape), never silent zero.
- Filter preset gated out by `requires` → omitted from enum and from rerank
  defaults; referencing it explicitly → `InputValidationError` (not registered).

## Testing

- Filter resolver: raw passthrough; single name; CSV multiple (AND); unknown
  name → error; empty → error; percentile resolve from Stats; cold-stats →
  fallback; logical→physical codegraph key mapping.
- `RerankPreset.filter` default + replace semantics: user filter wins; `{}`
  clears; typed params AND on top.
- Gating: codegraph filter preset dropped when codegraph unregistered; its use
  in a rerank default degrades gracefully (ranking kept).
- `validateSignalDependencies`: loud-fail on undeclared filter percentile.
- SchemaBuilder: union shape, CSV validation, unknown-name error.
- `relevance` never defaults.
- Per-test-pattern rules: no rewrite of existing passing tests; behavioral
  integration tests over line-targeting.

## Open decisions for the plan phase

- Specific-filter threshold calibration (e.g. `abandonedHotspots` p75 AND p75 is
  narrow) — tune per inventory-skill use during stream 2.
- Whether `bug-hunt` ships an opt-in `{presets:"panicZone"}` "audit mode" doc, or
  leaves narrowing to `risk-assessment` entirely.
