# tea-rags core

**Addressing.** Every read call (search, `find_symbol`, graph tools,
`review_changes`, `get_naming_lexicon`): `project=<alias>` (which index) +
`path=<your working directory>` (which tree). Alias: prime `## Project`,
SubagentStart alias line, or `workingTree.project` of any answer; unknown →
`path` alone, then pass the answer's alias. Only a raw collection name →
`collection=<name>` (+ `path` if it is your repo). `index_codebase`: `project`
ONLY — its `path` registers a NEW project.

**Routing** (first match wins; a loaded skill's step overrides; tea-rags tools
are `mcp__tea-rags__<name>`):

| Need                               | Call                                          |
| ---------------------------------- | --------------------------------------------- |
| one file: outline / doc TOC        | `find_symbol(relativePath:)`                  |
| known symbol: body / class outline | `find_symbol(symbol:)` (`Class#inst`, `C.st`) |
| usages of an identifier            | `hybrid_search` (`metaOnly`, `offset`)        |
| behaviour / intent, no name        | `semantic_search`                             |
| code like a chunk in hand          | `find_similar(positiveIds:)`                  |
| impact / who calls / chain A→B     | `get_callers` / `get_callees` / `trace_path`  |
| diff review                        | `review_changes`                              |
| literal text (TODO, phrase, regex) | text search (your client's Grep / `rg`)       |

Text search = literal text only; never it, Glob or `cat`/`sed`/`grep` to locate
or understand code — identifiers (even `a|b`) are SYMBOL searches.

**Invariants.**

- Never `Read` after `find_symbol` — method = full body; class / file / doc =
  outline of ids → drill `find_symbol(symbol: <id>)`. After a search:
  `find_symbol` next, not a re-search or `Read`.
- `symbolId` ends `#partN` → fragment: `find_symbol(symbol: parentSymbolId)`
  first; parts of one symbol = one hit.
- Lag ≠ unusable: `changedFiles`, `pendingFiles`, `floors: []`, drift never
  license leaving tea-rags. Row without `treeState` = current; `treeState` row →
  `find_symbol`.
- Own checkout (your tree = the alias's registered path) with `changedFiles` >
  0, a stale banner or unindexed edits → incremental `index_codebase(project=)`
  now, no consent; a drift `Run:` with `--force*` → ask, keep working. Linked
  worktree → overlay, never reindex.
- Empty `get_callers` under low resolve rate ≠ no callers — cross-check
  `hybrid_search`. Graph tools absent = codegraph off; never claim "no cycles".
- Docs = hypothesis, code = evidence — verify in code.
- User-named action ("read `x.ts`") → do it; user-suggested weaker method (git
  log, skip enrichment) → keep the rule's, say why.

**Read `tea-rags://guide/<topic>` when** (no resource tool →
`tea-rags resource <uri>`):

- after any search, before answering → `navigation`; 0 hits, too many, ambiguous
  name, when to stop → `pagination`
- picking a tool or skill, prohibited patterns, fallbacks → `decision-tree`
- stale banner, drift, `treeState`, `degraded`, edited files, linked worktree →
  `freshness`
- embedding / qdrant error, `denseUnavailable` → `degraded`
- before a raw `filter:` → `filters`
- before choosing `rerank` → `presets` + `signals`; reading labels →
  `signal-labels`
- trusting graph / AST on a non-primary language → `language-capability`
- no prime digest in context → `tea-rags://project/<alias>/digest`
- thresholds / labelMap → `tea-rags://project/<alias>/metrics?language=<lang>`

**Destructive tools need explicit user consent:** `force_reindex`,
`clear_index`, `delete_collection`, `delete_documents`, reindex with `--force` /
`--force-enrichments`. Subagent: never reindex — report to the parent.
