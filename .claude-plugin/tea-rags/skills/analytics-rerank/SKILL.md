---
name: analytics-rerank
description:
  Pick a tea-rags rerank preset, build a `{custom: {...}}` weight set, or
  compose an analytics-driven search (ownership, tech-debt, hotspots,
  code-review, security-audit, fragile-silo). Covers the rerank decision tree
  (documentation auto-preset vs explicit preset vs custom weights), the
  preset catalog pointer (`tea-rags://schema/presets`), the weight-key catalog
  pointer (`tea-rags://schema/signals`), and concrete recipe combinations
  (e.g. Fragile Silo: `{ bugFix: 0.45, knowledgeSilo: 0.3, similarity: 0.15,
  churn: -0.1 }`). Invoke when the agent recognizes intent like "rank by
  ownership", "find tech debt", "hotspot scan", "code review of recent
  changes", "security audit of auth code", "code that looks stable but breaks
  a lot", "custom weights for impact analysis". NOT for general project
  health scanning that needs cross-preset overlap — use
  `tea-rags:risk-assessment`. NOT for debug-driven root-cause investigation
  — use `tea-rags:bug-hunt`. NOT for filter shape construction — use
  `tea-rags:filter-building`.
user-invocable: false
---

# Analytics Rerank

Rerank reorders search results by git and structural signals. This skill is the
deep-dive for: picking the right preset, building a custom weight set, and
applying a recipe for a specific analytics question.

## Rerank decision tree

```
Documentation search? (language: "markdown" OR documentation: "only")
├─ Yes → no explicit rerank needed
│     → facade auto-applies "documentationRelevance" preset
│     → heading-weighted ranking is automatic
│     Optimal flow for navigating docs:
│       1. find_symbol(relativePath: "docs/file.md") — TOC of one doc, OR
│          hybrid_search/semantic_search with pathPattern: "docs/**" — to
│          discover which doc covers a topic
│       2. find_symbol(symbol: "doc:<parentHash>") — drill into a specific
│          section taken from search result's parentSymbolId or from the TOC
│       3. Read — only when you need continuous prose spanning many sections
│
└─ No → continue to preset selection

Existing preset fits the analytics question?
├─ Yes → use it. Read tea-rags://schema/presets for the full catalog with
│         weights and tools each preset is registered on.
│
└─ No → build custom weights. Read tea-rags://schema/signals for the
         canonical weight-key catalog (it is generated from the live
         registry; never invent weight key names from memory).
```

## Catalogs — always read on demand

These are the canonical sources, generated from the live registry of THIS build.
Memorized lists from training data WILL drift.

```
ReadMcpResourceTool(server: "tea-rags", uri: "tea-rags://schema/presets")
ReadMcpResourceTool(server: "tea-rags", uri: "tea-rags://schema/signals")
ReadMcpResourceTool(server: "tea-rags", uri: "tea-rags://schema/signal-labels")
```

`schema/presets` gives the full preset list with weights and tools.
`schema/signals` gives every weight key available for `{custom: {...}}` mode.
`schema/signal-labels` explains how numeric overlay values map to labels
(`healthy` / `concerning` / `critical`, etc.) per signal.

## Preset cheat sheet (when each is the right pick)

The catalog has the full list; this is the routing tier.

| Question                                                 | Preset                                                |
| -------------------------------------------------------- | ----------------------------------------------------- |
| "Where are the bug-prone areas in domain X?"             | `hotspots`                                            |
| "Old + churny + bug-fixed legacy in domain X?"           | `techDebt`                                            |
| "Single-author silos / bus factor in domain X?"          | `ownership`                                           |
| "Review the recent changes in this area"                 | `codeReview` (with `maxAgeDays: 7`)                   |
| "Old code in security-sensitive paths"                   | `securityAudit` (with `pathPattern: "**/auth/**"`)    |
| "Recently modified, sprint-review style"                 | `recent`                                              |
| "Stable, low-bug template code"                          | `proven` / `stable`                                   |
| "Refactor candidates by size+volatility+bug-fix history" | `refactoring`                                         |
| "Bug-prone + volatile + high blast radius"               | `dangerous`                                           |
| "Find candidates to decompose"                           | `decomposition`                                       |
| "High-fan-in files (blast radius before a change)"       | custom `{ imports: 0.5, churn: 0.3, ownership: 0.2 }` |

