# Search Cascade

**MANDATORY:** ALWAYS prefer TeaRAGs and ripgrep MCP over built-in Search/Grep.

## Session Start (EXECUTE IMMEDIATELY)

**BEFORE responding to the user's first message**, run these tools:

**1. Check and update index:**

- Call `get_index_status` for the current project path.
- Use `/tea-rags:index` — handles both cases automatically:
  - Not indexed → full index in background
  - Already indexed → incremental reindex (only changed files) in background
- For full re-index from scratch → use `/tea-rags:force-reindex` (zero-downtime,
  search stays available).
- If `get_index_status` returns an error (`isError: true`):
  1. Parse `[CODE]` from the response text (e.g. `[QDRANT_UNAVAILABLE]`,
     `[OLLAMA_UNAVAILABLE]`).
  2. Read the `Hint:` section — it contains the concrete fix action.
  3. Propose the fix to the user with confirmation before executing. Example:
     "Qdrant is not running. Hint suggests: `docker compose up -d qdrant`.
     Proceed?"
  4. After user confirms, execute the fix.
  5. Retry `get_index_status`.
  6. Reconnect MCP only if a config change was made (e.g. switched embedding
     provider).

**2. Memorize label thresholds:**

- `get_index_metrics` → remember label values. Example: commitCount
  `{ low: 1, typical: 3, high: 8, extreme: 20 }` means 8 commits = "high" in
  THIS codebase.

**3. Load resource references:**

- Read `tea-rags://schema/overview` → navigation hub for presets, signals,
  filters, search-guide.
- Read `tea-rags://schema/search-guide` → concrete query examples for each tool.
- Keep in context. Consult linked resources (`presets`, `signals`, `filters`)
  when making rerank/filter decisions.

**4. Detect available tools and assign profile:**

- Check tool prefixes in available tools list:
  - `LSP` or `mcp__*-lsp__*` or `mcp__ide__*` → LSP available
  - `mcp__tree-sitter__*` → tree-sitter available
  - `mcp__ripgrep__*` → ripgrep available
- Assign profile:
  - LSP available → **Full** (combo: tea-rags discovery + LSP navigation)
  - LSP not available → **No-LSP** (tea-rags discovery + fallbacks)
- Remember: `Profile: Full | LSP ✓ | tree-sitter ✗ | ripgrep ✓`

## Decision Tree

Single point of tool selection. Follow top-to-bottom, take the first matching
branch.

```
Has query?
├─ No → rank_chunks
│       + pathPattern if directory known
│       + rerank preset for analytics
│
└─ Yes
   ├─ Have code/chunk as example? → find_similar (code or chunk ID)
   │
   ├─ Have a symbol name? → hybrid_search
   │   (symbol + semantic context around it)
   │   Example: "PaymentService validate card expiration"
   │   BM25 catches PaymentService, semantic catches validation logic
   │   Fallback: if hybrid_search unavailable (enableHybrid=false) → semantic_search
   │
   ├─ Pure exploration, human-readable output? → search_code
   │   Quick lookup, no structured metadata needed
   │   Used by /tea-rags:explore skill
   │
   └─ Describing behavior/intent → semantic_search
       Example: "retry logic after failure" → finds retryWithBackoff
       even though the word "retry" may not appear in method name

   All except find_similar and search_code: + rerank preset if analytics needed
   Choosing rerank: preset or custom — consult tea-rags://schema/presets
   If no preset fits → custom weights via tea-rags://schema/signals
```

## Rerank Decision

When the user asks an analytical question:

```
Existing preset fits?
├─ Yes → use it (consult tea-rags://schema/presets for full list)
│
└─ No → build custom rerank (consult tea-rags://schema/signals for weight keys)

    Example: "most dangerous code in payments"
    - hotspots: churn + recency (no bugFix)
    - bugHunt: burstActivity + volatility + bugFix (closer)
    - But "dangerous" = bugs + instability + single owner →
      custom: { bugFix: 0.4, volatility: 0.3, knowledgeSilo: 0.3 }
```

## Pagination and Reformulation

Two independent mechanisms with separate counters.

**Pagination** — results are relevant, need more:

