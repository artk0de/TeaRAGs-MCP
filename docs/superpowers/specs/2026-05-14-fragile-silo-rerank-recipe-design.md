# Fragile Silo Rerank Recipe — Design Spec

## Goal

Give users a copy-paste `custom` rerank recipe that _finds_ Fragile Silo files
via `semantic_search`, without requiring a new preset class. The recipe lives in
`.claude-plugin/tea-rags/rules/references/use-cases.md` where existing recipes
are documented.

## Problem

After `fragile-silo-pattern-design.md` ships, agents can _name_ the pattern when
overlay shows it. But they cannot _search_ for it — no named preset surfaces
low-churn high-bugFix files, and the existing `bugHunt` preset filters out calm
files (its `burstActivity 0.2` weight). To discover all Fragile Silos in a
codebase, a user currently has to hand-write rerank weights — and most won't,
because no documented recipe exists.

## Design Decisions

### D1: Recipe and weight rationale

```json
{
  "custom": {
    "bugFix": 0.45,
    "knowledgeSilo": 0.3,
    "similarity": 0.15,
    "churn": -0.1
  }
}
```

Rationale per term:

| Weight                | Why                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `bugFix: 0.45`        | Primary signal — historical bug-fix density. Largest single weight.                                 |
| `knowledgeSilo: 0.30` | Secondary signal — single live-line owner concentration (binary derived signal).                    |
| `similarity: 0.15`    | Keep query relevance — recipe still respects the user's search text.                                |
| `churn: -0.10`        | **Negative** weight suppresses true hotspots (high-churn files), isolating the calm-but-buggy zone. |

Total positive weight = 0.90, total negative = 0.10. Score remains in
predictable range.

**Small-N is auto-handled by the unified confidence mechanism.** After
`bugfixrate-label-confidence-design.md` ships, the `bugFix` derived signal score
is already dampened by `commitCount` via the `stats.confidence.score` block on
the `bugFixRate` raw descriptor. A file with `bugFixRate=67%` over 3 commits
contributes a heavily-dampened `bugFix` value to the recipe's weighted sum —
much less than a file with `bugFixRate=30%` over 200 commits. The recipe
inherits this dampening for free; no per-recipe `confidenceDampening` call
needed, no extra weight term. Recipes that name `bugFix` as a positive weight
automatically respect the confidence guarantees of the signal layer.

### D2: Documentation location and format

**File:** `.claude-plugin/tea-rags/rules/references/use-cases.md`

Add a section near the existing recipe collection. Existing structure (per quick
grep) uses tables linking use cases to tools and presets — extend that table
with a new row, plus a code block.

Table row:

```markdown
| Fragile Silo discovery | semantic_search + custom (`fragile-silo` recipe
below) | pathPattern by domain (e.g., `**/services/**`) |
```

Code block:

````markdown
### Recipe: Fragile Silo discovery

Find low-churn, historically buggy, single-owner files (Fragile Silo pattern
from signal-interpretation.md). Surfaces files that _look_ stable but have a
track record of regressions concentrated under one author.

```json
{
  "path": "/project",
  "query": "<domain or symptom keyword>",
  "rerank": {
    "custom": {
      "bugFix": 0.45,
      "knowledgeSilo": 0.3,
      "similarity": 0.15,
      "churn": -0.1
    }
  },
  "metaOnly": true,
  "pathPattern": "<optional domain glob>"
}
```

Read results expecting `bugFixRate concerning+` with `commitCount` in the
`typical` band. Files with `commitCount` below the confidence-clamp thresholds
(currently `< 5`) will have `bugFixRate.label` clamped to `typical` — they will
NOT classify as Fragile Silo even if raw value is high, because the structural
evidence is insufficient. This is correct behavior, inherited from the unified
confidence mechanism (`bugfixrate-label-confidence-design.md`). Pair confirmed
findings with the `Fragile silo` pattern entry in `signal-interpretation.md` for
remediation steps.
````

### D3: Cross-link from `signal-interpretation.md`

In the `Fragile silo` pattern section (spec 2), add a final line: _"To discover
Fragile Silo files via search, see the `Fragile Silo discovery` recipe in
`use-cases.md`."_

### D4: Negative-weight precedent check

`signal-interpretation.md` "Custom rerank weights" section already documents
negative weights (god-module detection uses
`{imports: 0.5, churn: 0.3, ownership: -0.2}`). The Fragile Silo recipe follows
the same idiom — no new patterns to teach.

## Out of Scope

- Promoting the recipe to a named preset — covered (deferred) in
  `bug-proneness-derived-signal-deferred-design.md`. Recipe is the lightweight
  first step; promotion happens only on repeated demand.
- Risk-assessment skill integration — risk-assessment runs presets in parallel,
  not custom recipes. If Fragile Silo surfaces enough to warrant a permanent
  risk-assessment lens, a preset becomes justified; until then, ad-hoc recipe is
  sufficient.

## Acceptance Criteria

1. `use-cases.md` contains a "Fragile Silo discovery" recipe with the exact
   weights from D1.
2. Cross-link from `signal-interpretation.md` Fragile silo pattern points to the
   recipe.
3. The recipe, applied to the user's brainstorm trigger project, ranks
   `update_package_invoice.rb` near the top of its scope.

## Plugin Version Bump

`tea-rags` plugin — **patch** bump (text addition to an existing rule file).

## Effort

15 minutes.
