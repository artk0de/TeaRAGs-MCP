# tea-rags core

**Read ONE file per command**, any tool alike (`cat`, `sed`, `python3`, a loop):
output past ~10k tokens loses its middle (`…N tokens truncated…`), and a rule
you did not see is not a rule you may guess. Saw that marker → re-read the file
in ranges (`sed -n`). Every skill you name in a plan → open its `SKILL.md` with
its own command first; a plan from memory is not reading it. A skill path you
did not open with a command in this turn is invalid in a plan — open it first.

**Plan-only / describe-the-plan answers: every skill output contract applies
NOW.** Print every literal line and every template IN FULL (table headings +
header rows, never a schema line). `[planned; not run]` only for tool results
not gathered yet; a value derivable from the prompt (pathPattern, a repaired
finding's counts) is written out. A skill's "ask the user" fires in this answer.
Describing compliance is not compliance.

**Addressing.** Every read call: `project=<alias>` (which index) +
`path=<your working directory>` (which tree, re-checks too). Alias: prime
`## Project`, SubagentStart line or `workingTree.project`; unknown / "not
registered" → `path` alone, never ask; only a `collection` → it alone, then say
`next: project=<workingTree.project> + path`. No working dir → `project` alone.
`workingTree.tree` ≠ your dir → re-call `path=<your dir>`. `index_codebase`:
`project` ONLY; unregistered cwd → `path=<cwd>`.

**Routing** (first match wins; a loaded skill's steps run first, override rows —
a file path in them → row 1; tools `mcp__tea-rags__*`):

- file path / doc TOC → `find_symbol(relativePath:)`
- known symbol body/outline → `find_symbol(symbol:)` `Class#inst`/`C.st`
- every/all callers of X → `get_callers` + `hybrid_search(metaOnly)`
- usages; who constructs X; files named X → `hybrid_search(metaOnly)`
- behaviour/intent, no name → `semantic_search` only, no `hybrid_search`
- code like a chunk in hand → `find_similar(positiveIds:)`
- who calls X / impact → `find_symbol` → `get_callers`/`get_callees`
- how does X reach Y / A→B → `find_symbol` ids → `trace_path`
- diff review; a name's fit → `review_changes` / `get_naming_lexicon`
- literal TODO/phrase/regex → `rg`/Grep, never tea-rags; command output →
  `<cmd> 2>&1 | grep -E '…'`

Never Grep/`rg`/`rg --files`, Glob or `cat`/`sed` to locate or read code —
identifiers (even `a|b`) are SYMBOL searches. A name → `names:[{name,kind}]`; a
diff's → `review_changes` verdicts, nothing after.

**Invariants.**

- Never `Read` after `find_symbol` — method = full body; class/file/doc =
  outline of ids → drill `find_symbol(symbol: <id>)`. After a search:
  `find_symbol` next, not re-search/`Read`.
- `symbolId` ends `#partN` = fragment → `find_symbol(symbol: parentSymbolId)`;
  parts = one hit.
- Lag (`changedFiles`, `pendingFiles`, `floors: []`, drift) → stay in tea-rags.
  No `treeState` = current; `treeState` row = pre-edit copy (say why, e.g.
  `denseUnavailable`): dependents' fanIn/churn valid, not proof of the edit →
  `find_symbol`; in `pendingFiles` → re-call it.
- Freshness: (1) subagent → keep reading; no `index_codebase`/ ask the user;
  drift, `--force`, remedy → parent report. Main: (2) cwd in
  `.claude/worktrees/` or ≠ alias's path → print
  `linked worktree (<test>) — no reindex`; own checkout behind (`changedFiles` >
  0, stale, unindexed edits, said so) → incremental `index_codebase(project=)`
  first, no consent. (3) Drift `Run:` `--force*` → own ask the user: run <Run:
  line>?`, never awaited; print `--force not run; reads continue`, next = a
  read.
- Empty `get_callers` at low resolve ≠ no callers → `hybrid_search`; edges at
  changed files → `find_symbol` its caller + `hybrid_search(metaOnly)`, no graph
  retry; own checkout + `index_codebase`. Codegraph off → never claim "no
  cycles"; on + empty `find_cycles` = DAG.
- Docs = hypothesis; verify in code.
- User-named action ("read `x.ts`") → do it; user's weaker method → keep the
  rule's, say why.

**Read `tea-rags://guide/<topic>` when** (no resource tool →
`tea-rags resource <uri>`): after any search → `navigation`; 0 / too many hits,
ambiguous name, when to stop → `pagination`; skill pick, fallbacks →
`decision-tree`; stale banner, drift, `treeState`, linked worktree →
`freshness`; embedding/qdrant error, `denseUnavailable` → `degraded`; raw
`filter:` → `filters`; `rerank`, labels → `presets`, `signals`, `signal-labels`;
graph/AST, other language → `language-capability`; no prime digest/labelMap →
`tea-rags://project/<alias>/digest` / `…/metrics`.

**Destructive — explicit consent:** `force_reindex`, `clear_index`, `delete_*`.

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
