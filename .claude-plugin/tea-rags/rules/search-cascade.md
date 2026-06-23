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

## Tool Invocation Under Deferred Loading

Recent models load only tool **names** into context; the full schema is fetched
on demand (`ToolSearch`) AFTER you pick a tool. So pick the EXACT tool from the
decision tree below first, then fetch only that one — a wrong pick costs a
wasted fetch. Fully-qualified names for the fetch:

- Every tea-rags tool is **`mcp__tea-rags__<name>`** — e.g.
  `mcp__tea-rags__find_symbol`, `mcp__tea-rags__hybrid_search`,
  `mcp__tea-rags__semantic_search`, `mcp__tea-rags__rank_chunks`,
  `mcp__tea-rags__find_similar`, `mcp__tea-rags__get_callers`,
  `mcp__tea-rags__trace_path`.
- ripgrep is **`mcp__ripgrep__search`** (and `mcp__ripgrep__advanced-search`).

Tool names appear bare below for readability — prepend the prefix when calling.

## Embedding Unavailable (ollama / EMBEDDING_URL down)

**The prime digest is a point-in-time SNAPSHOT, not live state.** Its
`embedding: unavailable` line reflects infra health at session start and goes
stale the moment ollama comes back. NEVER treat a stale digest as a licence to
fall back to ripgrep/Grep for code discovery. Before acting on a suspected
outage, confirm with a LIVE `get_index_status` call — its `Infrastructure:`
footer reports the current `Embedding (ollama): available | unavailable`. Act on
the live read, not the snapshot.

**Even when embedding is genuinely down, code-identifier search still works.**
`find_symbol` uses Qdrant text match (zero embedding) and `hybrid_search`'s BM25
component gives exact-name match (score up to 1.0) without the dense vector. A
down embedding degrades behavioral/semantic recall (`semantic_search` intent
queries) — it does NOT justify ripgrep for class/method/constant lookups.

If a LIVE `get_index_status` reports an embedding error, or any tea-rags
semantic call fails with an embedding/connection error — STOP, ask the user (via
`AskUserQuestion`) to start `ollama serve` or repoint `EMBEDDING_URL`, and WAIT
for an explicit answer before doing anything else. Do NOT silently downgrade to
ripgrep / Grep / Read for code discovery — text search loses recall the user did
not agree to trade away. Skip the prompt ONLY for tasks that do not need
semantic search at all (literal TODO/FIXME scan, reading a known file by exact
path, exact import-string lookup) — and for code-identifier lookups, reach for
`find_symbol` / `hybrid_search` BM25 first (they need no embedding), not
ripgrep. See `references/runtime-introspection.md` for `infraHealth` diagnosis.

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

**symbolId conventions (LANGUAGE-AGNOSTIC — same `#`/`.` rule for every
language; this is the input contract for `find_symbol(symbol:)`):**

- Code instance methods: `Class#method` (e.g., `Reranker#rerank`) — bound to
  `this`/`self`. Constructors are instance-bound too (`Class#constructor`).
- Code static / class / classmethod / associated methods: `Class.method` (e.g.,
  `Reranker.create`)
- Top-level functions: `functionName` (no class prefix)
- Namespace separators are NOT a method hint: Ruby/Rust `::` (`Acme::User`) and
  TS/JS/Python nested-class `.` (`Outer.Nested`) only scope the container —
  methods on them still use `#`/`.` (`Acme::User#save`).
- Doc chunks: opaque hash `doc:a3f8b2c1e4d7` — do NOT guess, take from results

