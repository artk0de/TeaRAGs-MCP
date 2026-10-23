---
name: analytics-rerank
description:
  Pick tea-rags rerank preset, build `{custom: {...}}` weight set, or compose
  analytics-driven search (ownership, tech-debt, hotspots, code-review,
  security-audit, fragile-silo). Covers rerank decision tree (documentation
  auto-preset vs explicit preset vs custom weights), preset catalog pointer
  (`tea-rags://guide/presets`), weight-key catalog pointer
  (`tea-rags://guide/signals`), recipes (e.g. Fragile Silo: `{ bugFix: 0.45,
  knowledgeSilo: 0.3, similarity: 0.15, churn: -0.1 }`). Invoke on intent like
  "rank by ownership", "find tech debt", "hotspot scan", "code review of recent
  changes", "security audit of auth code", "code that looks stable but breaks a
  lot", "custom weights for impact analysis". NOT for project health scan
  needing cross-preset overlap — use `tea-rags:risk-assessment`. NOT for debug
  root-cause — use `tea-rags:bug-hunt`. NOT for filter shape — use
  `tea-rags:filter-building`.
user-invocable: false
---

# Analytics Rerank

Rerank reorders search results by git + structural signals. Deep-dive: pick
preset, build custom weight set, apply recipe for a specific analytics question.

## Rerank decision tree

```
Documentation search? (language: "markdown" OR documentation: "only")
├─ Yes → no explicit rerank needed
│     → facade auto-applies "documentationRelevance" preset
│     → heading-weighted ranking is automatic
│     Optimal flow for navigating docs:
│       1. find_symbol(relativePath: "docs/file.md") — TOC of one doc, OR
│          hybrid_search/semantic_search with pathPattern: "**/docs/**" — to
│          discover which doc covers a topic
│       2. find_symbol(symbol: "doc:<hash>") — full content of ONE section;
│          hash from a TOC line or a doc result's symbolId (parentSymbolId is
│          the doc path → TOC, not a section)
│       3. Read — only when you need continuous prose spanning many sections
│
└─ No → continue to preset selection

Existing preset fits the analytics question?  (cheat sheet below)
├─ Yes → use it — even when you could hand-compose its signals. Preset =
│         curated weights; custom never replaces a matching preset. Read tea-rags://guide/presets for the full catalog with
│         weights and tools each preset is registered on.
│
└─ No → build custom weights. Read tea-rags://guide/signals for the
         canonical weight-key catalog (it is generated from the live
         registry; never invent weight key names from memory).
```

## Catalogs — always read on demand

Canonical sources, generated from live registry of THIS build. Memorized
training-data lists WILL drift.

```
ReadMcpResourceTool(server: "tea-rags", uri: "tea-rags://guide/presets")
ReadMcpResourceTool(server: "tea-rags", uri: "tea-rags://guide/signals")
ReadMcpResourceTool(server: "tea-rags", uri: "tea-rags://guide/signal-labels")
```

`guide/presets` = full preset list with weights + tools. `guide/signals` = every
weight key for `{custom: {...}}` mode. `guide/signal-labels` = how numeric
overlay values map to labels (`healthy` / `concerning` / `critical`, etc.) per
signal.

## Preset cheat sheet (when each is the right pick)

Catalog has full list; this is routing tier. Most specific row wins:
security-sensitive path (auth, crypto, payments, permissions, sessions) in the
question → `securityAudit`, even when it also says legacy / old / bug-fix
(`techDebt` row = legacy WITHOUT a security path).

| Question                                                                        | Preset                                                                                    |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| "Where are the bug-prone areas in domain X?"                                    | `hotspots`                                                                                |
| "Old + churny + bug-fixed legacy in domain X?"                                  | `techDebt`                                                                                |
| "Single-author silos / bus factor in domain X?"                                 | `ownership`                                                                               |
| "Review the recent changes in this area"                                        | `codeReview` (with `maxAgeDays: 7`)                                                       |
| "Old / untouched / legacy code (± bug-fix history) in security-sensitive paths" | `securityAudit` — named path → `pathPattern`; else `filter: { presets: "securityPaths" }` |
| "Recently modified, sprint-review style"                                        | `recent`                                                                                  |
| "Stable, low-bug template code"                                                 | `proven` / `stable`                                                                       |
| "Refactor candidates by size+volatility+bug-fix history"                        | `refactoring`                                                                             |
| "Bug-prone + volatile + high blast radius"                                      | `dangerous`                                                                               |
| "Find candidates to decompose"                                                  | `decomposition`                                                                           |
| "Blast radius before a change (real call edges)"                                | `blastRadius` (codegraph on) — else custom `{ imports: 0.5, churn: 0.3, ownership: 0.2 }` |
| "Structural backbone — high-fan-in hubs"                                        | `architecturalHub` (codegraph)                                                            |
| "Entry points / flow drivers of a scope"                                        | `entryPoint` (codegraph)                                                                  |

**Codegraph composites** (`blastRadius` / `architecturalHub` / `entryPoint`)
rank on real call/import edges (`fanIn`, `isHub`, `fanOutPerLine`). Meaningful
only when graph tools are registered (codegraph on); codegraph off → they
degrade to similarity — fall back to `imports`-proxy custom weights, say
centrality is approximate. See `tea-rags://guide/navigation` "Graph navigation".

