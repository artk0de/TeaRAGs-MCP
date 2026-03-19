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

## SEED Tool Selection (search-cascade)

Follow the search-cascade decision tree to pick the right SEED tool. The
strategy provides the rerank preset; the cascade provides the tool.

```
Has specific entity/pattern in query?
│
├─ NO (broad scope query, e.g. "what to refactor in ingest")
│  └─ rank_chunks
│     + pathPattern (required — scope defines what to rank)
│     + rerank from strategy table
│     + limit=15, metaOnly=false
│
└─ YES (named pattern, e.g. "error handling", "retry logic")
   │
   ├─ Have symbol name? (e.g. "retryWithBackoff", "EnrichmentCoordinator")
   │  └─ hybrid_search + rerank from strategy table
   │
   ├─ Strategy = Antipattern AND query has marker words?
   │  (TODO, FIXME, deprecated, hack, any, cast)
   │  └─ hybrid_search (BM25 catches markers + semantic catches patterns)
   │     + rerank from strategy table
   │
   └─ Describing behavior/intent (e.g. "error handling", "retry logic")
      └─ semantic_search + rerank from strategy table
```

## Strategy → Rerank Mapping

| Strategy        | Rerank preset | Expand                                |
| --------------- | ------------- | ------------------------------------- |
| **Collect**     | `relevance`   | `find_similar` from each unique seed  |
| **Spread**      | `relevance`   | `find_similar` from best seed         |
| **Antipattern** | `techDebt`    | `find_similar` from problematic seeds |
| **Reference**   | `stable`      | `find_similar` from best seed         |

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

- ageDays < 30 → "recent", 30-90 → "stable", > 90 → "legacy"
- commitCount < 3 → "low churn", 3-10 → "moderate", > 10 → "high churn"
- dominantAuthorPct > 80% → show single owner name

If **Antipattern** strategy: add `⚠️` prefix to problematic implementations. If
**Reference** strategy: add `✓` prefix to the best example.
