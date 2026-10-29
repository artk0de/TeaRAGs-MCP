# Tool choice — which tool answers this code question

Index of all routing guides: `tea-rags://guide/decision-tree`. Skill or preset
pick → guide `skill-choice`; banned moves, fallbacks → guide
`prohibited-patterns`.

## Principle: Semantic First, Exact Second

Meaning search, reads, graph, analytics → tea-rags (semantic_search,
hybrid_search for symbol + intent, find_symbol, find_similar, get_callers /
get_callees / trace_path, rerank presets). Exact text → your default code search
tool (not a tea-rags tool): occurrences of an identifier / constant / string
("where is X used", "every call of X", "files containing X", a name the user
calls a "pattern", an `a|b` of exact identifiers already seen in an answer),
regex syntax, TODO/FIXME/HACK/NOTE markers, phrases, error strings, import path
strings; also the fallback when tea-rags is unavailable. An identifier's
DEFINITION / body / outline = SYMBOL lookup → find_symbol; only its OCCURRENCES
go to the default code search tool.

**MANDATORY:** ALWAYS prefer tea-rags over text search for meaning and reads.

## Tool Invocation Under Deferred Loading

Recent models load tool **names** only; full schema fetched on demand
(`ToolSearch`) AFTER you pick a tool. Pick EXACT tool from the tree below first,
then fetch only that one — wrong pick costs a wasted fetch. In Claude Code
`find_symbol` and `hybrid_search` are always loaded — call them directly, no
`ToolSearch` first. Every tea-rags tool is **`mcp__tea-rags__<name>`** — e.g.
`mcp__tea-rags__find_symbol`, `mcp__tea-rags__semantic_search`,
`mcp__tea-rags__get_callers` (clients that expose tools as code identifiers
normalize it to `mcp__tea_rags__<name>`, e.g. Codex code mode:
`tools.mcp__tea_rags__<name>` inside `exec`). Names appear bare below — prepend
the prefix when calling.

## Tree

Follow top-to-bottom, first matching branch wins. A task a skill covers → guide
`skill-choice` first (skills handle tool selection internally).

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
│   ├─ Need file structure (methods, classes, outline) / doc TOC
│   │     → find_symbol(relativePath: result.relativePath | "docs/file.md")
│   ├─ Hold outline / TOC, need one member / section / test
│   │     → find_symbol(symbol: <id from that line>) — never Read / grep
│   └─ Need graph navigation (codegraph must be enabled)
│         → guide `navigation` "Graph navigation": get_callers/get_callees (flow /
│           impact → depth: 2, one call) → find_cycles → trace_path (A→B chain)
│
└─ No (need to search)

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
   │     search to find it; never unbounded), then find_symbol outline → batch
   │     of only the needed methods (a hit in config, DSL, a migration or a
   │     spec → the default code read tool); every caller → get_callers AND
   │     that search (call sites the graph misses). Symbol + intent → hybrid_search
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
   └─ Describing behavior / intent (no exact name), or an alternation of
       concept words / synonyms / spellings (`<a>|<b>|<c>`) → semantic_search
       (hybrid_search metaOnly when real identifiers are among the words) →
       anchor → get_callees / get_callers → ONE find_symbol batch of only the
       needed methods — never a text-search alternation
```

Every tool above accepts a rerank preset, find_similar included — its preset
list omits only `documentationRelevance` and `blastRadius`. `rank_chunks`
requires one. Code-only filtering: language filter or pathPattern (guide
`filters` "pathPattern") to exclude non-code files.
