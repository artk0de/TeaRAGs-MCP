---
name: refactoring-scan
description:
  "Internal step invoked by $explore, $refactoring-planning, $risk-assessment.
  Multi-preset breadth-first scan for refactoring candidates."
---

# Refactoring Scan

Multi-preset breadth-first scan for refactoring candidates. Explore invokes on
broad-scope antipattern / refactoring intent (no specific entity).

**Trigger examples:**

- "what to refactor in explore"
- "cleanup ingest domain"
- "what needs refactoring across the project"
- "decomposition candidates in src/"

## MANDATORY RULES

1. **Execute YOURSELF** — no subagents.
2. **Tool choice + stop conditions from `tea-rags://guide/decision-tree`** —
   pass query + rerank + pathPattern, tree picks tool; gradient-drop /
   diminishing-returns / cross-preset rules, NO absolute score thresholds.
3. **No built-in Search/Grep for code discovery** — tea-rags tools; ripgrep MCP
   only for literal text (identifiers → `hybrid_search`).

Lag / drift ≠ licence to leave tea-rags (core). Own checkout, `changedFiles` > 0
→ incremental `index_codebase`; subagent / linked worktree → never reindex. →
`tea-rags://guide/freshness`.

## Flow

```
1. SCAN — 3 presets via `tea-rags://guide/decision-tree`
2. MERGE — cross-reference by symbolId
3. ENRICH — Tier 1: read code, classify
4. OUTPUT — tiered table
```

### 1. SCAN

Decision tree **3 times**, one rerank preset each:

- query ($ARGUMENTS) + pathPattern (scope extraction)
- limit=10, metaOnly=false (content needed for ENRICH; 3 × 10 chunks fits)
- stop conditions per preset

| Preset          | What it surfaces                                           |
| --------------- | ---------------------------------------------------------- |
| `refactoring`   | Large chunks + high churn — mechanical refactor candidates |
| `decomposition` | Oversized functions/classes — split candidates             |
| `hotspots`      | High churn + recent activity — stability risks             |

#### Filter presets (each scan call)

`filter: { presets: "godMethods" }` on all three (behavioral god-method chunks
pre-rerank → better signal/noise). Purely structural scan (no query, narrow
scope) → `filter: { presets: "coreLogic" }` (function/class chunks only).
`{presets}` ANDs w/ `pathPattern`.

**Empty-widen rule.** Query present AND all three `godMethods` scans empty →
re-run three presets w/ `filter: { presets: "coreLogic" }`, note in output:
`> strict filter (godMethods) returned no results — widened to coreLogic`.

### 2. MERGE

Cross-reference by `symbolId` (missing → `relativePath` + `startLine`).

| Overlap | Tier   | Meaning                                    |
| ------- | ------ | ------------------------------------------ |
| 3/3     | Tier 1 | High-value: large + churny + hot           |
| 2/3     | Tier 2 | Medium-value: two signals converge         |
| 1/3     | Tier 3 | Low-value: single signal, may not be worth |

### 3. ENRICH

**Tier 1 only.** Code already in results (metaOnly=false). Classify:

| Type              | Indicator                                           |
| ----------------- | --------------------------------------------------- |
| **Dead code**     | Unused methods, unreachable branches                |
| **God function**  | Single method > 80 lines, multiple responsibilities |
| **Duplication**   | Near-identical logic across files/modules           |
| **Complex logic** | Deep nesting, long condition chains                 |
| **Naming**        | Misleading names, inconsistent conventions          |

**Naming** = lexicon verdict, not taste (codegraph on = graph tools in tool
list):
`get_naming_lexicon(names=<Tier 1 identifiers>, language, pathPattern=<scope>)`,
one call per language (evidence never crosses languages) → `MISFIT` = Naming
candidate, Action `rename to <suggestion>`; `CONFORMS` = not candidate.
Codegraph off → Naming only w/ cited in-scope precedent. Extra seeds:
`get_ontology_report(pathPattern=<scope>, sections=["outliers","synonyms"])` —
each outlier / synonym deviant = Naming candidate, Action
`rename to <dominant.name>`.

### 4. OUTPUT

```
Refactoring scan: [scope]
Found: [N] candidates across [M] modules

## Tier 1 — High Value (appears in 3/3 presets)

| # | Symbol | File:Line | Type | Lines | Action |
|---|--------|-----------|------|-------|--------|
| 1 | Reranker.rerank() | reranker.ts:76 | god function | 72 | split into phases |
| 2 | ... | ... | ... | ... | ... |

## Tier 2 — Medium Value (appears in 2/3 presets)

| # | Symbol | File:Line | Presets | Lines |
|---|--------|-----------|---------|-------|
| 1 | ... | ... | refactoring+hotspots | ... |

## Tier 3 — Low Value (single preset only)

[count] candidates — omitted for brevity. Paginate with offset if needed.
```

Tier 3 listed as count only. User asks details → paginate.
