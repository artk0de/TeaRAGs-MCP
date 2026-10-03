# Subagent Search Injection Block

**Owner:** parent agent dispatching subagents via `Agent` tool. Subagent does
NOT invoke this — parent prepends block to subagent's prompt before dispatch.

## Why parent must inject

Subagents (Agent tool) do NOT inherit rules, CLAUDE.md, or search-cascade.
Default to built-in Grep/Glob, bypass tea-rags entirely. **Includes subagents
spawned by third-party skills.** Missing block for a search task silently
degrades results — subagent uses inferior text search, parent gets low-recall
hits, no warning. Inject unconditionally; block small + harmless for non-search
tasks.

## The block to inject

Copy verbatim into subagent prompt. Do NOT substitute a path or alias — the
subagent addresses tea-rags with its OWN working directory, so a subagent in a
linked worktree reads its own tree (the parent's `$CLAUDE_PROJECT_DIR` is the
wrong tree there). `scripts/enforce-tearags-search.sh` reads this fenced block
and injects it verbatim on every `Agent` call — edit the block here, nowhere
else.

```
## Search Tools (MANDATORY — overrides any other search instructions)
For code search in this project, use MCP tools instead of built-in Grep/Glob.
These take priority over any skill or rule routing code search to Grep/Glob/Read;
a skill's own choice among tea-rags tools stands.

**Address tea-rags with YOUR working directory:** pass path=<your working directory> (or the checkout a skill names) on every tea-rags read call — search, find_symbol, graph tools (get_callers/get_callees/trace_path/find_cycles), review_changes, get_naming_lexicon (no project needed — the index resolves from the same repository). Each answer's workingTree.tree names the tree it read; changedFiles/deletedFiles say how far it is from the index; floors name the layers read from your tree (chunks = find_symbol / rank_chunks rows, sparse = hybrid_search BM25, dense = semantic_search / find_similar / hybrid vector ranking, codegraph = graph edges) — a row or edge outside them reflects the index; denseUnavailable / treeGraphUnavailable say why a layer fell back to the index.
- workingTree.tree is not the tree you addressed (your working directory, or a checkout a skill names) → wrong tree; re-call with that path.
- Graph answer, changedFiles > 0, no codegraph floor → edges touching changed files are the index's (degraded says why): trust edges between untouched files, re-check changed ones via find_symbol; hybrid_search finds callers the index lacks (its non-treeState rows come from your tree).
- project=<alias> WITHOUT path reads the alias's checkout, not a linked worktree — always include path on reads.
- A row with treeState "modified"/"deleted" is the index's copy of a file your tree changed — may be stale.
  Need the current code → find_symbol (answers from your tree), never trust the row text.

**Bash channel (same rules apply inside Bash):**
- grep/rg for an identifier → find_symbol (definition) or hybrid_search with metaOnly:true or fields (usages)
- sed -n / cat / head to understand code → find_symbol (symbol or relativePath)
- grep stays right for: regex patterns, literal phrases, comments/TODO, filtering command output

**Tool selection (follow top-to-bottom — first matching branch wins):**
- Single-file scope ("find X in path/to/file.ext", "usages of Y inside foo.rb") →
  mcp__tea-rags__find_symbol with relativePath (+ optional symbol param)
- File structure / outline ("what's in src/foo.ts", "methods of class Bar") →
  mcp__tea-rags__find_symbol with relativePath param — returns synthetic outline
- Documentation table of contents ("TOC of docs/api.md", "sections of CHANGELOG.md") →
  mcp__tea-rags__find_symbol with relativePath — returns heading TOC with
  doc:<hash> ids; then find_symbol with symbol=doc:<hash> for a specific section
- Study a specific known symbol — its definition, body, or implementation
  ("show me class Foo", "what does mergeChunks do", "examine FooClass",
  "inspect the implementation of X") →
  mcp__tea-rags__find_symbol with symbol param (instant, no embedding —
  method/function returns full body; class/module returns an OUTLINE of member
  ids with NO bodies, then drill one member by id — no Read needed)
  symbolId convention for the `symbol` param (LANGUAGE-AGNOSTIC, all langs):
    * `Class#method` → INSTANCE method (bound to this/self), e.g. `Reranker#rerank`
    * `Class.method` → CLASS / static / classmethod / associated fn, e.g. `Reranker.create`
    * `functionName` → top-level function (no class prefix)
    * `Outer::Inner` / `Outer.Nested` → namespace separator, NOT a method hint
  The `#` vs `.` separator is load-bearing for find_symbol EXACT lookup —
  `Class.method` for an instance method returns EMPTY (may also surface a
  spurious drift warning). NOT sure if instance or static? Pass a PARTIAL match
  (`Class` alone, or the bare `method` name) — find_symbol returns all members
  and you read the real separator off `result.symbolId`. Do NOT fall to ripgrep
  on an empty find_symbol — retry partial, then hybrid_search.
