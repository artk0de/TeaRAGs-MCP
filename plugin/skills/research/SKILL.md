---
name: research
description: Use when researching code before generating or modifying it — pre-generation investigation that identifies problematic zones, risk areas, and ownership for strategy selection
argument-hint: [area or feature to research before coding]
---

# Research

Pre-generation investigation. Discovers code area AND identifies problematic zones — high churn, bug-prone functions, ownership silos. Feeds into `/tea-rags:data-driven-generation`.

**Key difference from explore:** explore explains how code works. Research flags **where the risks are** for safe modification.

## Pre-checks

1. `get_index_status` → if indexed → `reindex_changes`. If not → `index_codebase`.
2. Confirm label thresholds loaded (`get_index_metrics` from session start).

## Flow

```
DISCOVER (semantic_search) → ASSESS (rank_chunks) → FLAG problematic zones →
  output: area + risk map + strategy recommendation
```

### 1. DISCOVER

`semantic_search` query=$ARGUMENTS, limit=10.

**Use filters to narrow scope:**
- `pathPattern` — if you know the module: `"**/workflow/pipelines/**"`
- `language` — if project is polyglot: `"ruby"`, `"typescript"`

Note top 3-5 file paths. These become pathPattern for step 2.

### 2. ASSESS SIGNALS

`rank_chunks` pathPattern=<files from step 1>, metaOnly=false.

**Use filters:**
- `pathPattern` — exact relativePath from step 1: `"{file1.rb,file2.rb}"`
- `language` — same as step 1
- `level` — "chunk" for ≤5 files, "file" for >5 files

Choose rerank by what you need:
- **Balanced** (default): `rerank={ "custom": { "bugFix": 0.25, "age": 0.2, "volatility": 0.2, "ownership": 0.15, "churn": 0.1, "stability": 0.1 } }`
- Risk-focused: `rerank="hotspots"` or `rerank="techDebt"`

### 3. FLAG PROBLEMATIC ZONES

Read overlay labels and **explicitly note** risk areas:

| Label combination | Flag |
|---|---|
| bugFixRate "critical" | HIGH RISK — frequent bug fixes |
| bugFixRate "concerning" + churnVolatility "erratic" | UNSTABLE — erratic patching |
| ageDays "legacy" + commitCount "low" | FRAGILE — old untouched code |
| dominantAuthorPct "silo" | OWNERSHIP RISK — single owner |
| churnRatio "concentrated" | HOTSPOT — one function absorbs churn |

Don't skip "healthy" signals — note them too. They indicate safe areas for modification.

### 4. OPTIONAL: DEEP TRACE

If step 1 results show method calls to trace:
- `hybrid_search` query="def method_name" — one symbol per query
- Or Read file if already known

## Output

```
Research complete for: [area]

Files: [list with pathPattern-ready format]
Language: [detected language]

Risk map:
  - file1.rb: bugFixRate "critical", ageDays "old" → HIGH RISK
  - file2.rb: bugFixRate "healthy", ageDays "legacy" → SAFE, stable
  - file1.rb#method_x: churnRatio "concentrated" → HOTSPOT

Strategy recommendation: [DEFENSIVE/STABILIZATION/CONSERVATIVE/STANDARD]
  because: [which signals drove the decision]

Domain owner: [author] ([dominantAuthorPct]%)
```

Invoke `/tea-rags:data-driven-generation` with these results.
