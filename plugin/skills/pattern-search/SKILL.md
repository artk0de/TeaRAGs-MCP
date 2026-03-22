---
user-invocable: false
---

# Pattern Search

Internal strategy for explore skill. Find all implementations of a pattern
across the codebase. SEED → EXPAND → DEDUPLICATE → GROUP.

**Invoked by explore when intent matches pattern-search triggers.**

## MANDATORY RULES

1. **Execute YOURSELF** — no subagents.
2. **CRITICAL: search-cascade is the ONLY tool selection method.** Built-in
   Search, Grep, Glob, `grep`, `rg`, `find` are PROHIBITED for code discovery.
   If you catch yourself reaching for grep/search — STOP and use the
   search-cascade decision tree instead. The ONLY acceptable fallback is ripgrep
   MCP, and only after TeaRAGs tools returned no results.
3. **Follow search-cascade decision tree** for SEED tool selection.
4. **Always SEED then EXPAND** — never skip `find_similar` expansion.
5. **Deduplicate by content overlap** — skip chunks with >80% content overlap
   from same domain/directory.
6. **Group output by module/directory** — not flat list.

## Intent Classification

Explore has already classified the intent and extracted scope before delegating
here. Two values are passed:

- **strategy**: collect | spread | antipattern | reference
- **pathPattern**: glob string or none
- **query subject**: specific entity/pattern, or broad domain-level

## SEED Tool Selection

**Follow search-cascade decision tree** for tool selection. Do NOT hard-code
tool choice — search-cascade determines the tool based on query shape.

This skill provides to search-cascade:

- **query**: extracted pattern/entity from $ARGUMENTS
- **rerank**: from strategy table below
- **pathPattern**: from scope extraction
- **limit**: 15 for analytics tools, 10 for search tools
- **metaOnly**: false (need content for dedup + grouping)

## Strategy → Rerank Mapping

| Strategy        | Rerank preset                                                                                     | Expand                                |
| --------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Collect**     | `relevance`                                                                                       | `find_similar` from each unique seed  |
| **Spread**      | `relevance`                                                                                       | `find_similar` from best seed         |
| **Antipattern** | `techDebt`                                                                                        | `find_similar` from problematic seeds |
| **Reference**   | custom "proven": `{ similarity: 0.2, stability: 0.3, age: 0.3, bugFix: -0.15, ownership: -0.05 }` | `find_similar` from best seed         |

**Antipattern rerank override:** for broad scope queries (rank_chunks path), use
`refactoring` instead of `techDebt` — refactoring preset is tuned for large
chunks + churn, while techDebt favors age.

## Flow

```
1. SEED — search-cascade tool + strategy rerank + pathPattern
2. EXPAND — find_similar from seed results (skip already-seen chunks)
3. DEDUPLICATE — skip chunks with >80% content overlap from same domain
4. GROUP — by module/directory
5. OUTPUT — grouped list with file:line citations + overlay labels
```

### 1. SEED

Apply search-cascade decision tree to determine tool. Use strategy's rerank
preset. Set limit based on tool:

- `rank_chunks`: limit=15
- `semantic_search`: limit=10
- `hybrid_search`: limit=10
- `search_code`: limit=5

Parameters always include: `metaOnly=false`, rerank from strategy table. Add
`pathPattern` if scoped.

Note chunk IDs from results for expansion step.

### 2. EXPAND

For **Collect**: `find_similar` from each unique seed chunk (up to 5 seeds). For
**Spread/Reference**: `find_similar` from the single best seed. For
**Antipattern**: `find_similar` from seeds where overlay shows high
churn/age/bugFixRate (up to 3 problematic seeds).

Parameters: `limit=5` per find_similar call. Include `pathPattern` if scoped.

**Cross-domain diversification (Spread):** `find_similar` is vector-locked —
seed from domain A returns structurally similar code in domain A. To ensure
cross-domain coverage:

1. Check if EXPAND results span multiple top-level modules.
2. If results cluster in ≤2 modules → run an additional `semantic_search` with
   the pattern description (not code) + `pathPattern` excluding already-found
   modules. This finds semantically similar implementations in other domains
   that are structurally different.
3. On polyglot codebases: also run `find_similar` with `language` filter for
   each non-seed language (see Polyglot Rule in search-cascade).

Track seen chunk paths. Skip already-seen.

### 3. DEDUPLICATE

Compare expanded results against seeds and each other:

- Same directory + >80% content overlap → keep only the one with richer signals
- Different directories → always keep both (that's the point of pattern search)

### 4. GROUP

Group results by top-level module directory (first 2 path segments after src/).

### 5. OUTPUT

```
Pattern: [pattern name]
Strategy: [collect|spread|antipattern|reference]
Seed tool: [rank_chunks|semantic_search|hybrid_search|search_code]
Found: [N unique implementations across M modules]

## module-a/
- file1.ts:42 — ClassName.methodName(), brief description
  [age: stable, churn: low, owner: Alice]
- file1.ts:89 — helperFunction(), brief description
  [age: legacy, churn: high, owner: Bob]

## module-b/
- service.ts:15 — AnotherClass.method(), brief description
  [age: recent, churn: low, owner: Alice]
```

**Label mapping from overlay signals:**

Use labelMap from `get_index_metrics` (loaded at session start by
search-cascade). If absent in context, call `get_index_metrics` yourself. Map
raw signal values to the nearest labelMap threshold. See
`tea-rags://schema/signal-labels` for all label definitions.

If **Antipattern** strategy: add `⚠️` prefix to problematic implementations. If
**Reference** strategy: add `✓` prefix to the best example.
