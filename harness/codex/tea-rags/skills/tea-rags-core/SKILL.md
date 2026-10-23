---
name: tea-rags-core
description:
  "tea-rags core rules: code search, navigation and project data through the
  tea-rags MCP tools and resources. Load before any code search, navigation or
  code change in an indexed repository."
---

# tea-rags core

**Read ONE file per command**, any tool alike (`cat`, `sed`, `python3`, a loop):
output past ~10k tokens loses its middle (`…N tokens truncated…`), and a rule
you did not see is not a rule you may guess. Saw that marker → re-read the file
in ranges (`sed -n`). Every skill you name in a plan → open its `SKILL.md` with
its own command first; a plan from memory is not reading it. A skill path you
did not open with a command in this turn is invalid in a plan — open it first.

**Plan-only / describe-the-plan answers: every skill output contract applies
NOW.** Decide from the facts given (strategy, verdict, name, class); print every
literal line and every template IN FULL — table headings + header rows, not a
schema line or prose; data not gathered yet → `[planned; not run]` in each cell,
never "I would report it later". A skill's "ask the user" fires in this answer.
Describing compliance is not compliance.

**Addressing.** Every read call (search, symbol, graph, review, lexicon):
`project=<alias>` (which index) + `path=<your working directory>` (which tree).
Alias: prime `## Project`, SubagentStart line or `workingTree.project`; unknown
→ `path` alone. No working dir → `project` alone. Raw collection name →
`collection=` (+ `path` if your repo). `index_codebase`: `project` ONLY (`path`
= NEW project).

**Routing** (first match wins; a loaded skill's step overrides; tools =
`mcp__tea-rags__*`):

| Need                       | Call                                           |
| -------------------------- | ---------------------------------------------- |
| file: outline / doc TOC    | `find_symbol(relativePath:)`                   |
| known symbol: body/outline | `find_symbol(symbol:)` (`Class#inst`, `C.st`)  |
| usages of an identifier    | `hybrid_search` (`metaOnly`, `offset`)         |
| behaviour/intent, no name  | `semantic_search` only (no `hybrid_search`)    |
| code like a chunk in hand  | `find_similar(positiveIds:)`                   |
| who calls X / impact       | `find_symbol` id → `get_callers`/`get_callees` |
| how does X reach Y / A→B   | `find_symbol` ids → `trace_path`               |
| diff review; a name's fit  | `review_changes` / `get_naming_lexicon`        |
| literal: TODO/phrase/regex | text search (your client's Grep / `rg`)        |

Text search = literal text only; never it, Glob or `cat`/`sed`/`grep` to locate
or read code — identifiers (even `a|b`) are SYMBOL searches. A name →
`names:[{name,kind}]`; a diff's → `review_changes` verdicts, nothing after.

**Invariants.**

- Never `Read` after `find_symbol` — method = full body; class / file / doc =
  outline of ids → drill `find_symbol(symbol: <id>)`. After a search:
  `find_symbol` next, not re-search/`Read`.
- `symbolId` ends `#partN` = fragment → `find_symbol(symbol: parentSymbolId)`;
  parts = one hit.
- Lag ≠ unusable: `changedFiles`, `pendingFiles`, `floors: []`, drift never
  license leaving tea-rags — ticket-named files too. No `treeState` = current;
  `treeState` row = pre-edit copy (signals hold, text stale) → `find_symbol`.
- Subagent: never reindex (any kind) or ask the user — report to parent.
  Otherwise own checkout (tree = alias's path), `changedFiles` > 0, stale banner
  or unindexed edits → incremental `index_codebase(project=)` first, no consent,
  plans too; drift `--force*` `Run:` → ask, never instead. Linked worktree →
  overlay only.
- Empty `get_callers` at low resolve ≠ no callers → `hybrid_search`; edges at
  changed files → `find_symbol` its caller, then `hybrid_search(metaOnly)`, no
  graph retry. Graph tools absent = codegraph off → never claim "no cycles";
  on + empty `find_cycles` = DAG.
- Docs = hypothesis; verify in code.
- User-named action ("read `x.ts`") → do it; user's weaker method → keep the
  rule's, say why.

**Read `tea-rags://guide/<topic>` when** (no resource tool →
`tea-rags resource <uri>`):

- after any search, before answering → `navigation`; 0 hits, too many, ambiguous
  name, when to stop → `pagination`
- picking a skill, prohibited patterns, fallbacks → `decision-tree`
- stale banner, drift, `treeState`, `degraded`, edited files, linked worktree →
  `freshness`
- embedding / qdrant error, `denseUnavailable` → `degraded`
- before a raw `filter:` → `filters`
- before choosing `rerank` → `presets` + `signals`; reading labels →
  `signal-labels`
- graph / AST on a non-primary language → `language-capability`
- no prime digest / labelMap → `tea-rags://project/<alias>/digest` / `…/metrics`

**Destructive — explicit user consent:** `force_reindex`, `clear_index`,
`delete_*`, `--force*` reindex.

**Skills are not loaded for you.** A task a skill covers (`$name` /
`$dino-<name>`) → open its `SKILL.md` in this turn, BEFORE planning ("I would
read the skill" is not reading it), then every reference file or `tea-rags://`
resource it marks MANDATORY for your case. A skill that hands off to another
skill (a `$dino-*` wrapper → `$bug-hunt`, `$explore`, `$data-driven-generation`
…) → open that `SKILL.md` too. Plan from that text, not from this core.
`repair/<family>.md`, `rules/…` in any skill or reference = the plugin root (the
folder holding `skills/`), never the skill's own folder.

**Lag follow-ups.** Incremental `index_codebase` is a prelude, not the answer:
the next step still serves the user's request (search / `$explore` over the code
they asked about). Graph answer with `changedFiles` > 0 and no `codegraph` floor
→ edges touching changed files are the index's: re-check changed-file callers
via `find_symbol`, find missing ones via `hybrid_search` metaOnly — never a bare
retry of the graph call.
