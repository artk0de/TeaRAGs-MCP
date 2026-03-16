# Search Cascade

## Three-Tool Cascade

Use the right tool for each axis of code understanding. Order: **intent → structure → exact match**.

| Axis | Tool | Use for |
|------|------|---------|
| Meaning / intent | TeaRAGs (`semantic_search`, `hybrid_search`, `find_similar`, `rank_chunks`) | "How does X work?", discovery, pattern finding, signal-based ranking |
| Structure / shape | tree-sitter (`analyze_code_structure`, `query_code`) | Classes, methods, signatures, inheritance, structural overview |
| Exact text / tokens | ripgrep (`search`, `count-matches`) | Call-sites, exports, identifiers, TODOs, config keys, feature flags |

## Mandatory Verify

Semantic search is a **candidate zone generator**, not proof. After EVERY TeaRAGs call:

1. **tree-sitter** — structural overview of found files (methods, signatures, class hierarchy). Understand layout without reading entire files.
2. **ripgrep** — confirm call-sites, exports, actual identifiers exist. `ClassName.methodName` → N matches = real. 0 matches = false candidate, discard.
3. **filesystem** — read specific methods/sections confirmed by steps 1-2.

**Fallback:** If tree-sitter or ripgrep MCP unavailable, use built-in Grep and Glob tools.

Never trust semantic search results without verification. Generated code referencing unverified identifiers will contain hallucinated function names, import paths, or type names.

## Decision Shortcut

1. **Meaning / intent / behavior?** → TeaRAGs
2. **Classes / methods / signatures?** → tree-sitter
3. **Exact text / flags / TODO / config?** → ripgrep
4. **Need to read actual code?** → filesystem (read file)

## Anti-Patterns

| Anti-pattern | Why it's wrong | Correct approach |
|-------------|---------------|-----------------|
| ripgrep for "how does X work" | Grep matches syntax, not meaning | Use TeaRAGs semantic_search |
| TeaRAGs for exact method names | Semantic search may miss exact tokens | Use ripgrep for `"ClassName.method_name"` |
| tree-sitter for text search | Tree-sitter parses structure, not content | Use ripgrep for strings, comments, flags |
| Skipping tree-sitter, reading full files | Wastes tokens on large files | Use tree-sitter for structure overview first |
| Skipping verify after semantic search | Hallucinated identifiers in generated code | Always verify with ripgrep + tree-sitter |

## search_code Prohibition

`search_code` returns human-readable text without structured metadata or overlay labels. Agents MUST use:
- `semantic_search` — structured JSON with full git metadata and overlay labels
- `hybrid_search` — semantic + keyword matching (BM25), catches exact markers
- `find_similar` — find code similar to a known example
- `rank_chunks` — rank by signals without query (top-N by churn, bugs, etc.)

These tools return `rankingOverlay` with `{ value, label }` pairs that drive strategy selection.
