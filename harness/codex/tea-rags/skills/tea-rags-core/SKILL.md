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

**Every code read and meaning search goes through tea-rags.**

**Addressing.** Every read call, each next/planned call you write included
(`find_symbol(symbol: X, path=<cwd>)`): `project=<alias>` (which index) +
`path=<this task's cwd>` (which tree, re-checks too). Alias: prime `## Project`,
SubagentStart line or `workingTree.project`; unknown/"not registered" → `path`
alone, never ask; only a `collection` → it alone; after either say
`next: project=<workingTree.project> + path`. No cwd → call now, `project`
alone. `workingTree.tree` ≠ cwd → rows unusable; re-call `path=<cwd>`.
`index_codebase`: `project` ONLY; unregistered cwd → `path=<cwd>`.

Indexed code is never READ with shell file reads, shell `cat`/`sed`/`head` (even
in `a; b`) or shell grep -rl match lines. The shell grep -rl only LOCATES exact
text — files-with-matches first (`-l`) or a line cap — in the anchor's dir when
known, else the source root — never the repo root or
hybrid_search/semantic_search for a dir; then `find_symbol` reads the needed
methods. No find/Glob to locate code. Shell / shell file reads only for files
outside the index (`*.json`, locale/data `*.yml`) — say so.

**Routing** (first match wins; a loaded skill's steps run first, override rows —
a file path in them → row 1; tools `mcp__tea-rags__*`):

