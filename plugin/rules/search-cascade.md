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

**2. Memorize label thresholds + detect polyglot:**

- `get_index_metrics` → remember label values. Example: commitCount
  `{ low: 1, typical: 3, high: 8, extreme: 20 }` means 8 commits = "high" in
  THIS codebase.
- Check language distribution in metrics. If 2+ languages each have >10% of
  chunks → **polyglot codebase**. Remember:
  `Polyglot: yes | ruby: 66%, typescript: 34%` This triggers mandatory
  per-language splitting (see Polyglot Rule below).

**3. Load resource references:**

- Read `tea-rags://schema/overview` → navigation hub for presets, signals,
  filters, search-guide.
- Read `tea-rags://schema/search-guide` → concrete query examples for each tool.
- Keep in context. Consult linked resources (`presets`, `signals`, `filters`)
  when making rerank/filter decisions.

**4. Detect available tools and assign profile:**

- Check **both regular AND deferred tools** (deferred tools appear in
  `<system-reminder>` as "The following deferred tools are now available via
  ToolSearch"). Match by name or prefix:
  - `LSP` (deferred tool name) or `mcp__*-lsp__*` → LSP available
  - `mcp__ide__*` → IDE integration (diagnostics only), **NOT LSP**
  - `mcp__tree-sitter__*` → tree-sitter available
  - `mcp__ripgrep__*` → ripgrep available
- Assign profile:
  - LSP navigation available → **Full** (combo: tea-rags discovery + LSP
    navigation)
  - LSP not available → **No-LSP** (tea-rags discovery + fallbacks)
- Remember: `Profile: Full | LSP ✓ | tree-sitter ✗ | ripgrep ✓`

## Decision Tree

Single point of tool selection. Follow top-to-bottom, take the first matching
branch.

```
Already have search results for this area?
├─ Yes → NAVIGATE (do not search again)
│   ├─ Need definition or call chain
│   │     → LSP goToDefinition (preferred)
│   │     → partial Read if LSP unavailable
│   ├─ Need code beyond chunk boundaries
│   │     → partial Read (offset=startLine, limit=endLine-startLine)
│   ├─ Need all usages of known symbol
│   │     → ripgrep MCP (scoped to suspect dirs)
│   └─ Need file structure (methods, classes)
│         → LSP documentSymbol → tree-sitter → Read
│
└─ No (need to search)

Has query?
├─ No → rank_chunks
│       + pathPattern if directory known
│       + rerank preset for analytics
│       + minCommitCount from labelMap (commitCount.low threshold)
│         to filter one-off scripts with unreliable signal ratios
│
└─ Yes
   ├─ Exhaustive usage intent? ("where is X used", "all callers",
   │   "who imports X", "can I delete X", "all references")
   │   → TWO-STEP:
   │     1. hybrid_search (verify naming in domain + get initial context)
   │     2. ripgrep MCP (exhaustive search by verified symbol names)
   │   Combine: ripgrep list for completeness + semantic context from step 1.
   │   semantic_search alone gives ~13% recall — NOT sufficient for usage queries.
   │
   ├─ Have code/chunk as example? → find_similar (code or chunk ID)
   │
   ├─ Need definition of a known symbol? → find_symbol
   │   "Show me Reranker.rerank", "what does mergeChunks do"
   │   Direct Qdrant scroll — no embedding, instant. Returns merged definition.
   │   Use metaOnly=true for existence checks ("does X exist?").
   │   Fallback: hybrid_search if find_symbol returns 0 results.
   │
   ├─ Have a symbol name + semantic context? → hybrid_search
   │   Example: "PaymentService validate card expiration"
   │   BM25 catches exact symbol name, dense vectors catch semantic context.
   │   Fallback: if hybrid_search unavailable (enableHybrid=false) → semantic_search
   │
   ├─ Have a bare symbol name (no context)? → hybrid_search
   │   BM25 now correctly matches exact symbol names (score up to 1.0).
   │   Fallback: semantic_search if hybrid unavailable.
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

   Code-only filtering: when searching for code (not docs/config), add
   language filter (e.g., language="typescript") or pathPattern to exclude
   non-code files (markdown, yaml, config). Documentation results dilute
   code search — filter proactively, don't clean up after.
```

## Polyglot Rule (MANDATORY)

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

**Enforcement checkpoints:**

- After any semantic_search/hybrid_search: verify result languages match query
  intent. If results are 100% one language on a polyglot codebase → re-search
  with explicit language filters.
- Pattern-search EXPAND: if seed is from language A and codebase has language B,
  also run find_similar with `language` filter for B.
- Research/bug-hunt: validate risk map / suspect list covers all relevant
  layers.

**Exception:** rank_chunks with pathPattern already scopes by directory —
language filter not needed if path already constrains to one language layer.

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

## Filter Level: file vs chunk

Filters apply to different payload levels depending on the `level` parameter:

- **`level: "chunk"`** (default) — filters against `git.chunk.*` fields
- **`level: "file"`** — filters against `git.file.*` fields

This matters because chunk-level and file-level signals can diverge:

| Signal           | file-level                      | chunk-level                      | Note       |
| ---------------- | ------------------------------- | -------------------------------- | ---------- |
| `ageDays`        | Reliable (file has git history) | Often 0 (no chunk-level commits) | ⚠          |
| `commitCount`    | Total file commits              | Commits touching this chunk      | Can differ |
| `dominantAuthor` | File-level author               | Chunk-level author               | May differ |

**⚠ maxAgeDays/minAgeDays warning:** At chunk level, `ageDays=0` means "no git
history for this chunk" (not "just created"). `maxAgeDays=7` at chunk level
matches these zero-value chunks as false positives. **Use `level: "file"` for
time-based filters until this is fixed** (tracked: tea-rags-mcp-7fx3).

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

**Disambiguation (MANDATORY after every search)** — results are relevant but
mixed:

After EVERY search, scan result paths for domain clustering. If top-10 results
split into 2+ unrelated directory groups (e.g., `services/qbo/` vs
`services/crm/`) with no single group holding >70% of results — you MUST NOT
silently pick one. Present clusters to the user: "Found results in two areas:
[area A] and [area B]. Which context?" Then re-search with `pathPattern` for the
chosen area. Do NOT reason about mixed results as if they belong to one domain.

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

## No-Match Detection

Absolute similarity scores are meaningless — a nonsensical query can score 0.55
while legitimate reranked results score 0.36. Detect "no relevant results" using
relative patterns within the result set:

**Check after every search call:**

1. **Score spread:** `(max_score - min_score) / max_score`. If < 0.06 across
   top-10 → flat distribution, query has no discriminative power → likely noise.
2. **Lexical overlap:** Do any query terms appear in top-5 file paths, symbol
   names, or chunk content? Zero overlap → strong no-match signal.
3. **Path clustering:** Do top-10 results cluster in ≤3 directories? If
   scattered across >7 unrelated directories → noise, not a coherent area.

**Decision:**

- Any 2 of 3 triggered → warn: "results may not be relevant." Validate key
  findings with ripgrep before reasoning about them.
- All 3 triggered → treat as "no match." Report to user, do not reason about
  irrelevant results.
- 0 or 1 triggered → proceed normally.

## Combo Strategy Rules

**Rule 1: tea-rags for discovery, LSP for navigation.** One semantic_search
returns subsystem slice. LSP navigates within it. Never use multiple
semantic_search calls when LSP can navigate from the first result.

**Rule 2: semantic_search for breadth, not findReferences.** findReferences
returns direct callers (backward in call chain). semantic_search returns
everything conceptually related (any direction). Use findReferences only for
exhaustive refactoring impact, not for discovery.

**Rule 3: metaOnly and content access.**

- `metaOnly=false` → results contain code content + startLine/endLine. Read
  often unnecessary. For symbols called inside a chunk but defined elsewhere —
  LSP goToDefinition gives exact file:line, then partial Read.
- `metaOnly=true` → results contain only metadata (path, signals, overlay). To
  read code: `Read(relativePath, offset=startLine, limit=endLine-startLine)`.
- **When to use which:** prefer `metaOnly=false` when content is needed for
  classification or comparison (saves tool calls). Use `metaOnly=true` for pure
  analytics (ownership reports, risk maps) where only signals matter.

**Rule 4: Polyglot splitting is mandatory.** See Polyglot Rule above. Never
issue an unfiltered search on a polyglot codebase — dominant language takes 100%
of slots. Stratified retrieval in MCP is planned (tea-rags-mcp-hcmo).

**Rule 5: Resources on demand.** `tea-rags://schema/overview` and
`tea-rags://schema/search-guide` loaded at session start. Other resources
(`presets`, `signals`, `filters`) — read when making rerank/filter decisions.

## Use Cases

Organized by agent task. Each references a decision tree branch.

**Discovery (don't know the naming)**

| Task                              | Tool (via tree)                | Example                                                |
| --------------------------------- | ------------------------------ | ------------------------------------------------------ |
| Find subsystem by description     | semantic_search                | "retry logic after failure" → retryWithBackoff         |
| Find frontend for backend concept | semantic_search × per language | "batch create jobs" → one call per language layer      |
| Find similar pattern              | find_similar                   | Found retry in cohere → find_similar → retry in ollama |

**Analytics (rerank-driven)**

| Task                         | Tool + rerank                         | Example                                                |
| ---------------------------- | ------------------------------------- | ------------------------------------------------------ |
| Where bugs hide              | semantic_search/rank_chunks + bugHunt | "error handling in payments domain"                    |
| What to refactor first       | rank_chunks + refactoring             | pathPattern="\*\*/payments/\*\*"                       |
| Bus factor risk              | rank_chunks + ownership               | Single dominant author areas                           |
| Hotspots                     | semantic_search + hotspots            | "payment processing", pathPattern="\*\*/payments/\*\*" |
| Most unstable code in domain | semantic_search + hotspots or custom  | pathPattern for domain scope                           |
| Recent changes for review    | semantic_search + codeReview          | maxAgeDays=7                                           |

**Exhaustive usage (need ALL references)**

| Task                     | Tool (via tree)             | Example                                              |
| ------------------------ | --------------------------- | ---------------------------------------------------- |
| All callers / all usages | hybrid_search → ripgrep MCP | hybrid verifies naming, ripgrep finds all call-sites |
| Safe to delete / rename  | hybrid_search → ripgrep MCP | hybrid for context, ripgrep for exhaustive check     |
| Impact of change         | hybrid_search → ripgrep MCP | hybrid finds domain, ripgrep finds all dependents    |

**Exact symbol search**

| Task                      | Tool (via tree) | Example                                         |
| ------------------------- | --------------- | ----------------------------------------------- |
| Symbol definition         | find_symbol     | "Reranker.rerank" → instant, no embedding       |
| Symbol exists?            | find_symbol     | metaOnly=true, 0 results = doesn't exist        |
| Symbol + semantic context | hybrid_search   | "PaymentService validate card expiration"       |
| Bare symbol name          | find_symbol     | "batch_create" → direct lookup by symbolId      |
| TODO/FIXME markers        | ripgrep MCP     | Exact string match, not hybrid (see Prohibited) |

**Code context for generation**

| Task                 | Tool + rerank                    | Example                                  |
| -------------------- | -------------------------------- | ---------------------------------------- |
| Find stable template | semantic_search + stable         | Low churn = proven pattern               |
| Find fresh example   | semantic_search + recent         | Latest changes = current style           |
| Assess change impact | semantic_search + custom weights | imports: 0.5, churn: 0.3, ownership: 0.2 |

## Fallback Chains by Profile

**Full profile (LSP available):**

| Task                                | Primary                                                                                 | Fallback                            |
| ----------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------- |
| File structure                      | LSP documentSymbol                                                                      | tree-sitter → Read                  |
| Navigate to definition              | find_symbol (instant, returns merged definition) → LSP goToDefinition (if not in index) | hybrid_search (symbol) → ripgrep    |
| Call chain (who calls / what calls) | LSP incomingCalls / outgoingCalls                                                       | semantic_search (subsystem slice)   |
| All usages                          | LSP findReferences                                                                      | ripgrep (class/method name)         |
| Type / signature                    | LSP hover                                                                               | Read (partial)                      |
| Find symbol by name                 | find_symbol (no LSP needed)                                                             | LSP workspaceSymbol → hybrid_search |
| Find implementations                | LSP goToImplementation                                                                  | hybrid_search ("class SymbolName")  |
| Cross-layer                         | semantic_search × per language (one call per layer)                                     | same                                |
| Exact text                          | ripgrep MCP                                                                             | built-in Grep                       |

**LSP performance warning:** `incomingCalls`, `outgoingCalls`, and
`findReferences` can be slow or hang on large codebases (especially Ruby).
Prefer semantic_search for call chain discovery — it returns the whole subsystem
slice in one call. Use LSP call hierarchy only for small, focused scopes (single
file or known module).

**No-LSP profile:**

| Task             | Primary                                                            | Fallback 1        | Fallback 2 |
| ---------------- | ------------------------------------------------------------------ | ----------------- | ---------- |
| File structure   | tree-sitter analyze_code_structure                                 | Read (whole file) | —          |
| Navigate to call | find_symbol (instant definition) → hybrid_search (if not in index) | ripgrep           | Read       |
| All usages       | ripgrep (class/method name)                                        | built-in Grep     | —          |
| Cross-layer      | semantic_search + language filter                                  | same              | —          |
| Exact text       | ripgrep MCP                                                        | built-in Grep     | —          |

Each fallback activates when the tool to its left is unavailable. If tree-sitter
is absent, "File structure" falls directly to Read. If ripgrep MCP is absent,
"Exact text" falls directly to built-in Grep.

## When to Use External Tools Directly

- **Call-sites, imports, exact patterns** → ripgrep MCP (not tea-rags)
- **File structure (methods, classes)** → LSP documentSymbol or tree-sitter
- **Read specific lines** → Read with offset + limit (not whole file)
- **Spec/test files** → first try tea-rags with `pathPattern` targeting test
  directories (`**/spec/**`, `**/tests/**`, `**/__tests__/**`, `**/*.test.ts`,
  `**/*_spec.rb`). If index returns 0 chunks (specs excluded via
  `.contextignore`), fall back to ripgrep MCP with same path patterns.

These complement tea-rags. See Fallback Chains for profile-specific guidance.

## Prohibited Patterns

- **Built-in Grep for code discovery** — use tea-rags or ripgrep MCP
- **Multiple semantic_search for same area** — one call + LSP navigation
  (Rule 1)
- **findReferences for discovery** — use semantic_search for breadth (Rule 2),
  reserve findReferences for exhaustive refactoring impact only
- **Read whole file when search returned code** — content is in search results
  (Rule 3)
- **Grep chains for cross-layer** — use semantic_search × per language (Rule 4)
- **Unfiltered semantic_search for cross-layer** — dominant language takes 100%
  of slots. Always use language filter (Rule 4)
- **git log/diff for code history** — overlay already has git signals
- **10+ ripgrep calls instead of reading a file** — just read it
- **search_code in generation/bug-hunt/research context** — use semantic_search
  (needs overlay labels + structured metadata). search_code is for pure
  exploration only (/tea-rags:explore)
- **semantic_search alone for "find all usages"** — ~13% recall. Always follow
  with ripgrep MCP for exhaustive usage queries
- **hybrid_search for TODO/FIXME/HACK markers** — BM25 does not reliably surface
  literal markers. Use ripgrep MCP for exact string matching

## Trust the Index

Search results are real code. Don't ripgrep to "verify" every result. Use
ripgrep when you **need** it (call-sites, imports), not as ritual.

If results seem stale → check `driftWarning` in response → `reindex_changes`.

## hybrid_search Fallback

If `hybrid_search` fails (needs `enableHybrid=true`), fall back to
`semantic_search`.

## Subagent Search Injection (MANDATORY)

Subagents (Agent tool) do NOT inherit rules or CLAUDE.md. They will default to
built-in Grep/Glob for code search, bypassing tea-rags entirely.

**When spawning any subagent that will search code** (especially
`subagent_type: "Explore"`), you MUST prepend this block to the prompt:

```
## Search Tools
For code search in this project, use MCP tools instead of built-in Grep/Glob:
- `mcp__tea-rags__semantic_search` — semantic/conceptual search (query + path)
- `mcp__tea-rags__hybrid_search` — keyword + semantic search (query + path)
- `mcp__tea-rags__find_symbol` — symbol definition lookup (symbol + path, no embedding)
- `mcp__ripgrep__search` — exact text/regex search
- Do NOT use built-in Grep or Glob for code discovery.
- All tea-rags calls require: path="<absolute-project-path>"
```

Replace `<absolute-project-path>` with the actual working directory path.

**When NOT needed:** subagents that only read/write files, run tests, do git
operations, or have no code search in their task.

## Known Limitations

- **hybrid_search requires reindex** — BM25 sparse vectors were rebuilt with
  code-aware tokenization and feature hashing. Existing hybrid collections
  indexed before this change have incompatible sparse vectors. Reindex with
  `forceReindex=true` to get correct BM25 results.
- **TODO/FIXME markers** — BM25 catches markers in markdown docs but not
  reliably in code comments. Use ripgrep MCP for exhaustive marker searches.
- **BM25 floor score ~0.300** — hybrid results below this threshold come from
  BM25 component matching partial tokens. Results are now thematically relevant
  (not random noise), but low-score entries may still be tangential.
