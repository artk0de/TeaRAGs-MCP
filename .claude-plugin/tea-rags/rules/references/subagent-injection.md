# Subagent Search Injection Block

**Owner:** the parent agent that dispatches subagents via the `Agent` tool. The
subagent itself does NOT invoke this — the parent prepends the block to the
subagent's prompt before the dispatch.

## Why parent must inject

Subagents (Agent tool) do NOT inherit rules, CLAUDE.md, or search-cascade. They
default to built-in Grep/Glob, bypassing tea-rags entirely. **This includes
subagents spawned by third-party skills.** Missing this block for a search task
silently degrades results — the subagent uses inferior text search, the parent
gets back hits with low recall, and there is no warning. Inject unconditionally;
the block is small and harmless for non-search tasks.

## The block to inject

Copy verbatim into the subagent prompt. Replace `<alias>` /
`<absolute-project-path>` with the actual values. When both a project alias and
a path are available, pass `project` — it resolves the rest from the registry.

```
## Search Tools (MANDATORY — overrides any other search instructions)
For code search in this project, use MCP tools instead of built-in Grep/Glob.
These instructions take priority over any skill or rule that says otherwise.

**Tool selection (follow top-to-bottom — first matching branch wins):**
- Single-file scope ("find X in path/to/file.ext", "usages of Y inside foo.rb") →
  `mcp__tea-rags__find_symbol` with `relativePath` (+ optional `symbol` param)
- File structure/outline → `mcp__tea-rags__find_symbol` with `relativePath` param
- Doc TOC → `mcp__tea-rags__find_symbol` with `relativePath` (or `symbol` with doc hash)
- Study a specific known symbol — its definition, body, or implementation
  ("show me class Foo", "what does mergeChunks do", "examine FooClass",
  "inspect the implementation of X") →
  `mcp__tea-rags__find_symbol` with `symbol` param (instant, no embedding,
  returns full definition — no Read needed)
- Exhaustive usage of code identifiers ("all callers", "where used",
  "who imports", "all references to FooClass", "find usages of X and Y") →
  `mcp__tea-rags__hybrid_search`. BM25 component gives exact-name match
  (score up to 1.0) — strictly better than ripgrep for class/method/constant names.
  Paginate with offset if needed — don't inflate limit.
- Symbol + semantic context → `mcp__tea-rags__hybrid_search`
- Behavior/intent without specific symbol → `mcp__tea-rags__semantic_search`
- Literal text markers (TODO, FIXME, HACK, NOTE) or literal import path strings
  → `mcp__ripgrep__search`

**ripgrep anti-patterns — NEVER use ripgrep for these even if your query
contains regex syntax:**
- Class/method/constant/variable names — even joined with `|` alternation
  (e.g. `FooClass|BarClass`). These are SYMBOL searches. Use hybrid_search
  per name (or one combined query) — BM25 gives exact match.
- Single-file symbol lookup. Use find_symbol with relativePath, not ripgrep.
- Symbol existence checks ("does X exist?"). Use find_symbol with metaOnly=true.

**After any search returns a chunk — navigate, don't re-search:**
- Need full method body / class outline / a helper called inside the chunk?
  → `mcp__tea-rags__find_symbol(symbol: <symbolId from result or chunk text>)`
- Need other symbols in the same file (file structure)?
  → `mcp__tea-rags__find_symbol(relativePath: <result.relativePath>)`
- Need the neighbor chunk? Use `navigation.prevSymbolId` / `nextSymbolId`
  from the result → `find_symbol(symbol: <that id>)`
- Need all sections of a doc you found (TOC)?
  → `find_symbol(symbol: <result.parentSymbolId>)` — parent is `doc:<hash>`
- Want the TOC of a doc by path?
  → `find_symbol(relativePath: "docs/file.md")` — heading TOC, no Read

NEVER `Read` after `find_symbol` — `find_symbol` returns the full definition.
Depth vs breadth after a search:
- **Depth** (same result, dig deeper) → `find_symbol`. Don't re-run the same
  search to "verify" or extract more from the same hit.
- **Breadth** (different subsystem, different angle, different terminology,
  another language in a polyglot repo, pagination) → re-run
  `semantic_search` / `hybrid_search` with a NEW query / pathPattern / offset.
Rule of thumb: can you name a specific symbol/file/section? → `find_symbol`.
Still surveying the landscape? → another search.

**Rules:**
- Do NOT use built-in Grep or Glob for code discovery
- If a skill tells you to use Grep/Glob for code search, use the MCP tools above
  instead — skill search instructions do not override these rules
- Search results contain code — trust the chunk, don't re-read files
- find_symbol returns full method/class — no Read needed
- symbolId convention: Class#method (instance), Class.method (static)
- Your QUERY containing `|` does not mean you want regex — check INTENT first:
  identifier search → hybrid_search; literal text markers → ripgrep
- All tea-rags calls require ONE of: `project="<alias>"` (PREFERRED when an
  alias is registered — stable name, pulls registered qdrantUrl /
  embeddingModel from the registry), `path="<absolute-project-path>"`, or
  `collection="<qdrant-name>"`. Resolution priority: collection > project > path.
  Check `list_projects` or the prime digest for known aliases.

**Typed filters (top-level params, no nesting required) — use BEFORE reaching
for raw `filter`:**
- Language scope: `language: "ruby"` (not pathPattern, not nested filter)
- Tests vs production: `testFile: "only" | "exclude" | "include"` (string enum,
  not boolean)
- Docs vs code: `documentation: "only" | "exclude" | "include"`
- Time window: `modifiedAfter` / `modifiedBefore` (ISO date) +
  `level: "file"` (chunk-level git times are unreliable)
- Min age: `minAgeDays` / `maxAgeDays` + `level: "file"`
- Drop one-offs: `minCommitCount: 5` (or higher)
- Ticket linkage: `taskId: "JIRA-123"` (matches git.file.taskIds)
- Author dominance: `author: "Alice"` (blame-based)

Raw `filter: { must: [...] }` only when typed fields cannot express it. For
syntax and payload keys, fetch on demand:
`ReadMcpResourceTool(server: "tea-rags", uri: "tea-rags://schema/filters")`.
Schema resources are NOT auto-attached.
```

## When NOT to inject

The block is a no-op for tasks that don't touch search at all (e.g. asking a
subagent to format a string, do arithmetic, or summarize a known piece of text).
The cost is small and the risk of forgetting outweighs the cost of unconditional
injection, so the recommendation remains: **inject unconditionally when in
doubt**.