## Custom weight recipes

When no preset fits the analytics question exactly, combine weight keys from
`tea-rags://schema/signals`. Format:

```jsonc
{ "rerank": { "custom": { "<weightKey>": <number>, ... } } }
```

Negative weights penalize a signal. Magnitudes are not absolute — the reranker
normalizes per-query. Keep total magnitude ≈ 1.0 for sane ranking.

### Fragile Silo (looks stable, breaks a lot, single-author)

```jsonc
{
  "rerank": {
    "custom": {
      "bugFix": 0.45,
      "knowledgeSilo": 0.3,
      "similarity": 0.15,
      "churn": -0.1,
    },
  },
  "metaOnly": true,
}
```

Surfaces files with `bugFixRate concerning+` and single live-line owner
(`knowledgeSilo` ≈ 1.0), despite low commit count (`churn` negative weight
penalizes high-churn files — we want the SILENT fragile, not the obvious
churner). Files whose `commitCount` falls below confidence-clamp thresholds will
have `bugFixRate.label` clamped to `healthy` — they do NOT classify as Fragile
silo even if raw value is high. This is correct behavior of the unified
confidence mechanism.

### Impact analysis (blast radius before a change)

```jsonc
{
  "rerank": {
    "custom": {
      "imports": 0.5,
      "churn": 0.3,
      "ownership": 0.2,
    },
  },
  "metaOnly": true,
}
```

High `imports` = many files import this one = wide blast radius. `churn` is
included because high-churn high-import files are the genuine danger ("everyone
depends on this AND it keeps changing"). `ownership` surfaces single-owner
high-impact files — knowledge silo with reach.

### Active driver concentration (who's mentally loaded right now)

```jsonc
{
  "rerank": {
    "custom": {
      "recentActivityConcentration": 0.5,
      "burstActivity": 0.3,
      "similarity": 0.2,
    },
  },
}
```

Different from `ownership`. `recentActivityConcentration` is commit-window based
(recent committers), `ownership` is blame-based (live-line owners). Use this for
review routing / "who's driving this area in the current sprint", not authority
questions.

### Security-sensitive legacy

```jsonc
{
  "rerank": {
    "custom": {
      "age": 0.3,
      "pathRisk": 0.3,
      "bugFix": 0.2,
      "ownership": 0.1,
      "volatility": 0.1,
    },
  },
  "pathPattern": "**/auth/**",
}
```

`pathRisk` is the structural signal that flags security-sensitive paths (auth,
crypto, etc.). Combined with age and bug-fix history, surfaces "old code in a
critical path that still gets bug-fixed" — prime audit target.

## Reading the overlay back

Every reranked result carries `rankingOverlay.derived` (normalized 0-1 signal
contributions) and `rankingOverlay.raw.{file,chunk}` (raw payload values with
labels). Read `references/runtime-introspection.md` for the structure and
`references/signal-interpretation.md` for pair diagnostics that disambiguate
single-signal ambiguity (god module vs bug attractor, healthy owner vs toxic
silo, legacy minefield vs proven stable).

## Project calibration

Thresholds vary by codebase. A `commitCount` of 8 is "high" in one project and
"typical" in another. Call `get_index_metrics(project: "<alias>")` and read
`signals[language][signalKey][scope].labelMap` for THIS project's
percentile-based thresholds before phrasing a filter or weight in absolute
numbers. See `references/runtime-introspection.md` for the calibration recipe.

## When this skill does NOT apply

- Multi-dimensional cross-preset risk scan (uses overlap across 4 presets to
  classify tiers) → use `tea-rags:risk-assessment`. This skill is for picking a
  single preset or building a single custom weight set.
- Root-cause investigation of a concrete bug symptom → use `tea-rags:bug-hunt`.
- Picking filter shape (typed sugar vs raw filter, level=file vs chunk) → use
  `tea-rags:filter-building`.
- Generic exploration of unfamiliar code → use `tea-rags:explore`.

For rerank selection and custom weight composition, stay here.