The `#`/`.` separator is **load-bearing for `find_symbol` EXACT lookup only**:
`find_symbol(symbol: "Class.method")` for an instance method returns EMPTY (and
may surface a spurious drift warning) — an empty result is a WRONG-SEPARATOR
signal, not a stale index. It is irrelevant for `hybrid_search`'s `symbolId`
(partial, substring match — pass a bare name). When unsure instance vs static,
pass a **partial match** to `find_symbol` (`Class` alone, or the bare `method`)
and read the real separator off `result.symbolId`; never downgrade an empty
`find_symbol` to ripgrep. Producer-side source of truth (how the separator is
chosen per language at index time): `.claude/rules/symbolid-convention.md`
(`INSTANCE_METHOD_SEPARATOR` in `infra/symbolid/classify.ts`).

### find_symbol — the navigation workhorse (two addressing modes)

`find_symbol` is instant (no embedding) and answers most "now show me X"
follow-ups. Choose the mode by what you already hold:

**Mode A — `symbol:` (you know the name)**

| You have…                        | Pass                              | You get                                       |
| -------------------------------- | --------------------------------- | --------------------------------------------- |
| Instance method                  | `symbol: "Class#method"`          | merged full method body                       |
| Static method / top-level fn     | `symbol: "Class.method"` / `"fn"` | merged full definition                        |
| **Class or module name**         | `symbol: "ClassName"`             | full class/module outline + all method bodies |
| Existence check only             | `symbol: "X", metaOnly: true`     | presence + location, no body (cheapest)       |
| Doc section (hash from a result) | `symbol: "doc:<hash>"`            | that doc heading's chunk                      |

**Mode B — `relativePath:` (you have a file path) — USE THIS MORE.** With no
symbol, just a path, find_symbol returns a synthetic outline of the whole file.
Agents under-use it; it is the correct route, not `Read`, not `semantic_search`:

- **`relativePath: "docs/file.md"` → the doc's heading TOC** (table of contents,
  one hash per heading). THE way to map a markdown doc before reading it.
  Whenever a task touches a `.md` doc and you lack a `doc:<hash>`, start here.
- **`relativePath: "src/foo.ts"` → file structure**: every class/method/function
  outline in that file. Use instead of `Read` to answer "what's in this file".

### Graph navigation — get_callers / get_callees / trace_path

Requires codegraph. **Availability signal:** the prime digest's `## Enrichment`
section lists `codegraph.symbols` when codegraph is active. When that line is
absent the four graph tools (`get_callers`, `get_callees`, `find_cycles`,
`trace_path`) are **not registered** — they never appear in the tool list. So
the off-signal is an _absent tool_, not an empty result; check prime first
rather than calling a tool to discover it is missing. Precedence — start cheap,
escalate only if needed:

1. **`get_callers` / `get_callees`** — ONE hop ("who calls X" / "what X calls").
   Default for impact & dependency questions; instant, no traversal.
