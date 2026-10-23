---
name: tea-rags-core
description:
  "tea-rags core rules: code search, navigation and project data through the
  tea-rags MCP tools and resources. Load before any code search, navigation or
  code change in an indexed repository."
---

# tea-rags core

**Addressing.** Every read call (search, `find_symbol`, graph tools,
`review_changes`, `get_naming_lexicon`): `project=<alias>` (which index) +
`path=<your working directory>` (which tree). Alias: prime `## Project`,
SubagentStart alias line, or `workingTree.project` of any answer; unknown →
`path` alone, then pass the answer's alias. Only a raw collection name →
`collection=<name>` (+ `path` if it is your repo). `index_codebase`: `project`
ONLY — its `path` registers a NEW project.

**Routing** (first match wins; tea-rags tools are `mcp__tea-rags__<name>`):

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

Text search finds literal text only — never use it, Glob or Bash
`cat`/`sed`/`grep` to locate or understand code (unless the user explicitly asks
for a manual read). Identifiers are SYMBOL searches even with `|` — never text
search.

**Invariants.**

- Never `Read` after `find_symbol` — method = full body; class / file / doc =
  outline of ids → drill `find_symbol(symbol: <id>)`. After any search the next
  call is `find_symbol`, not another search, not `Read`.
- `symbolId` ends `#partN` → fragment: `find_symbol(symbol: parentSymbolId)`
  before judging it; parts of one symbol = one hit.
- Lag ≠ unusable: `changedFiles`, `pendingFiles`, `floors: []`, drift never
  license leaving tea-rags. Row without `treeState` = current; `treeState` row →
  `find_symbol`.
- Own checkout (your tree = the alias's registered path) with `changedFiles` >
  0, a stale banner or unindexed edits → incremental `index_codebase(project=)`
  now, no consent; a drift `Run:` with `--force*` → ask, keep working. Linked
  worktree → overlay, never reindex.
- Empty `get_callers` under low resolve rate (prime) ≠ no callers — cross-check
  `hybrid_search`. Graph tools absent = codegraph off; never claim "no cycles".
- Docs = hypothesis, code = evidence: verify a doc claim in code first.

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

**Skills are not loaded for you.** A task a skill covers (`$name` /
`$dino-<name>`) → open its `SKILL.md` BEFORE planning, then every reference file
or `tea-rags://` resource it marks MANDATORY for your case; plan from that text,
not from this core.
