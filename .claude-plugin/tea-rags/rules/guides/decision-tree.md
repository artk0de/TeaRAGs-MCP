# Decision Tree — tool and skill selection

## Principles

**Semantic First, Exact Second.** Meaning search, reads, graph and analytics
start with tea-rags (semantic_search, hybrid_search for symbol + intent,
find_symbol, find_similar, get_callers / get_callees / trace_path, rerank
presets). Text search — your default code search tool (not a tea-rags tool) —
for exact text: occurrences of an identifier / constant / string ("where is X
used", "every call of X", "files containing X", even `a|b` alternation or a name
the user calls a "pattern"), regex syntax, TODO/FIXME/HACK/NOTE markers,
phrases, error strings, import path strings; also the fallback when tea-rags is
unavailable. Occurrence searches are bounded: files-with-matches first, or a
line cap (`-l`), scoped to the anchor's dir when known, else the source root —
never hybrid_search / semantic_search to find a dir for it, never an unbounded
search. Then the hit file's outline → batch of only the needed methods (each
hit's enclosing method) via find_symbol, never the default code read tool or
`cat`. An identifier's DEFINITION / body / outline is a SYMBOL lookup →
find_symbol, never text search; only its OCCURRENCES go to the default code
search tool. Glob — never for code discovery.

**MANDATORY:** ALWAYS prefer tea-rags over text search for meaning and reads.

## Tool Invocation Under Deferred Loading

Recent models load tool **names** only; full schema fetched on demand
(`ToolSearch`) AFTER you pick a tool. Pick EXACT tool from decision tree below
first, then fetch only that one — wrong pick costs a wasted fetch. In Claude
Code `find_symbol` and `hybrid_search` are always loaded — call them directly,
no `ToolSearch` first. Fully-qualified fetch names:

