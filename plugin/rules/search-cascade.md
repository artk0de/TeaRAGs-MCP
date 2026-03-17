# Search Cascade

**MANDATORY:** ALWAYS prefer TeaRAGs and ripgrep MCP over built-in Search/Grep.

## Session Start

On session start, call `get_index_status` for the current project:
- **Indexed + no drift** → ready to search.
- **Indexed + drift detected** → run `reindex_changes` before searching.
- **Not indexed** → run `index_codebase` first.

## TeaRAGs Tool Selection

| Tool | When | Example |
|------|------|---------|
| `semantic_search` | Find code by intent, behavior, concept. First discovery call. | "how does batch job creation work" → query="batch create jobs pipeline", limit=10 |
| `hybrid_search` | Find exact symbol definition. BM25 catches tokens semantic misses. | "where is disabled_reasons defined?" → query="def automations_disabled_reasons" |
| `rank_chunks` | Rank by git signals, no query. Top-N by churn, bugs, etc. | "most buggy functions here?" → rerank="bugHunt", pathPattern=\<files\> |
| `find_similar` | Find structurally similar code. Copy-paste bugs. | "same pattern elsewhere?" → from chunk ID of known result |
| `get_index_metrics` | Codebase signal thresholds and distributions. Once per session. | "what counts as high churn here?" → returns labelMap per signal |

**Key distinctions:**
- `semantic_search` — finds by **meaning**. Use for discovery.
- `hybrid_search` — finds by **meaning + exact tokens**. One symbol per query with definition keyword (`def`, `function`, `class`).
- `rank_chunks` — **no query**. Pure signal ranking. Presets: `bugHunt`, `hotspots`, `techDebt`, `ownership`, `refactoring`, `decomposition`.
- `find_similar` — needs **chunk ID** from previous results.

## Rerank Presets Quick Reference

| Preset | Signals | Use case |
|--------|---------|----------|
| `bugHunt` | burstActivity, volatility, bugFix, relativeChurn | Find bug-prone code |
| `hotspots` | chunkChurn, chunkRelativeChurn, burstActivity, bugFix | High-churn areas |
| `techDebt` | age, churn, bugFix, volatility, knowledgeSilo | Legacy assessment |
| `ownership` | knowledgeSilo, stability | Code ownership analysis |
| `stable` | stability, age | Find reliable templates |
| `refactoring` | chunkSize, density, churn | Decomposition candidates |

Custom: `rerank={ "custom": { "bugFix": 0.5, "churn": 0.3, "age": 0.2 } }`

For full preset details: `tea-rags://schema/presets`

## Filters Quick Reference

| Parameter | Example | Notes |
|-----------|---------|-------|
| `pathPattern` | `"**/workflow/**"` or `"{file1.rb,file2.rb}"` | Glob. Use exact relativePath from results when scoping |
| `language` | `"ruby"`, `"typescript"` | Filter by language |
| `minCommitCount` | `5` | High-churn code |
| `maxAgeDays` | `7` | Recent changes |
| `author` | `"John Doe"` | By dominant author |
| `chunkType` | `"function"`, `"class"` | By chunk type |
| `metaOnly` | `true` | Metadata only, no code content |

For full filter syntax: `tea-rags://schema/filters`
For signal labels: `tea-rags://schema/signal-labels`

## External Tools

| Tool | When | Example |
|------|------|---------|
| ripgrep MCP | Find call-sites, imports. ONE call, specific pattern. | "who calls BatchCreate?" → pattern="BatchCreate.call" |
| tree-sitter | Structural overview without reading files. | "what methods does this class have?" → `analyze_code_structure` |
| Read file | Understand code after finding it. | Found suspect → Read the function |

## Trust the Index

Search results are real code. Don't ripgrep to "verify" every result. Use ripgrep when you **need** it (call-sites, imports), not as ritual.

If results seem stale → check `driftWarning` in response → `reindex_changes`.

## PROHIBITED

- **Built-in Search/Grep** for code discovery — no git signals, no overlay labels
- **search_code** — human-readable only, use `semantic_search` instead
- **git log / git diff** for code history — overlay already has git signals
- **Multiple semantic_search** for same area — one call, then read results
- **10+ ripgrep calls** instead of reading a file — just read it

## hybrid_search Fallback

If `hybrid_search` fails (needs `enableHybrid=true`), fall back to `semantic_search`.