- file/dir path, lines N–M, doc TOC, how `<dir>` works →
  `find_symbol(relativePath:)` outline first, then ONE batch of the needed ids
  (N–M: ids spanning it); its imports → `get_callees(relativePath:)`
  (`imports[]`; a row's `imports` = a count); manual-read order → Invariants
- code history — when X appeared/changed, "посмотри через git" → never
  `git log`/`blame`/`-S`/`show`:
  `semantic_search(query: <X>, rerank: "bugHunt")`
- non-identifier text — regex syntax, TODO/FIXME, phrase, string to find (debug,
  or a search tool demanded on an error → bug-hunt), even "every …" → shell grep
  -rl, never tea-rags; phrase/error string → plan these three lines, never stop
  at the hit: `shell grep -rl "<phrase>" <dir> (literal, line cap)` →
  `find_symbol(relativePath: <hit file>)` outline →
  `find_symbol(symbol: <enclosing symbolId>)` body. DSL `ns:task` = symbol; code
  name, even a "pattern"/"glob" → usages row. Command output, failing tests,
  counts → `<cmd> 2>&1 | grep -E 'FAIL|✗'` (`| wc -l`), no skill
- known symbol body/outline → `find_symbol(symbol:)` `Class#inst`/`C.st`
- every call / all callers of X → `get_callers` AND the usages row's search
- where X is used/referenced, every occurrence, who constructs X, files
  containing X (exact name/constant/string, even `a|b`) → shell grep -rl
  `"<X>" <dir>` (literal, `-l`) → `find_symbol` outline → batch of only the
  needed methods
- symbol + intent ("the X that does Y"), files named X →
  `hybrid_search(metaOnly)`
- behaviour/intent, no name → `semantic_search` only, no `hybrid_search`
- code like a chunk in hand → `find_similar(positiveIds:)`
- how X works / what happens when → `get_callees`; who calls X / impact / where
  Y is handled → `get_callers` — `symbolId:` (id from a row)
- how does X reach Y / A→B → `find_symbol` ids → `trace_path`
- diff review, a diff's names →
  `review_changes(changes:{base}, sections:[the asked ones])` — `{}` =
  uncommitted, `{base}` = branch; one name → `get_naming_lexicon`
- project's embedding/Qdrant/env → `list_projects(project:)`
- research — layout of `<dir>` → `get_architecture_report(pathPattern)`;
  implements `<P>` → `get_callers` + `hybrid_search(<P>, metaOnly)`; registered
  / configured `<X>` → `hybrid_search("<X> register config")`; ticket `<T>` →
  `semantic_search(taskId:)`; owners / recent churn / debt / don't-touch →
  `rank_chunks(rerank: ownership|hotspots|techDebt|criticalPath, pathPattern)`;
  dead code → `filter:{presets:"deadCandidates"}`; which to copy →
  `rerank: "proven"`

An identifier's definition/body/outline = SYMBOL lookup (`find_symbol`), never
text search. A name's fit → lexicon `names:[{name,kind}]`, naming a T value →
`types:[T]`; a diff's → `review_changes` verdicts, nothing after.

**Invariants.**

- NEVER call for what you already have. Before EVERY call: its answer already in
  context (row, body, outline, edge) → use it, NO call. Never re-query, re-read,
  re-verify — not "to be sure", not on a follow-up. New search only for unseen
  code ("Curiosity search" anti-pattern).
- Never shell file reads after `find_symbol` — method = full body; small file
  (`kind: "file"`) = full text, nothing after; outline → drill. Read the
  `Class#method` ids an answer NAMED (rows, outline, graph edges) in ONE
  `find_symbol(symbols: [<ids>])` — never file/dir paths. After a search:
  `find_symbol` next.
- Anchor = the row whose symbol/path names the task's field or behaviour — any
  row, not row 1, nor the first anchor you drilled; a later answer's row naming
  it better → new anchor. Which files change / every place → in order, before
  any new search: `1. find_symbol(symbol: <anchor id>)`
  `2. get_callers/get_callees(symbolId: <anchor id>)`, `find_co_changed`. Before
  answering: every row that named the behaviour is in the answer, or say why it
  is a false lead.
- `symbolId` ends `#partN` = fragment →
  `find_symbol(symbol: <id minus #partN>)`; parts = one hit.
- Answer has `truncated` → next call = `truncated.next` as given, or narrowed
  (`detectors`/`limit`/`evidenceLimit`/`pathPattern`); never the same call.
- `empty.reason: unknownPath` →
  `find_symbol(relativePath: <dir its suggestions share>)`, never one suggested
  file.
- No `treeState` row and no `degraded` → the index IS the current code (overlay
  serves uncommitted edits): trust it, no re-verify. Lag (`changedFiles`>0,
  `pendingFiles`, drift) → stay in tea-rags. `treeState` row = pre-edit copy
  (say why, e.g. `denseUnavailable`): dependents' fanIn/churn valid, not proof
  of the edit → `find_symbol`; `pendingFiles` > 0 (a count; your file may be
  one) → plan both lines: `find_symbol(<same params>)` and
  `still in pendingFiles → find_symbol(<same params>) again`.
- Freshness: (1) subagent → keep reading; no `index_codebase`/ ask the user;
  drift/`--force`/remedy → parent report. Main: (2) cwd in `.claude/worktrees/`
  or ≠ alias's path → print `linked worktree (<test>) — no reindex`; own
  checkout behind (`changedFiles`>0, stale, unindexed edits, said so) →
  incremental `index_codebase(project=)` first, no consent. (3) Drift `Run:`
  `--force*` → subagent: (1); main: (2)'s incremental first if behind, plus ONE
  line ask the user: run <Run: line>? — --force not run; reads continue
  meanwhile`, never awaited, never "won't proceed"; next = the task's read call.
- Empty `get_callers` ≠ no callers (jobs, DSL, config) → the usages row. Edges
  at changed files, `treeGraphUnavailable` (graph not overlaid) → all 3 steps,
  in order, none dropped (a `--force` ask rides beside them, never takes a
  slot): `1. index_codebase(project=)` (main own checkout; linked/subagent →
  skip) `2. find_symbol(symbol: <caller>)`
  `3. shell grep -rl "<name>" (literal)` — callers the index lacks. No graph
  retry. Codegraph off → never claim "no cycles"; on + empty `find_cycles` =
  DAG.
- Docs = hypothesis; verify in code — unless the doc is the subject ("README
  says?") → report as-is, no code pass.
- `rustc driver: unavailable` (prime, status, index) → tell the user ONCE per
  session: Rust edges static-only (lower bound), quote its install command;
  never install it or claim "no callers"/"dead code" from those edges.
- User orders a manual read — "by hand"/"руками"/"вручную"/"with Read" → shell
  file reads, no confirm question. "Whole file"/"весь файл"/"целиком"/"for
  context"/"lines N–M" without that order → `find_symbol` (hit's `symbolId`,
  then file outline), print `Chunk coordinates exist. Use them.`, no file read.
  Their plan or tool idea ("use Grep/Glob") → keep the rule's tool, say why.

**Read `tea-rags://guide/<topic>` when** (no resource tool →
`tea-rags resource <uri>`): after any search → `navigation`; 0/too many hits,
`truncated`, `empty.reason`, ambiguous name, when to stop → `pagination`; skill
pick, fallbacks, research questions → `decision-tree`; stale banner, drift,
`treeState`, linked worktree → `freshness`; embedding/qdrant error,
`denseUnavailable` → `degraded`; raw `filter:` → `filters`; `rerank`, labels →
`presets`, `signals`, `signal-labels`; graph/AST, other language →
`language-capability`; architecture report / `review_changes` answer →
`architecture` / `review`; no prime digest →
`tea-rags://project/<alias>/digest`; numeric filter value not given or bare raw
number, no label → `…/metrics?language=<lang>&section=thresholds`.

**Destructive — explicit consent:** `force_reindex`, `clear_index`, `delete_*`.

**Skills are not loaded for you** — except this core: `$tea-rags-core` IS this
text, never open its `SKILL.md`. A task a skill covers (`$name` /
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
via `find_symbol`, find missing ones via shell grep -rl (literal) — never a bare
retry of the graph call.
