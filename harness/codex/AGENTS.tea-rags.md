# tea-rags core

**Addressing.** Every read call (search, `find_symbol`, graph, review, lexicon):
`project=<alias>` (which index) + `path=<your working directory>` (which tree).
Alias: prime `## Project`, SubagentStart alias, or `workingTree.project`;
unknown → `path` alone, then the answer's alias. No working dir (script, CLI) →
`project` alone. Only raw collection name → `collection=<name>` (+ `path` if
your repo). `index_codebase`: `project` ONLY — its `path` registers a NEW
project.

**Routing** (first match wins; a loaded skill's step overrides; tools =
`mcp__tea-rags__<name>`):

| Need                               | Call                                          |
| ---------------------------------- | --------------------------------------------- |
| one file: outline / doc TOC        | `find_symbol(relativePath:)`                  |
| known symbol: body / class outline | `find_symbol(symbol:)` (`Class#inst`, `C.st`) |
| usages of an identifier            | `hybrid_search` (`metaOnly`, `offset`)        |
| behaviour / intent, no name        | `semantic_search`                             |
| code like a chunk in hand          | `find_similar(positiveIds:)`                  |
| impact / who calls / A reaches B   | `get_callers` / `get_callees` / `trace_path`  |
| diff review                        | `review_changes`                              |
| literal text (TODO, phrase, regex) | text search (your client's Grep / `rg`)       |

Text search = literal text only; never it, Glob or `cat`/`sed`/`grep` to locate
or read code — identifiers (even `a|b`) are SYMBOL searches.

**Invariants.**

- Never `Read` after `find_symbol` — method = full body; class / file / doc =
  outline of ids → drill `find_symbol(symbol: <id>)`. After a search:
  `find_symbol` next, not re-search / `Read`.
- `symbolId` ends `#partN` → fragment: `find_symbol(symbol: parentSymbolId)`
  first; parts = one hit.
- Lag ≠ unusable: `changedFiles`, `pendingFiles`, `floors: []`, drift never
  license leaving tea-rags — ticket-named files too. Row without `treeState` =
  current; `treeState` row = pre-edit copy (signals hold, text stale) →
  `find_symbol`.
- Own checkout (tree = alias's path), `changedFiles` > 0, stale banner or
  unindexed edits → incremental `index_codebase(project=)` first, no consent,
  plans too; drift `--force*` `Run:` → ask too, never instead. Linked worktree →
  overlay, never reindex.
- Empty `get_callers` at low resolve rate ≠ no callers — cross-check
  `hybrid_search`. Graph tools absent = codegraph off; never claim "no cycles".
- Docs = hypothesis; verify in code.
- User-named action ("read `x.ts`") → do it; user's weaker method (git log, skip
  enrichment) → keep the rule's, say why.

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
- graph / AST on a non-primary language → `language-capability`
- no prime digest → `tea-rags://project/<alias>/digest`
- thresholds / labelMap → `tea-rags://project/<alias>/metrics?language=<lang>`

**Destructive — explicit user consent:** `force_reindex`, `clear_index`,
`delete_collection`, `delete_documents`, reindex with `--force` /
`--force-enrichments`. Subagent: never reindex — report to parent.

**Skills are not loaded for you.** A task a skill covers (`$name` /
`$dino-<name>`) → open its `SKILL.md` in this turn, BEFORE planning ("I would
read the skill" is not reading it), then every reference file or `tea-rags://`
resource it marks MANDATORY for your case. A skill that hands off to another
skill (a `$dino-*` wrapper → `$bug-hunt`, `$explore`, `$data-driven-generation`
…) → open that `SKILL.md` too. Plan from that text, not from this core.
