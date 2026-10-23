# Decision Tree — tool and skill selection

## Principles

**Semantic First, Exact Second.** Code search starts with tea-rags
(semantic_search, hybrid_search, find_symbol, find_similar). ripgrep only for
literal text markers (TODO, FIXME, HACK, NOTE), import path strings, or fallback
when tea-rags unavailable. Code identifiers (class/method/constant names) are
SYMBOL searches — use hybrid_search (BM25 = exact-name match, score up to 1.0)
or find_symbol, NEVER ripgrep, even if query has `|` alternation. Built-in
Grep/Glob — never for code discovery.

**MANDATORY:** ALWAYS prefer tea-rags and ripgrep MCP over built-in Search/Grep.

## Tool Invocation Under Deferred Loading

Recent models load tool **names** only; full schema fetched on demand
(`ToolSearch`) AFTER you pick a tool. Pick EXACT tool from decision tree below
first, then fetch only that one — wrong pick costs a wasted fetch.
Fully-qualified fetch names:

- Every tea-rags tool is **`mcp__tea-rags__<name>`** — e.g.
  `mcp__tea-rags__find_symbol`, `mcp__tea-rags__hybrid_search`,
  `mcp__tea-rags__semantic_search`, `mcp__tea-rags__rank_chunks`,
  `mcp__tea-rags__find_similar`, `mcp__tea-rags__get_callers`,
  `mcp__tea-rags__trace_path`.
- ripgrep is **`mcp__ripgrep__search`** (and `mcp__ripgrep__advanced-search`).

Tool names appear bare below for readability — prepend the prefix when calling.

## Decision Tree

Single point of tool selection. Follow top-to-bottom, take first matching
branch. **Prefer skills over direct tool calls** — skills encapsulate the right
tool sequence, rerank presets, output formatting.

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
│   │     → find_symbol(relativePath: "docs/file.md")
│   ├─ Hold outline / TOC, need one member / section / test
│   │     → find_symbol(symbol: <id from that line>) — never Read / grep
│   └─ Need graph navigation (codegraph must be enabled)
│         → guide `navigation` "Graph navigation": get_callers/get_callees (one hop,
│           default) → find_cycles → trace_path (full A→B chain, escalate only)
│
└─ No (need to search)

