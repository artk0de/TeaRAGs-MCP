# HotspotsPreset Docstring Alignment — Design Spec

## Goal

Eliminate the three-way semantic conflict between `HotspotsPreset`'s JSDoc, its
own scoring weights, and the canonical "Hotspot method" definition in
`signal-interpretation.md`. The preset is **already** churn-centric in code; the
docstring is the only thing lying. Fix the docstring, do not touch behavior.

## Problem

`src/core/domains/trajectory/git/rerank/presets/hotspots.ts` currently declares:

```ts
/**
 * Identify frequently-changing, bug-prone code hotspots.
 */
readonly description = "Identify frequently-changing bug-prone code areas";
readonly weights: ScoringWeights = {
  similarity: 0.2,
  chunkSize: 0.1,
  chunkChurn: 0.15,
  chunkRelativeChurn: 0.15,
  burstActivity: 0.15,
  bugFix: 0.1,
  volatility: 0.15,
  blockPenalty: -0.15,
};
```

`bugFix` weight is `0.1` — the smallest non-penalty weight in the preset.
Churn-family weights total `0.45`. The JSDoc nonetheless claims "bug-prone" as a
co-equal property. Meanwhile
`.claude-plugin/tea-rags/rules/references/signal-interpretation.md` defines
"Hotspot method" pattern purely as
`chunk.relativeChurn ↑ + file.relativeChurn typical` — no bugFix term.

Outcome: an LLM agent reading the preset description treats `rerank: "hotspots"`
results as bug-history evidence and labels low-churn high-bugFixRate files as
"hotspots" — the exact misclassification the user flagged for
`update_package_invoice.rb` (commitCount=3, calm, bugFixRate=63%).

## Design Decisions

### D1: Rewrite docstring to match implementation

**File:** `src/core/domains/trajectory/git/rerank/presets/hotspots.ts:4-14`

Replace JSDoc with text that reflects the actual weighted signals:

```ts
/**
 * Surface frequently-changing code areas: chunks with high commit density,
 * recent activity bursts, and erratic timing patterns.
 *
 * Use when: "what's churning in this directory", "where is recent commit
 *   activity concentrated", "which chunks see merge contention".
 * Query examples: "validation logic", "request handlers", "scheduler".
 * Key signals: chunkChurn + chunkRelativeChurn (intra-file churn share),
 *   burstActivity (recent spike), volatility (erratic timing).
 * NOT for bug-history scoring — see BugHuntPreset for active fix-cycles, or
 *   use custom rerank weights with high `bugFix` for historical bug-prone code.
 * Compare: BugHuntPreset emphasizes burst+volatility+bugFix for active
 *   debugging; HotspotsPreset leans on chunk-level churn metrics for
 *   change-frequency analysis.
 */
```

Update `description` to:

```ts
readonly description = "Surface frequently-changing code areas (chunk-level churn, burst activity, timing volatility)";
```

### D2: Do NOT change weights

The `bugFix: 0.1` weight is preserved. Rationale:

- Removing `bugFix` entirely would be a breaking ranking shift for existing
  callers (`risk-assessment`, `refactoring-scan` skills, downstream search
  consumers).
- `0.1` is small enough that the preset is correctly churn-dominant; the
  residual bugFix contribution acts as a tiebreaker between two equally churning
  chunks, which is reasonable.
- The docstring fix alone resolves the semantic conflict — weights are
  consistent with the new wording.

### D3: Do NOT rename the preset

`rerank: "hotspots"` is the public API name and matches industry usage
(Tornhill/Feathers: "hotspot = high churn + high complexity"). Renaming would
break every caller in the codebase and external clients with no functional gain.

### D4: Update `overlayMask` comment, not contents

The current `overlayMask` includes `bugFixRate` — keep it there. It's a
secondary signal the agent should _see_ (especially as labeled overlay) even
when the preset's primary lens is churn. Removing it would hide useful
disambiguation context.

## Out of Scope

- Naming or surfacing the "bug-prone but stable" pattern → see
  `2026-05-14-fragile-silo-pattern-design.md`.
- Confidence-aware labels for `bugFixRate` → see
  `2026-05-14-bugfixrate-label-confidence-design.md`.
- Custom rerank recipe for bug-prone code → see
  `2026-05-14-fragile-silo-rerank-recipe-design.md`.

## Acceptance Criteria

1. `HotspotsPreset` JSDoc and `description` no longer contain the substring
   "bug-prone".
2. No change to `weights`, `tools`, `overlayMask`, or `name`.
3. No callers of `rerank: "hotspots"` observe behavior change.
4. Existing tests for `HotspotsPreset` (if any) still pass without modification.

## Plugin Version Bump

None. This spec touches only `src/` — no `.claude-plugin/` files.

## Effort

Minutes. Single-file docstring edit + one test (if behavior contract is asserted
anywhere).
