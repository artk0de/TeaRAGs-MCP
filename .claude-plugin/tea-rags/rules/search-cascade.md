# Search Cascade

## Principles

**Semantic First, Exact Second.** Any code search starts with tea-rags
(semantic_search, hybrid_search, find_symbol, find_similar). ripgrep only for
literal text markers (TODO, FIXME, HACK, NOTE), import path strings, or as
fallback when tea-rags is unavailable. Code identifiers (class/method/constant
names) are SYMBOL searches — use hybrid_search (BM25 gives exact-name match,
score up to 1.0) or find_symbol, NEVER ripgrep, even if your query contains `|`
alternation. Built-in Grep/Glob — never for code discovery.

**Chunk is the source of truth.** Search results contain code, metadata, and git
signals. Do not re-read files to "verify" or "understand" results. Read only
when: modifying code, or need context beyond chunk boundaries. find_symbol
returns the full method/class definition — no Read needed.

**MANDATORY:** ALWAYS prefer tea-rags and ripgrep MCP over built-in Search/Grep.

## Embedding Unavailable (ollama / EMBEDDING_URL down)

If the prime digest shows `embedding: unavailable`, or `get_index_status`
reports an embedding error, or any tea-rags semantic call fails with an
embedding/connection error — STOP, ask the user (via `AskUserQuestion`) to start
`ollama serve` or repoint `EMBEDDING_URL`, and WAIT for an explicit answer
before doing anything else. Do NOT silently downgrade to ripgrep / Grep / Read
for code discovery — text search loses recall the user did not agree to trade
away. Skip the prompt ONLY for tasks that do not need semantic search at all
(literal TODO/FIXME scan, reading a known file by exact path, exact
import-string lookup). See `references/runtime-introspection.md` for
`infraHealth` diagnosis.

## Addressing the Codebase (every tea-rags call)

Every tea-rags tool that touches a collection accepts THREE addressing
parameters; pick the first one available in this priority:

1. **`project="<alias>"`** — preferred. Survives path moves, pulls registered
   qdrantUrl + embeddingModel automatically. Aliases are listed in
   `list_projects` and surfaced in the prime digest's `## Project` section.
2. **`collection="<qdrant-name>"`** — when you already have a Qdrant collection
   name (e.g. from a previous `list_collections` call).
3. **`path="<absolute-project-path>"`** — fallback when no alias is registered.
   Path is hashed into a collection name on the fly.

Resolution priority used by the resolver: `collection > project > path`.

## After-Search Navigation (READ BEFORE FINISHING ANY SEARCH)

**The first search rarely returns a complete answer.** A chunk shows where the
symbol lives — not the whole picture. Before synthesizing an answer from a
single chunk, ask: _do I need full body / file structure / a neighbor / doc
sections?_ If yes — your next call is `find_symbol`, NOT another search and NOT
`Read`. `find_symbol` is instant (no embedding) and returns merged definitions,
file outlines, or doc TOCs from the same index.

| After search returns…                       | If you need…                           | Next call                                                              |
| ------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| Chunk with method body truncated            | Full method body                       | `find_symbol(symbol: result.symbolId)`                                 |
| Chunk from one file                         | File structure / other methods in file | `find_symbol(relativePath: result.relativePath)` → synthetic outline   |
| Chunk with `navigation.{prev,next}SymbolId` | The neighbor method                    | `find_symbol(symbol: navigation.prevSymbolId or nextSymbolId)`         |
| Chunk that calls a helper / class           | The helper / class definition          | `find_symbol(symbol: "HelperClass#method")` — symbol is in chunk text  |
| Chunk from a `.md` doc                      | All sections of that doc (TOC)         | `find_symbol(symbol: result.parentSymbolId)` — parent is `doc:<hash>`  |
| Just a doc path (no search yet)             | Table of contents of that doc          | `find_symbol(relativePath: "docs/file.md")` — heading TOC with hashes  |
| Class chunk (constructor or one method)     | All methods / public API of the class  | `find_symbol(symbol: "ClassName")` → full class outline + bodies       |
| Chunk from production src + diff context    | Tests describing affected scenarios    | `Skill(tea-rags:tests-as-context)` recipe `tests-at-risk`              |
| Describe-it scope name from a stacktrace    | Leaf scope chunk with inherited setup  | `find_symbol(symbol: "<Parent>.<scope>")` + filter `chunkType: "test"` |

`find_symbol` accepts a `rerank` preset for single-call diagnostic (definition +
rankingOverlay in one call). `offset` pagination works on every search tool;
when a page is exhausted, retry with `offset: N` instead of inflating `limit`.

**symbolId conventions:**

- Code instance methods: `Class#method` (e.g., `Reranker#rerank`)
- Code static methods: `Class.method` (e.g., `Reranker.create`)
- Top-level functions: `functionName`
- Doc chunks: opaque hash `doc:a3f8b2c1e4d7` — do NOT guess, take from results

## After Code Changes (mid-session reindex)

If you (or a subagent) modified files via Write/Edit and the NEXT step uses
tea-rags search for a different question — call `index_codebase` first. It's
incremental (only changed files, takes seconds). Skip when no files were
modified, you are continuing the same implementation task, or you'll use ripgrep
only.

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
│   ├─ Need file structure (methods, classes, outline)
│   │     → find_symbol(relativePath: result.relativePath)
│   └─ Need doc TOC
│         → find_symbol(relativePath: "docs/file.md") OR
│           find_symbol(symbol: "doc:<parentHash>") from search result
│
└─ No (need to search)