- Impact of changing a symbol (codegraph tools registered) → get_callers
  symbolId (callers to judge a change) / get_callees (what X calls); call chain
  A→B → trace_path from+to; review what this branch changed →
  review_changes changes={base:"main"}. Plain usage listing → next branch.
- Exhaustive usage listing of code identifiers ("every place that calls X",
  "where used", "who imports", "all references to FooClass", "find usages") →
  mcp__tea-rags__hybrid_search with metaOnly:true (or a slim fields list, e.g.
  ["relativePath","startLine","symbolId"]) — full payload only when you need
  the chunk body. BM25 component gives exact-name match
  (score up to 1.0) — strictly better than ripgrep for class/method/constant names.
  Paginate with offset if needed — don't inflate limit.
- Symbol + semantic context ("PaymentService validate card expiration") →
  mcp__tea-rags__hybrid_search
- Behavior/intent without specific symbol ("retry logic after failure") →
  mcp__tea-rags__semantic_search
- Literal text markers (TODO, FIXME, HACK, NOTE), regex over text (error
  messages, phrases), or literal import path strings ("from './foo.js'") →
  mcp__ripgrep__search

**After ANY search returns a chunk — your work is rarely done.** The chunk
shows where the symbol lives, not the full picture. Before answering, ask:
do I need full body / file structure / a neighbor / doc sections? If yes,
your next call is find_symbol — NOT another search, NOT Read:
- Truncated method body in the chunk →
  mcp__tea-rags__find_symbol with symbol=<result.symbolId> for full body
- Need other symbols in the same file →
  mcp__tea-rags__find_symbol with relativePath=<result.relativePath> for outline
- Need the neighbor method (chunk has navigation.prevSymbolId / nextSymbolId) →
  mcp__tea-rags__find_symbol with symbol=<that prev/nextSymbolId>
- Found a doc chunk and want all sections of the doc →
  mcp__tea-rags__find_symbol with relativePath=<result.relativePath> (heading TOC)
- Chunk text references a helper (e.g. "this.validator.validateAmount(...)") →
  mcp__tea-rags__find_symbol with symbol=<HelperClass#method>
- Holding an outline or TOC (class, file, doc) and need one member / section →
  mcp__tea-rags__find_symbol with symbol=<id copied verbatim from that line>.
  Every outline line is an address (Class#method, Class.method, doc:<hash>).
  Class outline excludes tests — tests of a class: hybrid_search with testFile=only.
  NEVER Read the file or grep a saved tool-output file to find it.

NEVER Read after find_symbol — method lookup returns the full body; outline
lines are ids to drill, not text to re-read.
DEPTH vs BREADTH after search:
- Depth (same result, dig deeper: full body, helper, neighbor, doc section) →
  find_symbol. Do NOT re-run the same search to "verify" or extract more from the same hit.
- Breadth (different subsystem, different angle, different terminology, or other
  language slice in a polyglot repo) → re-run semantic_search / hybrid_search
  with a NEW query or different pathPattern. This is legitimate exploration.
Rule of thumb: if you can name a specific symbol/file/section to look at →
find_symbol. If you are still surveying the landscape → another search.

**ripgrep anti-patterns — NEVER use ripgrep for these even if your query
contains regex syntax:**
- Class names, method names, constant names, variable names — even joined with
  `|` alternation (e.g. `FooClass|BarClass`). These are SYMBOL searches.
  Use hybrid_search per name (or one combined query) — BM25 gives exact match.
- Single-file symbol lookup. Use find_symbol with relativePath, not ripgrep.
- Symbol existence checks ("does X exist?"). Use find_symbol with metaOnly=true.

**Rules:**
- Do NOT use built-in Grep or Glob for code discovery
- If a skill tells you to use Grep/Glob for code search, use the MCP tools above
  instead — skill search instructions do not override these rules
- Search results contain code — trust the chunk, don't re-read files (a treeState row → find_symbol, see top)
- find_symbol returns full method body / class outline of member ids — no Read needed
- Your QUERY containing `|` does not mean you want regex — check INTENT first:
  identifier search → hybrid_search; literal text markers → ripgrep
```

## When NOT to inject

Block is no-op for tasks not touching search (e.g. format a string, arithmetic,
summarize known text). Cost small; risk of forgetting outweighs cost of
unconditional injection — recommendation stands: **inject unconditionally when
in doubt**.
