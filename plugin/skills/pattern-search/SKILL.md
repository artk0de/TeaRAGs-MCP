---
name: pattern-search
description:
  Use when developer asks to find all implementations of a pattern, collect
  examples across modules, find antipatterns, or locate the best reference
  implementation — "find all X", "how is X done across modules", "antipatterns
  in X", "best example of X"
argument-hint:
  [pattern to find — e.g. "retry logic", "error handling in adapters"]
---

# Pattern Search

Find all implementations of a pattern across the codebase. SEED → EXPAND →
DEDUPLICATE → GROUP.

## MANDATORY RULES

1. **Execute YOURSELF** — no subagents.
2. **No built-in Search/Grep for code discovery** — only TeaRAGs tools + ripgrep
   MCP as fallback.
3. **Always SEED then EXPAND** — never skip `find_similar` expansion.
4. **Deduplicate by content overlap** — skip chunks with >80% content overlap
   from same domain/directory.
5. **Group output by module/directory** — not flat list.

## Strategy Selection

Classify $ARGUMENTS into exactly one strategy:

| Strategy        | Trigger keywords                                              | Seed tool                  | Seed rerank | Expand                                |
| --------------- | ------------------------------------------------------------- | -------------------------- | ----------- | ------------------------------------- |
| **Collect**     | "all", "every", "find all", "все", "каждый"                   | `semantic_search` limit=10 | `relevance` | `find_similar` from each unique seed  |
| **Spread**      | "across", "different modules", "в разных", "compare"          | `search_code` limit=5      | `relevance` | `find_similar` from best seed         |
| **Antipattern** | "antipattern", "bad", "wrong", "не так", "плохой"             | `hybrid_search` limit=10   | `techDebt`  | `find_similar` from problematic seeds |
| **Reference**   | "best", "correct", "proper", "правильно", "лучший", "example" | `semantic_search` limit=5  | `stable`    | `find_similar` from best seed         |

**Default:** Collect (if no keywords match).

## Scope Narrowing

Extract `pathPattern` from $ARGUMENTS if a module, directory, or domain is
mentioned:

- "retry in ingest" → `pathPattern="**/ingest/**"`
- "error handling in adapters" → `pathPattern="**/adapters/**"`
- "signals across trajectories" → `pathPattern="**/trajectory/**"`
- No scope mentioned → no pathPattern (search whole codebase)

Pass `pathPattern` to ALL tool calls (seed + expand).

## Flow

```
1. CLASSIFY — pick strategy from $ARGUMENTS
2. SCOPE — extract pathPattern if domain/module mentioned
3. SEED — run strategy-specific search
4. EXPAND — find_similar from seed results
5. DEDUPLICATE — remove >80% content overlap within same directory
6. GROUP — organize by module/directory
7. OUTPUT — grouped list with citations + overlay labels
```

### 1. CLASSIFY

Read $ARGUMENTS. Match trigger keywords → strategy. State chosen strategy.

### 2. SCOPE

Extract pathPattern. State it or "no scope restriction".

### 3. SEED

Run the strategy's seed tool with its rerank preset.

Parameters always include: `metaOnly=false`, strategy-specific `limit` and
`rerank`.

Note chunk IDs from results for expansion step.

### 4. EXPAND

For **Collect**: `find_similar` from each unique seed chunk (up to 5 seeds). For
**Spread/Reference**: `find_similar` from the single best seed. For
**Antipattern**: `find_similar` from seeds where overlay shows high
churn/age/bugFixRate (up to 3 problematic seeds).

Parameters: `limit=5` per find_similar call. Include `pathPattern` if scoped.

Track seen chunk paths. Skip already-seen.

### 5. DEDUPLICATE

Compare expanded results against seeds and each other:

- Same directory + >80% content overlap → keep only the one with richer signals
- Different directories → always keep both (that's the point of pattern search)

### 6. GROUP

Group results by top-level module directory (first 2 path segments after src/).

### 7. OUTPUT

```
Pattern: [pattern name from $ARGUMENTS]
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