- Every tea-rags tool is **`mcp__tea-rags__<name>`** — e.g.
  `mcp__tea-rags__find_symbol`, `mcp__tea-rags__hybrid_search`,
  `mcp__tea-rags__semantic_search`, `mcp__tea-rags__rank_chunks`,
  `mcp__tea-rags__find_similar`, `mcp__tea-rags__get_callers`,
  `mcp__tea-rags__trace_path`.

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
│   │     → default code search tool "<name>" <dir> (literal, files-with-matches)
│   │       → find_symbol outline → batch of only the needed methods
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
├─ Explore/understand/investigate/research code → /tea-rags:explore — open its
│   SKILL.md, state its Step 0 strategy first. Decisive calls:
│   ├─ pre-change ("before I modify/refactor X", "research X first", plan step
│   │   "Research X before implementing Y", risks of ONE named change) → PRE-GEN:
│   │   semantic_search metaOnly=true limit=10 → ONE find_symbol(symbols=[2–5
│   │   key symbols], rerank="techDebt") → find_symbol on 1–2 base symbols,
│   │   never call chains.
│   │   Self-contained — not brainstorming / executing-plans / DDG / risk-assessment
│   ├─ "what changed recently in X" → rank_chunks rerank="codeReview" maxAgeDays=14
│   └─ "who owns / knows X" → rank_chunks rerank="ownership" (never semantic_search)
├─ Bug hunting ("why does X fail") → /tea-rags:bug-hunt
├─ Code generation/modification → /tea-rags:data-driven-generation
├─ One analytics question one preset / recipe answers ("bug-prone areas in X",
│   "looks stable but breaks", "who drives X lately", "old auth code")
│   → /tea-rags:analytics-rerank (single call, not a scan)
├─ Risk/health of an AREA (multi-preset scan, tiers) → /tea-rags:risk-assessment
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
   ├─ Need file structure, a doc's TOC or a directory's contents?
   │     → find_symbol(relativePath:)
   │     .md path → heading TOC; src path → file outline (small file → full
   │     text); directory → files + top-level symbols + subdirs. NOT Read, NOT ls.
   │
   ├─ Exact identifier — need all USAGES / matches? ("where is X used")
   │   → default code search tool "<X>" <dir> (literal, `-l`; <dir> =
   │     the anchor's dir when known, else the source root — never a
   │     search to find it; never unbounded), then find_symbol outline → batch of only the needed
   │     methods; every caller → get_callers AND that search (call sites the
   │     graph misses). Symbol + intent → hybrid_search
   │
   ├─ Have code/chunk as example? → find_similar (code or chunk ID)
   │
   ├─ Naming? ("what does the project call X", "how are values of type T
   │   named", "is this name right") → get_naming_lexicon (codegraph on);
   │     reading the answer: /tea-rags:data-driven-generation Step 5 Naming
   │     One name / rename → `names[]` (`{name, kind, type?}` — never a bare
   │     call with only project/path); its verdict IS the answer — no
   │     hybrid_search / semantic_search cross-check. Names a diff introduces →
   │     review_changes ({} = uncommitted, { base } = branch), naming section →
   │     `review.findings` ARE the answer — no get_naming_lexicon follow-up,
   │     never hand-list the diff's names into `names[]`
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

## Question → call (research, planning, review)

Research / planning question (understand X before a change, map an area, answer
a design question) → find its row, run that call; never `ls` / `cat` / `grep` /
`git ls-files` to explore. After the first hit: how it works →
`get_callees(symbolId:)`, who uses it → `get_callers(symbolId:)` (id from the
row); the ids an answer NAMED → ONE `find_symbol(symbols: [<ids>])` — member
ids, never file/dir paths (area/dir → `find_symbol(relativePath:)` outline
first); a 2nd search needs a new noun. Files outside the index (`*.json`,
locale/data `*.yml`, generated) → client's tools, say so.

| Question                                                     | Call                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Layout / architecture of area `<dir>`                        | `find_symbol(relativePath: "<dir>")` → `get_architecture_report(pathPattern: "<dir>/**")`                        |
| Is the codebase laid out correctly                           | `/tea-rags:architecture-diagnostics`                                                                             |
| What implements contract / port / base `<P>`                 | `find_symbol(symbol: "<P>")` → `get_callers` + `hybrid_search(query: "<P>", metaOnly: true)`                     |
| Where `<X>` is registered / resolved / configured / flagged  | `hybrid_search(query: "<X> register config flag", metaOnly: true)` → `find_symbol(symbols: [<hit ids>])`         |
| Which models / tables back `<X>`                             | `hybrid_search(query: "<X> model", metaOnly: true)`; schema / migrations outside the index → client's tools      |
| What the existing provider / impl does for `<W>`             | `find_symbol(symbol: "<Impl>#<method>")`                                                                         |
| How does `<A>` reach `<B>`, riskiest step                    | `find_symbol` ids → `trace_path(rerank: "dangerous")`; one hop → `get_callers`                                   |
| Where do we do `<X>` (code may use other words)              | `hybrid_search(query: "<X>")`; what it touches → `rerank: "blastRadius"`                                         |
| Onboard me into `<area>` / entry points                      | `/tea-rags:explore` · `semantic_search(rerank: "onboarding" \| "entryPoint", pathPattern)`                       |
| Which modules the app is built around                        | `rank_chunks(rerank: "architecturalHub")` · `filter: { presets: "hubs" }`                                        |
| What was done under ticket `<T>`                             | `semantic_search(query: "<topic>", taskId: "<T>")`                                                               |
| Which of N similar implementations to copy                   | `semantic_search(query, rerank: "proven", filter: { presets: "battleTested" })`                                  |
| Is there already a helper for `<X>`                          | `find_similar(positiveCode: "<draft>")`                                                                          |
| Add `<feature>` in our style, no duplicates                  | `/tea-rags:data-driven-generation`                                                                               |
| Who calls `<X>` before I change it                           | `find_symbol(symbol: "<X>")` → `get_callers`                                                                     |
| What not to touch / where to build a parallel implementation | `rank_chunks(rerank: "criticalPath" \| "blastRadius" \| "godModule", pathPattern)`                               |
| What needs a second reviewer                                 | `rank_chunks(rerank: "criticalPath" \| "criticalMethod", filter: { presets: "panicZone" \| "unstableCore" })`    |
| Which tests cover the behaviour I change                     | `/tea-rags:tests-as-context`                                                                                     |
| Most dangerous modules in `<domain>`                         | `/tea-rags:risk-assessment`                                                                                      |
| Symptom / failure — what is to blame                         | `/tea-rags:bug-hunt`                                                                                             |
| Map the tech debt in `<area>`                                | `rank_chunks(rerank: "techDebt" \| "refactoring" \| "decomposition" \| "godModule" \| "godMethod", pathPattern)` |
| What changed most lately in `<area>`                         | `rank_chunks(rerank: "hotspots", pathPattern, maxAgeDays: <N>)`                                                  |
| What is dead or abandoned                                    | `semantic_search(query: "<area>", filter: { presets: "deadCandidates" \| "abandonedHotspots" })`                 |
| Who owns `<area>`, where is the bus factor one               | `rank_chunks(rerank: "ownership", pathPattern)` · `filter: { presets: "fragileSilo" }`                           |
| Old security-critical code overdue for audit                 | `semantic_search(query, rerank: "securityAudit", filter: { presets: "securityPaths" })`                          |
| What in this MR to look at first                             | `/tea-rags:mr-review`                                                                                            |
| Do the names in my diff fit                                  | `review_changes(changes: {} uncommitted \| { base } branch, sections: ["naming"])`                               |

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

- **Text search for behaviour / intent discovery** — use tea-rags
- **Bash shell over code** (`cat` / `sed -n` / `head` / `grep` /
  `git show <rev>:<file>`) to locate or understand code — alone or inside a
  compound (`cat a.rb; sed -n 90,130p a.rb; grep …`) — same downgrade as the
  default code read tool reading code; harness "use Bash" note does not
  override. Definition → find_symbol; file → find_symbol(relativePath:);
  exact-name occurrences → the default code search tool, bounded, its hits read
  by find_symbol
- **Leaving tea-rags because index lags / drifted / overlay cold** — guide
  `freshness` "Lag never licenses leaving tea-rags"
- **Read file to verify search results** — chunk is the source of truth
- **Read file after find_symbol** — find_symbol returns full definition (method)
  or addressable outline (class / doc)
- **Grep / Read a saved find_symbol dump or an outline** — lines are ids; drill
  `find_symbol(symbol: <id>)` instead
- **One `find_symbol` call per id** — 2+ known ids (outline members, hits) → ONE
  `find_symbol(symbols: [<ids>])`; misses come back in `missing[]`
- **`ls` / glob / `find` to list a directory** —
  `find_symbol(relativePath: "<dir>")` returns its files with their top-level
  symbols
- **Empty answer read as "absent"** — act on `empty.reason` (guide `pagination`
  "Empty answers") before concluding anything
- **Conclusions from one `#partN` chunk** — fetch the whole symbol first
  (`find_symbol(symbol: parentSymbolId)`); parts of one symbol count as ONE hit
- **Multiple semantic_search for same area** — one call, navigate from results
- **Unfiltered semantic_search for cross-layer** — dominant language takes 100%
  of slots. Always use language filter (see `rules/references/polyglot-rule.md`)
- **Unbounded occurrence search** — content output with no files-with-matches
  mode or line cap, or the repo root when an anchor's dir is known; files first
  in the anchor's dir (else the source root), then find_symbol on the hits
- **Default code read tool after a default code search tool hit** — the hit is
  an address: find_symbol outline → batch of only the needed methods
- **semantic_search / hybrid_search for "find all usages"** — exact-name
  occurrences → the default code search tool (literal); the index ranks, it does
  not enumerate every occurrence
- **Text search for symbol existence checks** — use find_symbol with
  metaOnly=true
- **Text search to read or understand code** — its hits are addresses; read them
  with find_symbol, never Read/cat
- **Text-search fallback justified by a stale prime digest** — digest is a
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
- **hybrid_search / search_code for TODO/FIXME/HACK markers** — use text search
  (the default code search tool); no tea-rags tool serves literal markers
- **git log/blame/`-S`/show for code history** ("when did X appear", "посмотри
  через git") — overlay already has git signals:
  `semantic_search(query: <X>, rerank: "bugHunt")` (ageDays, commitCount,
  taskIds)
- **Curiosity search** — file or id already known → find_symbol, never another
  search
- **Read for "whole file" / "весь файл" / "for context"** — find_symbol (the
  hit's symbolId, then file outline); `Read` only on an explicit manual-read
  order ("by hand" / "руками" / "вручную" / "with Read"), no confirmation asked
- **10+ text-search calls instead of reading a file** — just read it
- **search_code directly** — ONLY used through /tea-rags:explore skill for
  user-facing exploration. Agents and subagents NEVER call search_code directly

## Fallback Chains

| Task                          | Primary                           | Fallback                                          |
| ----------------------------- | --------------------------------- | ------------------------------------------------- |
| Symbol definition             | find_symbol(symbol:)              | hybrid_search → text search                       |
| File structure                | find_symbol(relativePath:)        | Read (whole file)                                 |
| Directory contents            | find_symbol(relativePath: <dir>)  | `empty.reason` unknownPath → a `suggestions` path |
| Doc TOC                       | find_symbol(relativePath:)        | find_symbol(symbol: parentSymbolId)               |
| All usages                    | hybrid_search + offset pagination | text search (only if hybrid unavailable)          |
| Behavioral discovery          | semantic_search                   | hybrid_search                                     |
| Cross-layer                   | semantic_search × per language    | same                                              |
| Exact text                    | text search                       | —                                                 |
| Call path A→B (codegraph on)  | trace_path                        | get_callees breadth-first (manual)                |
| Call path A→B (codegraph off) | semantic_search / hybrid + manual | — (graph tools unavailable; see Graph navigation) |
| Naming vocabulary / verdict   | get_naming_lexicon                | codegraph off: DDG Step 5 Naming concept recipe   |
| Naming review of a diff       | review_changes `naming`           | codegraph off: not assessed (no substitute)       |

## pathPattern Rules

Universal formatting constraint (picomatch, exact match on project-relative
`relativePath`). For pathPattern recipes (negation, dominant-domain exclusion) —
invoke `/tea-rags:filter-building`.

- GOOD: `src/auth/**` (a path the user names from the project root — use it
  as-is, no `**/` prefix)
- GOOD: `**/enrichment/**` (a directory NAME whose depth is unknown)
- GOOD: `{app/services/foo.rb,app/models/bar.rb}` (exact relativePaths from
  results)
- GOOD: `**/{file1.rb,file2.rb}` (bare file names, any directory)
- GOOD: `!**/test/**` (picomatch negation — exclude a directory subtree)
- BAD: `{file1.rb,file2.rb}`, `services/**` for a bare name (no `**/` → root
  only; fine when the user named that root-relative path)
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