## Custom weight recipes

No preset fits exactly → combine weight keys from `tea-rags://guide/signals`.
Format:

```jsonc
{ "rerank": { "custom": { "<weightKey>": <number>, ... } } }
```

Negative weights penalize a signal. Magnitudes not absolute — reranker
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

Surfaces files with `bugFixRate concerning+` + single live-line owner
(`knowledgeSilo` ≈ 1.0), despite low commit count (`churn` negative weight
penalizes high-churn files — want the SILENT fragile, not the obvious churner).
Files whose `commitCount` falls below confidence-clamp thresholds get
`bugFixRate.label` clamped to `healthy` — do NOT classify as Fragile silo even
if raw value high. Correct behavior of the unified confidence mechanism.

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

High `imports` = many files import this = wide blast radius. `churn` included:
high-churn high-import files are the genuine danger ("everyone depends on this
AND it keeps changing"). `ownership` surfaces single-owner high-impact files —
knowledge silo with reach.

**Prefer the `blastRadius` preset when codegraph is on:** ranks on real `fanIn`
(actual call/import edges) + churn + bugFix, not the raw `imports`-line proxy.
Use this custom recipe only as the codegraph-off fallback (result then
approximate — import-proxy, not edge truth).

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

Different from `ownership`. `recentActivityConcentration` = commit-window based
(recent committers), `ownership` = blame-based (live-line owners). Use for
review routing / "who's driving this area in the current sprint", not authority
questions.

### Security-sensitive legacy → preset, not custom

`securityAudit` already combines `age` + `pathRisk` + `bugFix` + `ownership`
(`pathRisk` = structural signal for auth / crypto / … paths). Never hand-compose
it. Age threshold stated by user ("untouched > 1 year") → time filter via
filter-building (`modifiedBefore: <today − 365d>` — file-level, query-time; raw
`git.file.ageDays` lags):

```jsonc
{
  "rerank": "securityAudit",
  "pathPattern": "src/auth/**",
  "modifiedBefore": "<ISO date, today − 365 days>",
}
```

## Reading the overlay back

Every reranked result (metaOnly too) carries
`rankingOverlay.{file,chunk}.<field>` — `{value,label}` for labelled signals
(table columns `<field>.value` / `<field>.label` when 2+ results). Labels live
only there; payload = raw. Read `references/runtime-introspection.md` for the
structure, `references/signal-interpretation.md` for pair diagnostics
disambiguating single-signal ambiguity (god module vs bug attractor, healthy
owner vs toxic silo, legacy minefield vs proven stable).

## Named filter presets — pairing with rerank

The `filter` param accepts `{ presets: "name" }` (or CSV `"a,b,c"` for AND
composition) in addition to the raw Qdrant filter object. These are mutually
exclusive forms: you pass either `{ presets: ... }` OR a raw filter object in
one call, not both.

Named presets are adaptive: thresholds are collection percentiles (e.g. p75 of
`commitCount`), not hardcoded numbers. Cold-start fallbacks apply when stats are
unavailable. The catalog is gated per trajectory: static presets are always
available; git/codegraph presets require those trajectories to be registered.

**High-value pairings (rerank preset → filter preset):**

| Analytics question                       | Rerank preset   | Filter preset      |
| ---------------------------------------- | --------------- | ------------------ |
| Old code in security paths               | `securityAudit` | `securityPaths`    |
| Fragile silo (silent, low-churn)         | custom (below)  | `fragileSilo`      |
| Bug-prone + volatile + high blast radius | `dangerous`     | `panicZone`        |
| Recently active legacy                   | `techDebt`      | `freshLegacyEdits` |
| Battle-tested critical modules           | `proven`        | `battleTested`     |

**Inventory-vs-query narrowing rule.** A HARD specific filter belongs to
query-absent inventory mode (the query is empty and you want a specific slice of
the codebase). When a natural-language query is present, rank broadly — don't
also hard-filter — so recall is not lost. Hygiene presets (`production`,
`coreLogic`) are safe in either mode and are the defaults applied automatically
by those rerank presets.

Full catalog: read `tea-rags://guide/filters` (generated from the live
registry). Do not memorize from training data — read on demand.

## Project calibration

Thresholds per codebase: `commitCount` 8 = "high" in one project, "typical" in
another. Before phrasing filter / weight in absolute numbers → read
`tea-rags://project/<alias>/metrics?language=<lang>&section=labelMap`
(ReadMcpResourceTool) — THIS project's percentile bands, source + test.

## When this skill does NOT apply

- Multi-dimensional cross-preset risk scan (overlap across 4 presets to classify
  tiers) → use `tea-rags:risk-assessment`. This skill = single preset or single
  custom weight set.
- Root-cause investigation of a concrete bug symptom → use `tea-rags:bug-hunt`.
- Picking filter shape (typed sugar vs raw filter, level=file vs chunk) → use
  `tea-rags:filter-building`.
- Generic exploration of unfamiliar code → use `tea-rags:explore`.

For rerank selection + custom weight composition, stay here.
