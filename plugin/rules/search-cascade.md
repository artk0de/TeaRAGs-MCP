# Search Cascade

**MANDATORY:** ALWAYS prefer TeaRAGs and ripgrep MCP over built-in Search/Grep.

## TeaRAGs Tool Selection

| Tool | When | Example |
|------|------|---------|
| `semantic_search` | Find code by intent, behavior, concept. First discovery call. | "how does batch job creation work" → `semantic_search` query="batch create jobs pipeline", limit=10 |
| `hybrid_search` | Find exact symbol definition. BM25 catches tokens semantic misses. | "where is automations_disabled_reasons defined?" → `hybrid_search` query="def automations_disabled_reasons" |
| `rank_chunks` | Rank code by git signals without query. Top-N by churn, bugs, etc. | "which functions are most buggy here?" → `rank_chunks` rerank="bugHunt", pathPattern=\<files\> |
| `find_similar` | Find code structurally similar to a known chunk. Copy-paste bugs. | "are there other places with the same pattern?" → `find_similar` from chunk ID |

**Key distinctions:**
- `semantic_search` — finds by **meaning**. "authentication logic" finds login code even if word "authentication" isn't there.
- `hybrid_search` — finds by **meaning + exact tokens**. Use when you know the symbol name. One symbol per query with definition keyword (`def`, `function`, `class`).
- `rank_chunks` — **no query needed**. Pure signal-based ranking. Use rerank presets: `bugHunt`, `hotspots`, `techDebt`, `ownership`, etc.
- `find_similar` — needs a **chunk ID** from previous search results. Finds structurally similar code.

## External Tools

| Tool | When | Example |
|------|------|---------|
| ripgrep MCP | Confirm identifier exists. Find call-sites. ONE call, specific pattern. | "who calls BatchCreate?" → `ripgrep` pattern="BatchCreate.call" |
| tree-sitter | Structural overview without reading files. Methods, signatures. | "what methods does this class have?" → `analyze_code_structure` |
| Read file | Understand code after finding it. Don't ripgrep 10 patterns — just read. | Found suspect via search → Read the function |

## Trust the Index

If the codebase is indexed — search results are real code. Don't ripgrep to "verify" every search result. Use ripgrep when you **need** it (call-sites, imports), not as ritual after every search.

If results seem stale → `reindex_changes` to update the index. Check `driftWarning` in search response.

## PROHIBITED

- **Built-in Search/Grep** for code discovery — no git signals, no overlay labels
- **search_code** — human-readable output only, use `semantic_search` instead
- **git log / git diff** for code history — TeaRAGs overlay already has git signals
- **Multiple semantic_search** for same area — one call, then read results
- **10+ ripgrep calls** instead of reading a file — read the file, it's faster

## hybrid_search Fallback

If `hybrid_search` fails (needs `enableHybrid=true`), fall back to `semantic_search`.
