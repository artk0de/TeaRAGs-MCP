# Search Cascade

## Principles

**Post-search validation after every search call.** Run
@post-search-validation.md checks (no-match detection + disambiguation). Do NOT
skip. This applies to ALL skills and direct tool calls.

**Semantic First, Exact Second.** Any code search starts with tea-rags
(semantic_search, hybrid_search, find_symbol, find_similar). ripgrep only for
exact string patterns (TODO, import paths, regex) or as fallback when tea-rags
is unavailable. Built-in Grep/Glob — never for code discovery.

**Chunk is the source of truth.** Search results contain code, metadata, and git
signals. Do not re-read files to "verify" or "understand" results. Read only
when: modifying code, or need context beyond chunk boundaries. find_symbol
returns the full method/class definition — no Read needed.

**MANDATORY:** ALWAYS prefer tea-rags and ripgrep MCP over built-in Search/Grep.

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
  3. Propose the fix to the user with confirmation before executing.
  4. After user confirms, execute the fix.
  5. Retry `get_index_status`.

**2. Memorize label thresholds + detect polyglot:**

- `get_index_metrics` → remember label values. Signals are scoped by
  `source`/`test`:
  `signals["typescript"]["git.file.commitCount"]["source"].labelMap` →
  `{ low: 1, typical: 3, high: 8, extreme: 20 }` means 8 commits = "high" for
  source code in THIS codebase.
- Check language distribution in metrics. If 2+ languages each have >10% of
  chunks → **polyglot codebase**. See `references/polyglot-rule.md`.

**3. Load resource references:**

- Read `tea-rags://schema/overview` → navigation hub for presets, signals,
  filters, search-guide.
- Read `tea-rags://schema/search-guide` → concrete query examples for each tool.
- Consult linked resources (`presets`, `signals`, `filters`) when making
  rerank/filter decisions.

## Decision Tree

Single point of tool selection. Follow top-to-bottom, take the first matching
branch. **Prefer skills over direct tool calls** — skills encapsulate the right
tool sequence, rerank presets, and output formatting.

```
Already have search results for this area?
├─ Yes → NAVIGATE (do not search again)
│   ├─ Need definition or full method code
│   │     → find_symbol (returns merged definition, no Read needed)
│   ├─ Need code beyond chunk boundaries
│   │     → partial Read (offset=startLine, limit=endLine-startLine)
│   ├─ Need all usages of known symbol
│   │     → hybrid_search (BM25 catches exact name + semantic context)
│   └─ Need file structure (methods, classes)
│         → tree-sitter → Read
│
└─ No (need to search)

Intent matches a skill? (check FIRST — skills handle tool selection internally)
├─ User asks to explore/understand/investigate/research code
│     → /tea-rags:explore
│     Covers: "how does X work", "show architecture of Y",
│     "find all implementations of X", "antipatterns in Y",
│     "best example of X", "what to refactor in Z",
│     "find similar patterns to this code",
│     "before I modify/change/refactor X", "research before coding",
│     "what should I know before touching X"
│     Explore classifies intent internally: pattern-search, refactoring-scan,
│     direct exploration, or pre-generation context (risk assessment +
│     generation-ready output). search_code is ONLY used through this skill,
│     NEVER directly by agents.
│
├─ Bug hunting ("why does X fail", "find the bug in Y")
│     → /tea-rags:bug-hunt (uses bugHunt rerank, targets historically buggy code)
│
├─ Code generation/modification (writing new code, changing existing)
│     → /tea-rags:data-driven-generation (selects strategy from git signals)
│
├─ Risk/health assessment ("assess risks", "find problems", "code health")
│     → /tea-rags:risk-assessment (multi-dimensional scan: bugs, hotspots, debt)
│
└─ No skill matches → direct tool selection below

Has query?
├─ No → rank_chunks
│       + pathPattern if directory known
│       + rerank preset for analytics
│       + minCommitCount from labelMap to filter one-off scripts
│
└─ Yes
   ├─ Exhaustive usage intent? ("where is X used", "all callers",
   │   "who imports X", "can I delete X", "all references")
   │   → hybrid_search (BM25 catches exact symbol name with full recall,
   │     dense vectors add semantic context for related usages).
   │   Paginate with offset until all usages found (see references/pagination.md).
   │
   ├─ Have code/chunk as example? → find_similar (code or chunk ID)
   │
   ├─ Need definition of a known symbol? → find_symbol
   │   "Show me Reranker.rerank", "what does mergeChunks do"
   │   Direct Qdrant scroll — no embedding, instant. Returns merged definition.
   │   Use metaOnly=true for existence checks ("does X exist?", "has tests?").
   │   For test checks: find_symbol + pathPattern targeting test dirs.
   │   Fallback: hybrid_search if find_symbol returns 0 results.
   │
   ├─ Have a symbol name + semantic context? → hybrid_search
   │   Example: "PaymentService validate card expiration"
   │   BM25 catches exact symbol name, dense vectors catch semantic context.
   │
   ├─ Have a bare symbol name (no context)? → hybrid_search
   │   BM25 correctly matches exact symbol names (score up to 1.0).
   │
   └─ Describing behavior/intent → semantic_search
       Example: "retry logic after failure" → finds retryWithBackoff
       even though the word "retry" may not appear in method name.

   All except find_similar: + rerank preset if analytics needed.
   Choosing rerank: consult tea-rags://schema/presets.
   If no preset fits → custom weights via tea-rags://schema/signals.

   Code-only filtering: add language filter or pathPattern to exclude
   non-code files. Documentation results dilute code search.
```

