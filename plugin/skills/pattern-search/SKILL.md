---
user-invocable: false
---

# Pattern Search

Internal strategy for explore skill. Find all implementations of a pattern
across the codebase. SEED → EXPAND → DEDUPLICATE → GROUP.

**Invoked by explore when intent matches pattern-search triggers.**

## MANDATORY RULES

1. **Execute YOURSELF** — no subagents.
2. **No built-in Search/Grep for code discovery** — only TeaRAGs tools + ripgrep
   MCP as fallback.
3. **Always SEED then EXPAND** — never skip `find_similar` expansion.
4. **Deduplicate by content overlap** — skip chunks with >80% content overlap
   from same domain/directory.
5. **Group output by module/directory** — not flat list.

## Intent Classification

Explore has already classified the intent and extracted scope before delegating
here. Two values are passed:

- **strategy**: collect | spread | antipattern | reference
- **pathPattern**: glob string or none

## Strategy → Tool Mapping

| Strategy        | Seed tool                  | Seed rerank | Expand                                |
| --------------- | -------------------------- | ----------- | ------------------------------------- |
| **Collect**     | `semantic_search` limit=10 | `relevance` | `find_similar` from each unique seed  |
| **Spread**      | `search_code` limit=5      | `relevance` | `find_similar` from best seed         |
| **Antipattern** | `hybrid_search` limit=10   | `techDebt`  | `find_similar` from problematic seeds |
| **Reference**   | `semantic_search` limit=5  | `stable`    | `find_similar` from best seed         |

## Flow

```
1. SEED — strategy-specific search with rerank + pathPattern
2. EXPAND — find_similar from seed results (skip already-seen chunks)
3. DEDUPLICATE — skip chunks with >80% content overlap from same domain
4. GROUP — by module/directory
5. OUTPUT — grouped list with file:line citations + overlay labels
```

### 1. SEED

Run the strategy's seed tool with its rerank preset.

Parameters always include: `metaOnly=false`, strategy-specific `limit` and
`rerank`. Add `pathPattern` if scoped.

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
