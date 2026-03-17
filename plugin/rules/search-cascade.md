# Search Cascade

**MANDATORY:** ALWAYS prefer TeaRAGs and ripgrep MCP over built-in Search/Grep.

## Session Start (EXECUTE IMMEDIATELY)

**BEFORE responding to the user's first message**, run these tools:

**1. Check and update index:**
- Call `get_index_status` for the current project path.
- If indexed → call `reindex_changes` (always, picks up recent changes).
- If not indexed → call `index_codebase`.

**2. Memorize label thresholds:**
- `get_index_metrics` → remember label values. Example: commitCount `{ low: 1, typical: 3, high: 8, extreme: 20 }` means 8 commits = "high" in THIS codebase.

**3. Detect available tools:**
- Check which structural tools are available (tree-sitter, ripgrep MCP).
- Remember what's available for this session.

## TeaRAGs Tool Selection

| Tool | When | Example |
|------|------|---------|
| `search_code` | **Exploration only.** Broad discovery, human-readable. NOT for generation/bug-hunt. | "show me everything related to pipeline jobs" → query="pipeline job creation", limit=10 |
| `semantic_search` | Analytics, structured JSON with overlay labels. Generation/bug-hunt context. | "batch create jobs pipeline" → query="...", limit=10 |
| `hybrid_search` | Find exact symbol definition. BM25 catches tokens semantic misses. | "where is disabled_reasons defined?" → query="def automations_disabled_reasons" |
| `rank_chunks` | Rank by git signals, no query. Top-N by churn, bugs, etc. | "most buggy functions here?" → rerank="bugHunt", pathPattern=\<files\> |
| `find_similar` | Find structurally similar code. Copy-paste bugs. | "same pattern elsewhere?" → from chunk ID of known result |
| `get_index_metrics` | Codebase signal thresholds and distributions. Once per session. | "what counts as high churn here?" → returns labelMap per signal |

**Skills for specific workflows:**
- `/tea-rags:explore` — understand how code works (breadth-first, human consumption)
- `/tea-rags:research` — investigate code before generating/modifying (verified, with overlay labels)
- `/tea-rags:bug-hunt` — find root cause of a specific bug (signal-driven)
- `/tea-rags:data-driven-generation` — generate code with strategy selection (requires research first)

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

## Pagination

All tools default to limit=10. Need more results → use offset (offset=10 for page 2, offset=20 for page 3). Same query, same pathPattern — just next page.

Different area or angle → new query, not offset.

## External Tools

| Task | Tool |
|------|------|
| Find call-sites / references | ripgrep pattern="ClassName.method" |
| Find implementations | ripgrep pattern="class ClassName" |
| Structural overview (methods, signatures) | tree-sitter `analyze_code_structure` |
| Find pattern across project (TODO, flags) | ripgrep |
| Understand code | Read file |

## Trust the Index

Search results are real code. Don't ripgrep to "verify" every result. Use ripgrep when you **need** it (call-sites, imports), not as ritual.

If results seem stale → check `driftWarning` in response → `reindex_changes`.

## PROHIBITED

- **Built-in Search/Grep** for code discovery — no git signals, no overlay labels
- **search_code** in generation/bug-hunt/research context — use `semantic_search` instead (need overlay labels + verification). `search_code` is fine for pure exploration (`/tea-rags:explore`).
- **git log / git diff** for code history — overlay already has git signals
- **Multiple semantic_search** for same area — one call, then read results
- **10+ ripgrep calls** instead of reading a file — just read it

## hybrid_search Fallback

If `hybrid_search` fails (needs `enableHybrid=true`), fall back to `semantic_search`.
