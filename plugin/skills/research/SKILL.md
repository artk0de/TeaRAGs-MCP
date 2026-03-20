---
name: research
description:
  Use when researching code before generating or modifying it — pre-generation
  investigation that identifies problematic zones, risk areas, and ownership
argument-hint: [area or feature to research before coding]
---

# Research

Pre-generation investigation. Discovers code area AND identifies problematic
zones — high churn, bug-prone functions, ownership silos. Feeds into
`/tea-rags:data-driven-generation`.

**Key difference from explore:** explore explains how code works. Research flags
**where the risks are**.

## Pre-checks

1. `get_index_status` → if indexed → `reindex_changes`. If not →
   `index_codebase`.
2. Confirm label thresholds loaded (`get_index_metrics` from session start).

## Iteration Loop

```
SEARCH → CHECKPOINT → area fully mapped?
  YES → OUTPUT
  NO  → refine scope → SEARCH → CHECKPOINT → ...
```

**CHECKPOINT after every tool call.** Fill these fields:

- **Area mapped:** found all key files? \_\_\_
- **Risks flagged:** overlay labels read, problematic zones noted? \_\_\_

Both filled → **OUTPUT.** One empty → state what's missing, pick next tool.

## Steps

### 1. DISCOVER

Follow search-cascade decision tree with query=$ARGUMENTS, limit=10.

**Pass to search-cascade:**

- `pathPattern` — if module known: `"**/workflow/pipelines/**"`
- `language` — if polyglot: `"ruby"`, `"typescript"`

Note top 3-5 file paths → pathPattern for step 2.

### 2. ASSESS SIGNALS

Follow search-cascade with pathPattern=<files from step 1>, metaOnly=false. For
scoped analytics without a query, cascade selects rank_chunks.

**Pass to search-cascade:**

- `pathPattern` — exact relativePath: `"{file1.rb,file2.rb}"`
- `language` — same as step 1
- `level` — "chunk" for ≤5 files, "file" for >5

Choose rerank:

- **Balanced** (default):
  `rerank={ "custom": { "bugFix": 0.25, "age": 0.2, "volatility": 0.2, "ownership": 0.15, "churn": 0.1, "stability": 0.1 } }`
- Risk-focused: `rerank="hotspots"` or `rerank="techDebt"`

### 3. FLAG PROBLEMATIC ZONES

Read overlay labels. Note risk areas:

| Label combination                                   | Flag           |
| --------------------------------------------------- | -------------- |
| bugFixRate "critical"                               | HIGH RISK      |
| bugFixRate "concerning" + churnVolatility "erratic" | UNSTABLE       |
| ageDays "legacy" + commitCount "low"                | FRAGILE        |
| dominantAuthorPct "silo"                            | OWNERSHIP RISK |
| churnRatio "concentrated"                           | HOTSPOT        |
| bugFixRate "healthy" + ageDays "old"                | SAFE           |

### 4. OPTIONAL: DEEP TRACE

If results show method calls to trace:

- Follow search-cascade with symbol name (cascade → hybrid_search)
- Or Read file if already known

### 5. ITERATE OR OUTPUT

**CHECKPOINT:** Area mapped + risks flagged?

- YES → output
- NO → refine: narrower pathPattern, different query angle, offset for more
  results

## Output

```
Research complete for: [area]

Files: [list with pathPattern-ready format]
Language: [detected language]

Risk map:
  - file1.rb: bugFixRate "critical", ageDays "old" → HIGH RISK
  - file2.rb: bugFixRate "healthy", ageDays "legacy" → SAFE
  - file1.rb#method_x: churnRatio "concentrated" → HOTSPOT

Domain owner: [author] ([dominantAuthorPct]%)

Overlay labels: [raw labels for data-driven-generation to use]
```

Invoke `/tea-rags:data-driven-generation` with these results.