2. **`find_cycles`** — detect circular dependency chains.
3. **`trace_path`** — ALL paths A→B with per-step danger ranking. Escalate here
   ONLY when the full chain matters ("how does control reach B from A?", "which
   step on the A→B chain is riskiest?"), never for a single hop.

**When codegraph is off** (no `codegraph.symbols` in prime), route by intent to
a non-graph substitute — and never read an absent/empty graph tool as a positive
fact (no "it's a DAG", no "the path is structurally impossible", no "this is the
architectural centre"):

| Graph intent          | Non-codegraph fallback                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------- |
| who calls / X calls   | `hybrid_search` (exact-name recall) + `find_symbol` — name-match, NOT edge truth          |
| call path A→B         | `semantic_search` / `hybrid_search` + manual reading; say plainly "no static path tool"   |
| cycles                | none — cycle detection NEEDS codegraph; say so, do NOT claim "no cycles / it's a DAG"      |
| architectural hubs    | git imports/churn rerank or relevance; say fan-in centrality is unavailable                |
| entry points          | relevance + `chunkSize` heuristic; flag results as content-inferred, not graph-confirmed   |

### Optimal routes (navigate, don't re-search)

- After ANY search → next call is `find_symbol`, never another search, never
  `Read`. The chunk already names the symbol/path you need.
- Doc structure → `find_symbol(relativePath: "docs/x.md")`, never `Read` the md.
- A class's full API → `find_symbol(symbol: "ClassName")`, one call.
- Who-uses-X repo-wide → `hybrid_search` (text recall) when codegraph is off;
  `get_callers` (exact, graph) when codegraph is on.

## Index Freshness → index-freshness.md

Before searching, reindex when the index lags the working tree: prime banner
`⚠ Index is stale` or files edited this session → `index_codebase` (incremental,
no consent); prime `## Schema drift` ≠ `none` → `force_reindex` (full,
**explicit consent**). Full triggers + rationale in `index-freshness.md`.

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
│   ├─ Need doc TOC
│   │     → find_symbol(relativePath: "docs/file.md") OR
│   │       find_symbol(symbol: "doc:<parentHash>") from search result
│   └─ Need graph navigation (codegraph must be enabled)
│         → see "Graph navigation" above: get_callers/get_callees (one hop,
│           default) → find_cycles → trace_path (full A→B chain, escalate only)
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
└─ Yes  (axis: DEFINITION vs USAGES vs INTENT — pick one)
   ├─ Known symbol — need its DEFINITION / body / class outline?
   │   → find_symbol (instant, no embedding). Class#method | Class.method | fn.
   │     metaOnly=true for existence checks. (modes: "find_symbol" section above)
   │     Fallback when the symbolId is a guess / fuzzy: hybrid_search.
   │
   ├─ Need file structure or a doc's TOC? → find_symbol(relativePath:)
   │     .md path → heading TOC; src path → file outline. NOT Read.
   │
   ├─ Exact identifier — need all USAGES / matches? ("where is X used")
   │   → hybrid_search (BM25 full recall for exact names; paginate via offset)
   │
   ├─ Have code/chunk as example? → find_similar (code or chunk ID)
   │
   └─ Describing behavior / intent (no exact name) → semantic_search
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
- **ripgrep for class/method/constant usage** (e.g.
  `classAncestors|classExtends` consumers) — these are SYMBOL searches; use
  hybrid_search (BM25) or find_symbol
- **ripgrep fallback justified by a stale prime digest** — the digest is a
  start-of-session SNAPSHOT. Confirm a suspected embedding/index outage with a
  LIVE get_index_status before downgrading; find_symbol + hybrid_search BM25
  work with embedding down anyway
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
| Call path A→B (codegraph on)  | trace_path               | get_callees breadth-first (manual)   |
| Call path A→B (codegraph off) | semantic_search / hybrid + manual | — (graph tools unavailable; see Graph navigation) |

## pathPattern Rules

Universal formatting constraint (picomatch). For pathPattern recipes (negation,
dominant-domain exclusion) — invoke `/tea-rags:filter-building`.

- GOOD: `**/enrichment/**` (directory prefix)
- GOOD: `{file1.rb,file2.rb}` (flat file names, no slashes)
- GOOD: `!**/test/**` (picomatch negation — exclude a directory subtree)
- BAD: `{app/services/foo.rb,app/models/bar.rb}` (slashes inside braces)

## Reference Files

For detailed guidance on specific topics, read these when needed:

- `index-freshness.md` — reindex decision table: stale / schema-drift /
  edited-not-indexed → which reindex tool, and when consent is required
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

## Portability (non-Claude-Code clients)

This document assumes the Claude Code harness: skill invocations
(`/tea-rags:*`), the `Agent` tool, and `ReadMcpResourceTool`. MCP-only clients
(Cursor, Roo, custom agents) have no skills — strip the skill directives and
consume the same guidance from the portable MCP resources instead:
`tea-rags://schema/search-guide` (tool routing + examples),
`tea-rags://schema/overview` (catalog), `tea-rags://schema/presets`,
`tea-rags://schema/filters`, `tea-rags://schema/signals`. The decision tree,
prohibited patterns, and fallback chains above are harness-agnostic and apply to
any client.
