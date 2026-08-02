---
user-invocable: false
---

# Refactoring Scan

Multi-preset breadth-first scan for refactoring candidates. Explore invokes when
antipattern/refactoring intent broad-scope (no specific entity).

**Examples that trigger this skill:**

- "what to refactor in explore"
- "cleanup ingest domain"
- "what needs refactoring across the project"
- "decomposition candidates in src/"

## MANDATORY RULES

1. **Execute YOURSELF** — no subagents.
2. **Tool selection via search-cascade decision tree** — don't hard-code tool
   choice. Pass query + rerank + pathPattern to search-cascade; it determines
   tool.
3. **Stop conditions from search-cascade** — follow gradient-drop /
   diminishing-returns / cross-preset rules. Do NOT use absolute score
   thresholds.
4. **No built-in Search/Grep for code discovery** — only TeaRAGs tools + ripgrep
   MCP fallback.

## Flow

```
1. SCAN — 3 presets via search-cascade
2. MERGE — cross-reference by symbolId
3. ENRICH — Tier 1: read code, classify
4. OUTPUT — tiered table
```

### 1. SCAN

Run search-cascade **3 times** with different rerank presets. For each:

- Pass query (from $ARGUMENTS) + pathPattern (from scope extraction) to
  search-cascade — it determines tool
- limit=10, metaOnly=false (content needed for ENRICH classification; 3 × 10 =
  30 chunks ≈ 30-60KB — fits in 1M context)
- Apply search-cascade stop conditions per-preset

| Preset          | What it surfaces                                           |
| --------------- | ---------------------------------------------------------- |
| `refactoring`   | Large chunks + high churn — mechanical refactor candidates |
| `decomposition` | Oversized functions/classes — split candidates             |
| `hotspots`      | High churn + recent activity — stability risks             |

#### Filter presets (apply to each scan call)

Pass `filter: { presets: "godMethods" }` on all three scan calls. This
pre-filters the Qdrant population to behavioral god-method chunks before
reranking, which raises signal-to-noise when the scope is behaviorally broad.
When the scan is purely structural (no query, scope is already narrow), use
`filter: { presets: "coreLogic" }` instead — it keeps only function/class chunks
and discards noise (imports, comments, config).

`{presets}` AND-composes with any `pathPattern` already in the call — both
constraints apply.

**Empty-widen rule.** When a query is present AND all three `godMethods` scan
results come back empty, re-run the three presets with
`filter: { presets: "coreLogic" }` (broader population) and note the widening in
output:
`> strict filter (godMethods) returned no results — widened to coreLogic`.

### 2. MERGE

Cross-reference all 3 presets' results by `symbolId` (or `relativePath` +
`startLine` if symbolId missing).

| Overlap | Tier   | Meaning                                    |
| ------- | ------ | ------------------------------------------ |
| 3/3     | Tier 1 | High-value: large + churny + hot           |
| 2/3     | Tier 2 | Medium-value: two signals converge         |
| 1/3     | Tier 3 | Low-value: single signal, may not be worth |

### 3. ENRICH

For **Tier 1 candidates only** (skip Tier 2/3 enrichment):

- Code content already in results (metaOnly=false). Use directly.
- Classify refactoring type:

| Type              | Indicator                                           |
| ----------------- | --------------------------------------------------- |
| **Dead code**     | Unused methods, unreachable branches                |
| **God function**  | Single method > 80 lines, multiple responsibilities |
| **Duplication**   | Near-identical logic across files/modules           |
| **Complex logic** | Deep nesting, long condition chains                 |
| **Naming**        | Misleading names, inconsistent conventions          |

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
