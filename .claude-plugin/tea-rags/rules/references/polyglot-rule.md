# Polyglot Rule (MANDATORY)

**Applies when:** codebase detected as polyglot at session start (2+ languages
each >10% of chunks).

**Problem:** Unfiltered semantic_search returns 100% dominant language. On a
Ruby(66%)+TypeScript(34%) codebase, TypeScript is completely invisible without
language filter.

**Rule:** Every search call that could span languages MUST be split into
per-language calls. This applies to ALL skills — explore, bug-hunt, research,
pattern-search, refactoring-scan, data-driven-generation.

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
  intent. If results are 100% one language on a polyglot codebase → re-search
  with explicit language filters.
- Pattern-search EXPAND: if seed is from language A and codebase has language B,
  also run find_similar with `language` filter for B.
- Research/bug-hunt: validate risk map / suspect list covers all relevant
  layers.

**Exception:** rank_chunks with pathPattern already scopes by directory —
language filter not needed if path already constrains to one language layer.
