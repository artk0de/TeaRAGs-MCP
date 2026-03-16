# Search Cascade

## Three-Tool Cascade

Order: **intent → structure → exact match**.

| Axis | Tool | Use for |
|------|------|---------|
| Meaning / intent | TeaRAGs (`semantic_search`, `hybrid_search`, `find_similar`, `rank_chunks`) | Discovery, pattern finding, signal-based ranking |
| Structure / shape | tree-sitter (`analyze_code_structure`, `query_code`) | Classes, methods, signatures — without reading full files |
| Exact text / tokens | ripgrep (`search`, `count-matches`) | Call-sites, identifiers, TODOs, config keys |

## Verification After Semantic Search

Semantic search is a **candidate zone generator**, not proof.

**Prefer ripgrep over reading files.** ripgrep finds exact lines without loading entire files. Read full file only when ripgrep context is insufficient.

After TeaRAGs call:
1. **ripgrep** — confirm identifiers exist. 0 matches = false candidate, discard.
2. **tree-sitter** (if available) — structural overview without reading full files.
3. **Read file** — only the specific function/section, only if needed for more context.

**Fallback:** Grep/Glob if ripgrep/tree-sitter MCP unavailable.

## Anti-Patterns

| Anti-pattern | Correct approach |
|-------------|-----------------|
| Reading full files after semantic search | ripgrep for specific identifiers, read only needed section |
| ripgrep for "how does X work" | TeaRAGs semantic_search |
| TeaRAGs for exact method names | ripgrep |
| Multiple semantic_search calls for same area | One call, then ripgrep to narrow |
| `git log` / `git diff` for code history | TeaRAGs already has git signals in overlay |

## search_code Prohibition

Agents MUST use `semantic_search`, `hybrid_search`, `find_similar`, or `rank_chunks` — these return structured JSON with overlay labels. `search_code` is for human-readable output only.

## hybrid_search Fallback

If `hybrid_search` fails (needs `enableHybrid=true`), fall back to `semantic_search` with same parameters.
