# Search Use Cases

Organized by agent task. Each references a Decision Tree branch from
`search-cascade.md`.

## Discovery (don't know the naming)

| Task                              | Tool (via tree)                | Example                                                |
| --------------------------------- | ------------------------------ | ------------------------------------------------------ |
| Find subsystem by description     | semantic_search                | "retry logic after failure" → retryWithBackoff         |
| Find frontend for backend concept | semantic_search × per language | "batch create jobs" → one call per language layer      |
| Find similar pattern              | find_similar                   | Found retry in cohere → find_similar → retry in ollama |

## Analytics (rerank-driven)

| Task                         | Tool + rerank                           | Example                                                |
| ---------------------------- | --------------------------------------- | ------------------------------------------------------ |
| Where bugs hide              | semantic_search/rank_chunks + bugHunt   | "error handling in payments domain"                    |
| What to refactor first       | rank_chunks + refactoring               | pathPattern="\*\*/payments/\*\*"                       |
| Bus factor risk              | rank_chunks + ownership                 | Single dominant author areas                           |
| Hotspots                     | semantic_search + hotspots              | "payment processing", pathPattern="\*\*/payments/\*\*" |
| Most unstable code in domain | semantic_search + hotspots or custom    | pathPattern for domain scope                           |
| Recent changes for review    | semantic_search + codeReview            | maxAgeDays=7                                           |
| Fragile Silo discovery       | semantic_search + custom (recipe below) | pathPattern by domain (e.g. `**/services/**`)          |

### Recipe: Fragile Silo discovery

Find low-churn, historically buggy, single-owner files (Fragile silo pattern
from `signal-interpretation.md`). Surfaces files that _look_ stable but have a
track record of regressions concentrated under one author.

```json
{
  "path": "/project",
  "query": "<domain or symptom keyword>",
  "rerank": {
    "custom": {
      "bugFix": 0.45,
      "knowledgeSilo": 0.3,
      "similarity": 0.15,
      "churn": -0.1
    }
  },
  "metaOnly": true,
  "pathPattern": "<optional domain glob>"
}
```

Read results expecting `bugFixRate concerning+` with `commitCount` in the
`typical` band. Files with `commitCount` below the confidence-clamp thresholds
(currently `< 5`) will have `bugFixRate.label` clamped to `healthy` — they will
NOT classify as Fragile silo even if raw value is high, because the structural
evidence is insufficient. This is correct behavior, inherited from the unified
confidence mechanism. Pair confirmed findings with the `Fragile silo` pattern
entry in `signal-interpretation.md` for remediation steps.

## Exhaustive usage (need ALL references)

| Task                     | Tool (via tree)        | Example                                              |
| ------------------------ | ---------------------- | ---------------------------------------------------- |
| All callers / all usages | hybrid_search + offset | BM25 = full recall, dense = semantic context         |
| Safe to delete / rename  | hybrid_search + offset | BM25 catches exact name, dense finds indirect usages |
| Impact of change         | hybrid_search + offset | BM25 + dense finds domain and all dependents         |

## Exact symbol search

| Task                      | Tool (via tree) | Example                                           |
| ------------------------- | --------------- | ------------------------------------------------- |
| Symbol definition         | find_symbol     | "Reranker.rerank" → instant, no embedding         |
| Symbol exists?            | find_symbol     | metaOnly=true, 0 results = doesn't exist          |
| Symbol has tests?         | find_symbol     | symbol + pathPattern for test dirs, metaOnly=true |
| Symbol + semantic context | hybrid_search   | "PaymentService validate card expiration"         |
| Bare symbol name          | find_symbol     | "batch_create" → direct lookup by symbolId        |
| TODO/FIXME markers        | ripgrep MCP     | Exact string match, not hybrid                    |

## Code context for generation

| Task                 | Tool + rerank                    | Example                                  |
| -------------------- | -------------------------------- | ---------------------------------------- |
| Find stable template | semantic_search + stable         | Low churn = proven pattern               |
| Find fresh example   | semantic_search + recent         | Latest changes = current style           |
| Assess change impact | semantic_search + custom weights | imports: 0.5, churn: 0.3, ownership: 0.2 |

## External tools (complement tea-rags)

- **Call-sites, imports, exact patterns** → ripgrep MCP (not tea-rags)
- **File structure (methods, classes)** → tree-sitter
- **Read specific lines** → Read with offset + limit (not whole file)
- **Spec/test file content** → tea-rags with pathPattern targeting test dirs. If
  index returns 0 chunks (specs excluded via `.contextignore`), fall back to
  ripgrep MCP.