```
offset=0 → offset=15 → offset=30 → ... (no iteration limit)
```

Same query, same filters, increasing offset.

**Reformulation** — results are NOT relevant:

```
Max 3 attempts: different query / different filters / different rerank
After 3: report "could not find, here's the best match"
```

Can paginate indefinitely. Can reformulate max 3 times.

## Stop Conditions

When to stop paginating. Score is a ranking signal, not a cutoff threshold —
absolute score values are meaningless across different presets, collections, and
queries. Stop conditions are based on **information gain**, not score magnitude.

**Score-driven (rank_chunks, rerank-driven analytics):**

- **Gradient drop:** if gap between last result of current page and first result
  of next page > 2× the average gap between adjacent results on current page →
  stop (signal cliff, not gradual decline)
- **Diminishing returns:** page contains < 3 new unique files not seen in
  previous pages → stop
- **Hard cap:** 3 pages max (offset 0, 15, 30 = 45 results) as safety net

**Query-driven (semantic_search, hybrid_search):**

- **Relevance judgment:** evaluate result content against query intent — stop
  when results are clearly unrelated to what was asked (agent judgment, not
  score-based)
- Reformulation rules apply (max 3 attempts per above)

**Multi-preset scans (multiple calls with different presets):**

- Per-preset: apply score-driven rules independently
- Cross-preset: stop when merge produces < 2 new candidates appearing in 2+
  presets per additional page

## Combo Strategy Rules

**Rule 1: tea-rags for discovery, LSP for navigation.** One semantic_search
returns subsystem slice. LSP navigates within it. Never use multiple
semantic_search calls when LSP can navigate from the first result.

**Rule 2: semantic_search for breadth, not findReferences.** findReferences
returns direct callers (backward in call chain). semantic_search returns
everything conceptually related (any direction). Use findReferences only for
exhaustive refactoring impact, not for discovery.

**Rule 3: metaOnly=false returns code — Read often unnecessary.** Search results
contain content with startLine/endLine. For symbols visible in results — use
startLine/endLine for partial Read. For symbols called inside a chunk but
defined elsewhere — LSP goToDefinition gives exact file:line, then partial Read
from that position.

**Rule 4: Cross-layer via semantic_search + language filter.** Not grep chains
(controller → route → grep frontend). One call:
`semantic_search("batch create jobs", language="typescript")`.

**Rule 5: Resources on demand.** `tea-rags://schema/overview` and
`tea-rags://schema/search-guide` loaded at session start. Other resources
(`presets`, `signals`, `filters`) — read when making rerank/filter decisions.

## Use Cases

Organized by agent task. Each references a decision tree branch.