## Rerank Decision

When the user asks an analytical question:

```
Existing preset fits?
├─ Yes → use it (consult tea-rags://schema/presets for full list)
│
└─ No → build custom rerank (consult tea-rags://schema/signals for weight keys)

    Example: "most dangerous code in payments"
    custom: { bugFix: 0.4, volatility: 0.3, knowledgeSilo: 0.3 }
```

## Filter Level: file vs chunk

- **`level: "chunk"`** (default) — filters against `git.chunk.*` fields
- **`level: "file"`** — filters against `git.file.*` fields

**Warning:** At chunk level, `ageDays=0` means "no git history for this chunk"
(not "just created"). **Use `level: "file"` for time-based filters.**

## Subagent Search Injection (MANDATORY)

Subagents (Agent tool) do NOT inherit rules or CLAUDE.md. They default to
built-in Grep/Glob, bypassing tea-rags entirely.

**When spawning any subagent that will search code**, prepend this block to the
prompt:

```
## Search Tools (MANDATORY)
For code search in this project, use MCP tools instead of built-in Grep/Glob:

**Tool selection (follow top-to-bottom):**
- Exhaustive usage ("all callers", "where used", "who imports") →
  `mcp__tea-rags__hybrid_search` (BM25 = full recall, dense = context).
  Paginate with offset if needed — don't inflate limit.
- Known symbol definition → `mcp__tea-rags__find_symbol` (instant, no embedding)
- Symbol + semantic context → `mcp__tea-rags__hybrid_search`
- Behavior/intent question → `mcp__tea-rags__semantic_search`
- Exact text patterns (TODO, FIXME, import paths, regex) → `mcp__ripgrep__search`

**Rules:**
- Do NOT use built-in Grep or Glob for code discovery
- Search results contain code — trust the chunk, don't re-read files
- find_symbol returns full method/class — no Read needed
- All tea-rags calls require: path="<absolute-project-path>"
```

Replace `<absolute-project-path>` with the actual working directory path.

**When NOT needed:** subagents that only read/write files, run tests, do git
operations, or have no code search in their task.

## Prohibited Patterns

- **Built-in Grep for code discovery** — use tea-rags or ripgrep MCP
- **Read file to verify search results** — chunk is the source of truth
- **Read file after find_symbol** — find_symbol returns full definition
- **Multiple semantic_search for same area** — one call, navigate from results
- **Unfiltered semantic_search for cross-layer** — dominant language takes 100%
  of slots. Always use language filter (see `references/polyglot-rule.md`)
- **semantic_search for "find all usages"** — use hybrid_search instead. BM25
  component provides full recall for exact symbol names
- **ripgrep for symbol existence checks** — use find_symbol with metaOnly=true
- **hybrid_search for TODO/FIXME/HACK markers** — use ripgrep MCP
- **git log/diff for code history** — overlay already has git signals
- **10+ ripgrep calls instead of reading a file** — just read it
- **search_code directly** — ONLY used through /tea-rags:explore skill for
  user-facing exploration. Agents and subagents NEVER call search_code directly.
  For any code generation, bug hunting, research, or agent-driven task → use
  semantic_search or hybrid_search instead

## Fallback Chains

| Task                 | Primary                           | Fallback                             |
| -------------------- | --------------------------------- | ------------------------------------ |
| Symbol definition    | find_symbol                       | hybrid_search → ripgrep              |
| File structure       | tree-sitter                       | Read (whole file)                    |
| All usages           | hybrid_search + offset pagination | ripgrep (only if hybrid unavailable) |
| Behavioral discovery | semantic_search                   | hybrid_search                        |
| Cross-layer          | semantic_search × per language    | same                                 |
| Exact text           | ripgrep MCP                       | built-in Grep                        |

## pathPattern Rules

Never use braces with full file paths containing slashes — breaks picomatch.
Always extract directory-level prefixes for pathPattern globs.

- GOOD: `**/enrichment/**` (directory prefix)
- GOOD: `{file1.rb,file2.rb}` (flat file names, no slashes)
- BAD: `{app/services/foo.rb,app/models/bar.rb}` (slashes inside braces)

Skills have their own pathPattern extraction logic (how to derive pathPattern
from user arguments or search results). This section covers the universal
formatting constraint.

## Reference Files

For detailed guidance on specific topics, read these when needed:

- `references/use-cases.md` — task-organized use cases with tool+parameter
  examples
- `references/polyglot-rule.md` — mandatory per-language splitting for polyglot
  codebases
- `references/pagination.md` — pagination, reformulation, stop conditions,
  no-match detection, disambiguation