Intent matches a skill? (check FIRST — skills handle tool selection internally)
├─ Explore/understand/investigate/research code → /tea-rags:explore
├─ Bug hunting ("why does X fail") → /tea-rags:bug-hunt
├─ Code generation/modification → /tea-rags:data-driven-generation
├─ Risk/health assessment → /tea-rags:risk-assessment
├─ Layout / dependency direction / SDP → /tea-rags:architecture-diagnostics
├─ Plan a refactoring (ordered, simulated fix steps) → /tea-rags:refactoring-planning
├─ Review a diff / MR ("what does my change break") → `review_changes(changes:{base})`
│   sections: naming | incompleteChange | cohesion | architecture — default all;
│   unknown = error; absent section = not asked; NOT a search tool, never discovery
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
   │     metaOnly=true for existence checks. (modes: guide `navigation` "find_symbol")
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
   ├─ Naming? ("what does the project call X", "how are values of type T
   │   named", "is this name right") → get_naming_lexicon (codegraph on);
   │     reading the answer: /tea-rags:data-driven-generation Step 5 Naming
   │     One name / rename → `names[]`; review names a diff introduces →
   │     review_changes ({} = uncommitted, { base } = branch) → `review.findings`
   │
   ├─ Audit naming consistency / find ontology collisions project-wide
   │   → get_ontology_report (codegraph on; synonyms, homonyms, outliers, collisions)
   │
   └─ Describing behavior / intent (no exact name) → semantic_search
```

Every tool above accepts a rerank preset, find_similar included — its preset
list omits only `documentationRelevance` and `blastRadius`. `rank_chunks`
requires one rather than accepting it optionally. For preset choice + custom
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
consult `rules/references/signal-interpretation.md`.

## Filters → /tea-rags:filter-building

Beyond `query` + `pathPattern`, tea-rags accepts typed sugar fields (`language`,
`testFile`, `documentation`, `author`, `recentAuthor`, `contributor`, `taskId`,
`minAgeDays`/`maxAgeDays`, `minCommitCount`, `modifiedAfter`/`modifiedBefore`,
`fileExtension`, `chunkType`, `symbolId`) and a raw `filter:` escape hatch.
Person scope splits three ways — `author` = blame owner of the live lines
("whose code is this" / bus factor; pair `rerank: "ownership"`), `recentAuthor`
= dominant recent committer ("what did X work on lately" → + `modifiedAfter`),
`contributor` = anyone who committed to the file ("everything X touched"). For
full guidance on field selection, `level: "file" | "chunk"` (filter scope AND
result granularity — `modifiedAfter`/`modifiedBefore` never need it),
pathPattern picomatch negation, and raw filter syntax — invoke
`/tea-rags:filter-building`.

For filter syntax and the full payload-key list, read the resource on demand:

```
ReadMcpResourceTool(server: "tea-rags", uri: "tea-rags://guide/filters")
```

## Subagent Search Injection → rules/references/subagent-injection.md

Before dispatching a subagent via the `Agent` tool, prepend the search-tool
injection block to the subagent's prompt — subagents do NOT inherit rules or
this guide. Full block + owner / when-NOT-to-inject rules live in
`rules/references/subagent-injection.md`. Inject unconditionally; harmless for
non-search tasks. Never inject a fixed `path` — the subagent passes its own
working directory as `path`; the hook supplies the repository's `project` alias
(same for every checkout).

## Prohibited Patterns

- **Built-in Grep for code discovery** — use tea-rags or ripgrep MCP
- **Bash shell over code** (`cat` / `sed -n` / `head` / `grep` / `rg` /
  `git show <rev>:<file>`) to locate or understand code — same downgrade as Read
  / Grep; harness "use Bash" note does not override. Identifier → find_symbol /
  hybrid_search; file → find_symbol(relativePath:)
- **Leaving tea-rags because index lags / drifted / overlay cold** — guide
  `freshness` "Lag never licenses leaving tea-rags"
- **Read file to verify search results** — chunk is the source of truth
- **Read file after find_symbol** — find_symbol returns full definition (method)
  or addressable outline (class / doc)
- **Grep / Read a saved find_symbol dump or an outline** — lines are ids; drill
  `find_symbol(symbol: <id>)` instead
- **Conclusions from one `#partN` chunk** — fetch the whole symbol first
  (`find_symbol(symbol: parentSymbolId)`); parts of one symbol count as ONE hit
- **Multiple semantic_search for same area** — one call, navigate from results
- **Unfiltered semantic_search for cross-layer** — dominant language takes 100%
  of slots. Always use language filter (see `rules/references/polyglot-rule.md`)
- **semantic_search for "find all usages"** — use hybrid_search instead. BM25
  component provides full recall for exact symbol names
- **ripgrep for symbol existence checks** — use find_symbol with metaOnly=true
- **ripgrep for class/method/constant usage** (e.g.
  `classAncestors|classExtends` consumers) — these are SYMBOL searches; use
  hybrid_search (BM25) or find_symbol
- **ripgrep fallback justified by a stale prime digest** — digest is a
  start-of-session SNAPSHOT. Confirm a suspected embedding/index outage with a
  LIVE get_index_status before downgrading; find_symbol + hybrid_search BM25
  work with embedding down anyway
- **Doc-sourced behavior claim without code verification** — docs = hypothesis;
  verify via find_symbol/hybrid_search, flag drift (guide `navigation`
  "Principles")
- **Mixed-axis broad exploration** — one unfiltered query over src+tests+docs
  lets dominant class take all slots; split per
  `rules/references/axis-splitting.md`
- **Judging a name by grep or semantic_search on the draft name** — the draft
  pulls in its own lexical neighbours; use get_naming_lexicon (`names[]`); a
  diff → review_changes `naming` (never hand-list a diff's names)
- **hybrid_search for TODO/FIXME/HACK markers** — use ripgrep MCP
- **git log/diff for code history** — overlay already has git signals
- **10+ ripgrep calls instead of reading a file** — just read it
- **search_code directly** — ONLY used through /tea-rags:explore skill for
  user-facing exploration. Agents and subagents NEVER call search_code directly

## Fallback Chains

| Task                          | Primary                           | Fallback                                          |
| ----------------------------- | --------------------------------- | ------------------------------------------------- |
| Symbol definition             | find_symbol(symbol:)              | hybrid_search → ripgrep                           |
| File structure                | find_symbol(relativePath:)        | Read (whole file)                                 |
| Doc TOC                       | find_symbol(relativePath:)        | find_symbol(symbol: parentSymbolId)               |
| All usages                    | hybrid_search + offset pagination | ripgrep (only if hybrid unavailable)              |
| Behavioral discovery          | semantic_search                   | hybrid_search                                     |
| Cross-layer                   | semantic_search × per language    | same                                              |
| Exact text                    | ripgrep MCP                       | built-in Grep                                     |
| Call path A→B (codegraph on)  | trace_path                        | get_callees breadth-first (manual)                |
| Call path A→B (codegraph off) | semantic_search / hybrid + manual | — (graph tools unavailable; see Graph navigation) |
| Naming vocabulary / verdict   | get_naming_lexicon                | codegraph off: DDG Step 5 Naming concept recipe   |
| Naming review of a diff       | review_changes `naming`           | codegraph off: not assessed (no substitute)       |

## pathPattern Rules

Universal formatting constraint (picomatch, exact match on project-relative
`relativePath`). For pathPattern recipes (negation, dominant-domain exclusion) —
invoke `/tea-rags:filter-building`.

- GOOD: `**/enrichment/**` (directory at any depth)
- GOOD: `{app/services/foo.rb,app/models/bar.rb}` (exact relativePaths from
  results)
- GOOD: `**/{file1.rb,file2.rb}` (bare file names, any directory)
- GOOD: `!**/test/**` (picomatch negation — exclude a directory subtree)
- BAD: `{file1.rb,file2.rb}`, `services/**` (no `**/` → project root only)
- BAD: `/Users/me/project/src/**` (absolute path — never matches)

## Reference Files

For detailed guidance on specific topics, read these when needed:

- `tea-rags://guide/freshness` — reindex decision table: stale / schema-drift /
  edited-not-indexed → which reindex tool, and when consent is required
- `rules/references/use-cases.md` — task-organized use cases with tool+parameter
  examples
- `rules/references/polyglot-rule.md` — mandatory per-language splitting for
  polyglot codebases
- `rules/references/axis-splitting.md` — sources/tests/docs axis roles +
  per-axis splitting for broad exploration
- `tea-rags://guide/pagination` — pagination, reformulation, stop conditions,
  no-match detection, disambiguation
- `rules/references/signal-interpretation.md` — pair diagnostics for overlay
  signals
- `rules/references/runtime-introspection.md` — MCP resources catalog (presets /
  signals / filters / labels), `infraHealth`, `driftWarning`, and
  `rankingOverlay` explanation layer
- `rules/references/subagent-injection.md` — verbatim block parent agents must
  prepend to subagent prompts before `Agent` tool dispatch

**MCP Resources are the canonical source for presets, signal keys, and filter
syntax.** Generated from the live registry, so they reflect what THIS build
supports. Read them via
`ReadMcpResourceTool(server: "tea-rags", uri: "tea-rags://guide/<name>")` rather
than guessing names from training data.

## Portability (non-Claude-Code clients)

This document assumes the Claude Code harness: skill invocations
(`/tea-rags:*`), the `Agent` tool, `ReadMcpResourceTool`. MCP-only clients
(Cursor, Roo, custom agents) have no skills — strip skill directives, consume
the same guidance from portable MCP resources instead:
`tea-rags://guide/search-examples` (tool routing + examples),
`tea-rags://guide/overview` (catalog), `tea-rags://guide/presets`,
`tea-rags://guide/filters`, `tea-rags://guide/signals`. Decision tree,
prohibited patterns, fallback chains above are harness-agnostic, apply to any
client.
