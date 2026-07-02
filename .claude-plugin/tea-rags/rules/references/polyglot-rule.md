# Polyglot Rule (MANDATORY)

**Applies when:** codebase polyglot at session start (2+ languages each >10% of
chunks).

**Problem:** Unfiltered semantic_search returns 100% dominant language. On
Ruby(66%)+TypeScript(34%) codebase, TypeScript invisible without language
filter.

**Rule:** Every search call spanning languages MUST split into per-language
calls. Applies to ALL skills — explore, bug-hunt, research, pattern-search,
refactoring-scan, data-driven-generation.

```
Is codebase polyglot? (detected at session start)
├─ No → single search call (no splitting needed)
│
└─ Yes
   ├─ Query targets specific language? (e.g., "Ruby models", "TS hooks")
   │   → single call with language filter
   │
   ├─ Query is cross-layer or language-neutral?
   │   → issue ONE call per major language, merge results
   │   Example: semantic_search("batch create", language="ruby")
   │          + semantic_search("batch create", language="typescript")
   │
   └─ find_similar from a seed?
       → seed is language-locked; if cross-layer needed,
         also search with language filter for other languages
```

## Enforcement checkpoints

- After any semantic_search/hybrid_search: verify result languages match query
  intent. Results 100% one language on polyglot codebase → re-search with
  explicit language filters.
- Pattern-search EXPAND: seed from language A, codebase has language B → also
  run find_similar with `language` filter for B.
- Research/bug-hunt: validate risk map / suspect list covers all relevant
  layers.

**Exception:** rank_chunks with pathPattern already scopes by directory —
language filter not needed if path constrains to one language layer.