Intent matches a skill? (check FIRST — skills handle tool selection internally)
├─ Explore/understand/investigate/research code → /tea-rags:explore
├─ Bug hunting ("why does X fail") → /tea-rags:bug-hunt
├─ Code generation/modification → /tea-rags:data-driven-generation
├─ Risk/health assessment → /tea-rags:risk-assessment
├─ Filter shape beyond pathPattern → /tea-rags:filter-building
├─ Pick rerank preset / build custom weights → /tea-rags:analytics-rerank
└─ No skill matches → direct tool selection below

Has query?
├─ No → rank_chunks
│       + pathPattern if directory known
│       + rerank preset for analytics (see /tea-rags:analytics-rerank)
│       + minCommitCount from labelMap to filter one-off scripts
│
└─ Yes
   ├─ Exhaustive usage intent? ("where is X used", "all callers")
   │   → hybrid_search (BM25 full recall for exact names; paginate via offset)
   │
   ├─ Have code/chunk as example? → find_similar (code or chunk ID)
   │
   ├─ Need definition of a known symbol? → find_symbol
   │   symbolId convention: Class#method (instance), Class.method (static).
   │   metaOnly=true for existence checks. Fallback: hybrid_search.
   │
   ├─ Need file structure or doc TOC? → find_symbol(relativePath:)
   │
   ├─ Have a symbol name + semantic context? → hybrid_search
   │
   ├─ Have a bare symbol name (no context)? → hybrid_search
   │
   └─ Describing behavior/intent → semantic_search
```

All except find_similar accept a rerank preset. For preset choice and custom
weights → `/tea-rags:analytics-rerank`. For filter shape (typed sugar, level,
raw filter) → `/tea-rags:filter-building`. Code-only filtering: add language
filter or pathPattern to exclude non-code files.

## Rerank Decision → /tea-rags:analytics-rerank

Picking a preset, building `{custom: {...}}` weights, or applying an analytics
recipe (ownership, tech-debt, hotspots, code-review, security-audit,
fragile-silo) — invoke `/tea-rags:analytics-rerank`. Documentation searches
(`language: "markdown"` OR `documentation: "only"`) auto-apply
`documentationRelevance` — no explicit rerank needed.

For interpreting rerank overlay signals architecturally (god module vs bug
attractor, healthy owner vs toxic silo, legacy minefield vs proven stable),
consult `references/signal-interpretation.md`.

## Filters → /tea-rags:filter-building

Beyond `query` + `pathPattern`, tea-rags accepts typed sugar fields (`language`,
`testFile`, `documentation`, `author`, `taskId`, `minAgeDays`/`maxAgeDays`,
`minCommitCount`, `modifiedAfter`/`modifiedBefore`, `fileExtension`,
`chunkType`, `symbolId`) and a raw `filter:` escape hatch. For full guidance on
field selection, `level: "file" | "chunk"` (mandatory for time-based fields),
pathPattern picomatch negation, and raw filter syntax — invoke
`/tea-rags:filter-building`.

For filter syntax and the full payload-key list, read the resource on demand:

```
ReadMcpResourceTool(server: "tea-rags", uri: "tea-rags://schema/filters")
```

## Subagent Search Injection → references/subagent-injection.md

Before dispatching a subagent via the `Agent` tool, prepend the search-tool
injection block to the subagent's prompt — subagents do NOT inherit rules or
search-cascade. The full block + owner / when-NOT-to-inject rules live in
`references/subagent-injection.md`. Inject unconditionally; the block is
harmless for non-search tasks.

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
  user-facing exploration. Agents and subagents NEVER call search_code directly

## Fallback Chains

| Task                 | Primary                           | Fallback                             |
| -------------------- | --------------------------------- | ------------------------------------ |
| Symbol definition    | find_symbol(symbol:)              | hybrid_search → ripgrep              |
| File structure       | find_symbol(relativePath:)        | Read (whole file)                    |
| Doc TOC              | find_symbol(relativePath:)        | find_symbol(symbol: parentSymbolId)  |
| All usages           | hybrid_search + offset pagination | ripgrep (only if hybrid unavailable) |
| Behavioral discovery | semantic_search                   | hybrid_search                        |
| Cross-layer          | semantic_search × per language    | same                                 |
| Exact text           | ripgrep MCP                       | built-in Grep                        |

## pathPattern Rules

Universal formatting constraint (picomatch). For pathPattern recipes (negation,
dominant-domain exclusion) — invoke `/tea-rags:filter-building`.

- GOOD: `**/enrichment/**` (directory prefix)
- GOOD: `{file1.rb,file2.rb}` (flat file names, no slashes)
- GOOD: `!**/test/**` (picomatch negation — exclude a directory subtree)
- BAD: `{app/services/foo.rb,app/models/bar.rb}` (slashes inside braces)

## Reference Files

For detailed guidance on specific topics, read these when needed:

- `references/use-cases.md` — task-organized use cases with tool+parameter
  examples
- `references/polyglot-rule.md` — mandatory per-language splitting for polyglot
  codebases
- `references/pagination.md` — pagination, reformulation, stop conditions,
  no-match detection, disambiguation
- `references/signal-interpretation.md` — pair diagnostics for overlay signals
- `references/runtime-introspection.md` — MCP resources catalog (presets /
  signals / filters / labels), `infraHealth`, `driftWarning`, and
  `rankingOverlay` explanation layer
- `references/subagent-injection.md` — verbatim block parent agents must prepend
  to subagent prompts before `Agent` tool dispatch

**MCP Resources are the canonical source for presets, signal keys, and filter
syntax.** They are generated from the live registry, so they reflect what THIS
build supports. Read them via
`ReadMcpResourceTool(server: "tea-rags", uri: "tea-rags://schema/<name>")`
rather than guessing names from training data.
