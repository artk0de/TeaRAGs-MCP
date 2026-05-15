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
 * Surface frequently-changing code areas at chunk granularity: methods/blocks
 * with high commit density, recent activity bursts, and erratic timing.
 *
 * Use when: "which methods inside this file are churning", "where is recent
 *   commit activity concentrated at the chunk level", "what's been edited
 *   most often around this query".
 * Query examples: "validation logic", "request handlers", "scheduler".
 * Key signals: chunkChurn + chunkRelativeChurn (intra-file churn share, ~30%),
 *   burstActivity + volatility (recent timing pattern, ~30%),
 *   bugFix (~10%, minor — kept as historical tiebreaker between equally
 *   churning chunks; NOT a bug-history lens — for that use BugHuntPreset or
 *   custom rerank weights with high `bugFix`).
 * Compare: BugHuntPreset and HotspotsPreset overlap on temporal signals
 *   (burst, volatility); they differ in granularity. HotspotsPreset weighs
 *   chunk-scoped churn (`chunkChurn`, `chunkRelativeChurn`) — finds the
 *   problem method inside a file. BugHuntPreset weighs file-normalized
 *   churn (`relativeChurnNorm`) — finds the problem file.
 */
```

The `bugFix` mention is deliberately qualified as "minor, ~10%, tiebreaker"
rather than removed — accurate to the weights (D2) without re-implying
bug-history is the lens.

Update `description` to:

```ts
readonly description = "Surface frequently-changing code areas (chunk-level churn, burst activity, timing volatility)";
```

### D2: Do NOT change weights (keep `bugFix: 0.1`)

The `bugFix: 0.1` weight is preserved. Honest rationale:

- The `0.1` is a historical artifact — the original author conflated "hotspot"
  with "bug-prone" and added a small bugFix term. The weight is **not**
  engineered as a deliberate tiebreaker.
- Removing it would be a behavior-shifting change for `rerank: "hotspots"`
  consumers (`risk-assessment` skill, `refactoring-scan` skill, downstream
  search clients). Even at 0.1 weight, ranking would shift for files where
  bugFix was the decisive separator.
- Keeping it preserves backward compatibility, at the cost of accepting that the
  weight is residual.
- The JSDoc fix (D1) honestly acknowledges this: `bugFix` is mentioned as
  "minor, ~10%, kept as tiebreaker" — accurate to the weights without promising
  bug-history as the lens.

Alternatives considered and rejected:

- **Remove `bugFix` entirely** → `feat(presets)!:` breaking change; semantic
  purity but unjustified ranking shift for downstream consumers.
- **Lower to `0.05`** → splits the difference; still a ranking shift, still
  residual. Adds no clarity over current state.

If future evidence shows `bugFix` skews `rerank: "hotspots"` results in
practice, revisit as a separate spec with breaking-change scope.

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
- **Unified signal confidence mechanism** (label clamp + score dampening
  declared once per raw descriptor via `stats.confidence` block) → see
  `2026-05-14-bugfixrate-label-confidence-design.md`. This is where the small-N
  failure mode of `bugFixRate` is structurally resolved.
- Class-level anti-pattern about confidence-aware signal reading → see
  `2026-05-14-small-n-bugfixrate-anti-pattern-design.md`.
- Custom rerank recipe for bug-prone code → see
  `2026-05-14-fragile-silo-rerank-recipe-design.md`.

### Important: this spec ALONE does not fix the user's failure mode

The user's trigger case — agent calling a calm low-churn high-bugFixRate file a
"hotspot" — is **not** fully fixed by this spec. Even with corrected JSDoc, the
agent will continue to see `bugFixRate: { value: 63, ... }` in the ranking
overlay (D4 keeps it there intentionally for disambiguation), and may over-read
the raw value as a hotspot indicator.

The systemic fix requires this spec **combined with**:

- `2026-05-14-bugfixrate-label-confidence-design.md` — unified
  `stats.confidence` block applies BOTH categorical label clamp (so small-N
  ratios don't surface as `"critical"`) AND continuous score dampening (which
  already exists in the codebase but currently lives in scattered
  `dampeningSource`/`FALLBACK_THRESHOLD` declarations across derived-signal
  classes; the spec folds them into one descriptor).
- `2026-05-14-small-n-bugfixrate-anti-pattern-design.md` — class-level
  interpretation rule for any signal carrying `stats.confidence`. Agent applies
  it when reading raw values directly (overlay label is already clamped by the
  structural fix above).

Acceptance criteria for this spec are scoped to docstring alignment, not to the
end-to-end failure-mode fix.

### Analogous problem in `BugHuntPreset` — separate spec

`src/core/domains/trajectory/git/rerank/presets/bug-hunt.ts` has the same class
of mismatch — JSDoc/`description` claim "find potential bug hiding spots" with
weights
`burstActivity: 0.20 + volatility: 0.20 + relativeChurnNorm: 0.15 + bugFix: 0.15`.
The preset's primary signal mass is **active churn**, not bug-history; `bugFix`
gets only 15%. A future spec should align BugHuntPreset's docstring with its
weights (or rebalance the weights). Not in scope here.

## Acceptance Criteria

1. `HotspotsPreset` JSDoc and `description` no longer contain the substring
   "bug-prone".
2. JSDoc honestly lists `bugFix` as minor (~10%) with explicit "NOT a
   bug-history lens" caveat.
3. No change to `weights`, `tools`, `overlayMask`, or `name`.
4. No callers of `rerank: "hotspots"` observe behavior change.
5. **Pre-implementation check:** verify whether `description` propagates into
   MCP tool schema via `SchemaBuilder`
   (`src/core/api/internal/infra/schema-builder.ts`). If it does, the new
   `description` becomes part of the MCP-visible API surface — still
   semver-compatible (description-only change), but note in release notes.
6. **Pre-implementation check:** scan for snapshot tests covering preset
   `description` or JSDoc text. If found, regenerate snapshots intentionally.
7. Existing tests for `HotspotsPreset` (if any) still pass without modification.

## Plugin Version Bump

None. This spec touches only `src/` — no `.claude-plugin/` files.

The package itself (`package.json`) takes a **patch** bump under
`improve(presets)` since the MCP-visible description text changes; no ranking
behavior changes.

## Effort

~30 minutes if no snapshot regeneration needed; ~1 hour if snapshot tests exist
for preset descriptions and need regeneration. The acceptance-criteria checks 5
and 6 above are the time-variable parts.