**Discovery (don't know the naming)**

| Task                              | Tool (via tree)            | Example                                                |
| --------------------------------- | -------------------------- | ------------------------------------------------------ |
| Find subsystem by description     | semantic_search            | "retry logic after failure" → retryWithBackoff         |
| Find frontend for backend concept | semantic_search + language | "batch create jobs", language="typescript"             |
| Find similar pattern              | find_similar               | Found retry in cohere → find_similar → retry in ollama |

**Analytics (rerank-driven)**

| Task                         | Tool + rerank                         | Example                                                |
| ---------------------------- | ------------------------------------- | ------------------------------------------------------ |
| Where bugs hide              | semantic_search/rank_chunks + bugHunt | "error handling in payments domain"                    |
| What to refactor first       | rank_chunks + refactoring             | pathPattern="\*\*/payments/\*\*"                       |
| Bus factor risk              | rank_chunks + ownership               | Single dominant author areas                           |
| Hotspots                     | semantic_search + hotspots            | "payment processing", pathPattern="\*\*/payments/\*\*" |
| Most unstable code in domain | semantic_search + hotspots or custom  | pathPattern for domain scope                           |
| Recent changes for review    | semantic_search + codeReview          | maxAgeDays=7                                           |

**Exact symbol search**

| Task                         | Tool (via tree)          | Example                                        |
| ---------------------------- | ------------------------ | ---------------------------------------------- |
| Class/method definition      | hybrid_search            | "def automations_disabled_reasons"             |
| TODO/FIXME markers + context | hybrid_search + techDebt | BM25 catches markers, semantic catches context |
| Symbol + semantic context    | hybrid_search            | "PaymentService validate card expiration"      |

**Code context for generation**

| Task                 | Tool + rerank                    | Example                        |
| -------------------- | -------------------------------- | ------------------------------ |
| Find stable template | semantic_search + stable         | Low churn = proven pattern     |
| Find fresh example   | semantic_search + recent         | Latest changes = current style |
| Assess change impact | semantic_search + impactAnalysis | Files with most imports        |

## Fallback Chains by Profile

**Full profile (LSP available):**

| Task                                | Primary                                                                                      | Fallback                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------- |
| File structure                      | LSP documentSymbol                                                                           | tree-sitter → Read                 |
| Navigate to definition              | partial Read (startLine/endLine from chunks) → LSP goToDefinition (if symbol not in results) | hybrid_search (symbol) → ripgrep   |
| Call chain (who calls / what calls) | LSP incomingCalls / outgoingCalls                                                            | semantic_search (subsystem slice)  |
| All usages                          | LSP findReferences                                                                           | ripgrep (class/method name)        |
| Type / signature                    | LSP hover                                                                                    | Read (partial)                     |
| Find symbol by name                 | LSP workspaceSymbol                                                                          | hybrid_search                      |
| Find implementations                | LSP goToImplementation                                                                       | hybrid_search ("class SymbolName") |
| Cross-layer                         | semantic_search + language filter                                                            | same                               |
| Exact text                          | ripgrep MCP                                                                                  | built-in Grep                      |

**LSP performance warning:** `incomingCalls`, `outgoingCalls`, and
`findReferences` can be slow or hang on large codebases (especially Ruby).
Prefer semantic_search for call chain discovery — it returns the whole subsystem
slice in one call. Use LSP call hierarchy only for small, focused scopes (single
file or known module).

**No-LSP profile:**

| Task             | Primary                                                                          | Fallback 1        | Fallback 2 |
| ---------------- | -------------------------------------------------------------------------------- | ----------------- | ---------- |
| File structure   | tree-sitter analyze_code_structure                                               | Read (whole file) | —          |
| Navigate to call | partial Read (startLine/endLine from chunks) → hybrid_search (if not in results) | ripgrep           | Read       |
| All usages       | ripgrep (class/method name)                                                      | built-in Grep     | —          |
| Cross-layer      | semantic_search + language filter                                                | same              | —          |
| Exact text       | ripgrep MCP                                                                      | built-in Grep     | —          |

Each fallback activates when the tool to its left is unavailable. If tree-sitter
is absent, "File structure" falls directly to Read. If ripgrep MCP is absent,
"Exact text" falls directly to built-in Grep.

## When to Use External Tools Directly

- **Call-sites, imports, exact patterns** → ripgrep MCP (not tea-rags)
- **File structure (methods, classes)** → LSP documentSymbol or tree-sitter
- **Read specific lines** → Read with offset + limit (not whole file)

These complement tea-rags. See Fallback Chains for profile-specific guidance.

## Prohibited Patterns

- **Built-in Grep for code discovery** — use tea-rags or ripgrep MCP
- **Multiple semantic_search for same area** — one call + LSP navigation
  (Rule 1)
- **findReferences for discovery** — use semantic_search for breadth (Rule 2),
  reserve findReferences for exhaustive refactoring impact only
- **Read whole file when search returned code** — content is in search results
  (Rule 3)
- **Grep chains for cross-layer** — use semantic_search + language filter
  (Rule 4)
- **git log/diff for code history** — overlay already has git signals
- **10+ ripgrep calls instead of reading a file** — just read it
- **search_code in generation/bug-hunt/research context** — use semantic_search
  (needs overlay labels + structured metadata). search_code is for pure
  exploration only (/tea-rags:explore)

## Trust the Index

Search results are real code. Don't ripgrep to "verify" every result. Use
ripgrep when you **need** it (call-sites, imports), not as ritual.

If results seem stale → check `driftWarning` in response → `reindex_changes`.

## hybrid_search Fallback

If `hybrid_search` fails (needs `enableHybrid=true`), fall back to
`semantic_search`.
