---
name: pattern-search
description:
  "Internal step invoked by /explore, /risk-assessment. Internal strategy for
  explore skill."
---

# Pattern Search

> **Resources in Cursor:** if a `tea-rags://` resource cannot be read (no
> resource tool, or the read fails), run
> `tea-rags resource "<uri>" --path "$PWD"` in the terminal — same content.

Internal strategy for explore skill. Find all pattern implementations across
codebase. SEED → EXPAND → DEDUPLICATE → GROUP.

**Invoked by explore when intent matches pattern-search triggers.**

## MANDATORY RULES

1. **Execute YOURSELF** — no subagents.
2. **CRITICAL: `tea-rags://guide/decision-tree` is ONLY tool selection method.**
   Built-in Search, Grep, Glob, `grep`, `rg`, `find` PROHIBITED for code
   discovery. Catch yourself reaching for grep/search — STOP, use
   `tea-rags://guide/decision-tree` decision tree. ONLY acceptable fallback:
   text search, only after TeaRAGs tools returned no results, and only for
   literal text (markers, phrases, regex). Identifiers (class/method/constant)
   never: empty `find_symbol` → partial name, then `hybrid_search`
   (`tea-rags://guide/decision-tree`).
3. **Follow `tea-rags://guide/decision-tree` decision tree** for SEED tool
   selection.
4. **Always SEED then EXPAND** — never skip `find_similar` expansion.
5. **Deduplicate by content overlap** — skip chunks >80% content overlap from
   same domain/directory.
6. **Group output by module/directory** — not flat list.

**Lag ≠ unusable:** `changedFiles` / `pendingFiles` / `floors: []` / drift on an
answer = distance index↔tree, never licence for Bash `cat` / `sed` / `grep` /
`rg` or `Read` over code. Row without `treeState` = current; `treeState` row →
`find_symbol` re-call. Own checkout with `changedFiles` > 0 → incremental
`index_codebase` now (drift `--force`: ask separately, keep working); subagent /
linked worktree → never reindex. Protocol: `tea-rags://guide/freshness` "Lag
never licenses leaving tea-rags".

## Intent Classification

Explore already classified intent + extracted scope before delegating here. Two
values passed:

- **strategy**: collect | spread | antipattern | reference
- **pathPattern**: glob string or none
- **query subject**: specific entity/pattern, or broad domain-level

## SEED Tool Selection

**Follow `tea-rags://guide/decision-tree` decision tree** for tool selection. Do
NOT hard-code tool choice — `tea-rags://guide/decision-tree` determines tool
from query shape.

This skill provides to `tea-rags://guide/decision-tree`:

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
`refactoring` instead of `techDebt` — refactoring preset tuned for large
chunks + churn, techDebt favors age.

## Flow

```
1. SEED — `tea-rags://guide/decision-tree` tool + strategy rerank + pathPattern
2. EXPAND — find_similar from seed results (skip already-seen chunks)
3. DEDUPLICATE — skip chunks with >80% content overlap from same domain
4. GROUP — by module/directory
5. OUTPUT — grouped list with file:line citations + overlay labels
```

### 1. SEED

Apply `tea-rags://guide/decision-tree` decision tree to determine tool. Use
strategy's rerank preset. Set limit by tool:

- `rank_chunks`: limit=15
- `semantic_search`: limit=10
- `hybrid_search`: limit=10
- `search_code`: limit=5

Parameters always include: `metaOnly=false`, rerank from strategy table. Add
`pathPattern` if scoped.

Note chunk IDs from results for expansion step.

### 2. EXPAND

**Collect**: `find_similar` from each unique seed chunk (up to 5 seeds).
**Spread/Reference**: `find_similar` from single best seed. **Antipattern**:
`find_similar` from seeds where overlay shows high churn/age/bugFixRate (up to 3
problematic seeds).

Parameters: `limit=5` per find_similar call. Include `pathPattern` if scoped.

**Cross-domain diversification (Spread):** `find_similar` vector-locked — seed
from domain A returns structurally similar code in domain A. Ensure cross-domain
coverage:

1. Check if EXPAND results span multiple top-level modules.
2. If results cluster in ≤2 modules → run additional `semantic_search` with
   pattern description (not code) + `pathPattern` excluding already-found
   modules. Finds semantically similar implementations in other domains,
   structurally different.
3. Polyglot codebases: also run `find_similar` with `language` filter per
   non-seed language (see Polyglot Rule in `tea-rags://guide/decision-tree`).

Track seen chunk paths. Skip already-seen.

### 3. DEDUPLICATE

Compare expanded results against seeds and each other:

- Same directory + >80% content overlap → keep only one with richer signals
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

Filtering / labelling by signal → read
`tea-rags://project/<alias>/metrics?language=<lang>&section=labelMap`
(FetchMcpResource) once; chunk's language + scope (`source` / `test`) bands. Map
raw value to nearest band. Label meanings: `tea-rags://guide/signal-labels`.

If **Antipattern** strategy: add `⚠️` prefix to problematic implementations. If
**Reference** strategy: add `✓` prefix to best example.
