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
in ranges (`sed -n`).

**Every code read and meaning search goes through tea-rags.**

**Addressing.** Every read call, each next/planned call you write included
(`find_symbol(symbol: X, path=<cwd>)`): `project=<alias>` +
`path=<this task's cwd>` (tree, re-checks too). Alias: digest `project`,
SubagentStart line or `workingTree.project`; unknown/"not registered" → `path`
alone, never ask; only a `collection` → it alone; after either say
`next: project=<workingTree.project> + path`. No cwd → call now, `project`
alone. `workingTree.tree` ≠ cwd → rows unusable; re-call `path=<cwd>`.
`index_codebase`: `project` ONLY; unregistered cwd → `path=<cwd>`.

Indexed code is never READ with shell sed -n '<start>,<end>p' <one file>, shell
`cat`/`sed`/`head` (even in `a; b`) or search-tool match lines. Shell rg -l only
LOCATES exact text — `-l` first or a line cap, in the anchor's dir when known,
else the source root, never the repo root or a search for the dir. No find/Glob
to locate code. Shell / shell sed -n '<start>,<end>p' <one file> only for files
outside the index (`*.json`, locale/data `*.yml`) — say so.

**Routing** (first match wins; a loaded skill's steps run first, override rows —
a file path in them → row 1; tools `mcp__tea-rags__*`):

- file/dir path, lines N–M, doc TOC, how `<dir>` works →
  `find_symbol(relativePath:)` outline first, then ONE batch of the needed ids
  (N–M: ids spanning it); "how does `<dir>` work" / "what's in `<dir>`", no
  structure word (architecture, structure, organized, end to end, backbone, walk
  me through) → that outline → ONE `find_symbol(symbols:[<Class#method ids>])`,
  never codegraph row 4 / `get_architecture_report`; its imports →
  `get_callees(relativePath:)` (`imports[]`; a row's `imports` = a count);
  manual-read order → Invariants
- code history — when X appeared/changed, "посмотри через git" → never
  `git log`/`blame`/`-S`/`show`:
  `semantic_search(query: <X>, rerank: "bugHunt")`
- behaviour/intent: no name, or concept words/synonyms/spellings (even as `a|b`)
  → ONE `semantic_search(query: "a ||| b ||| c")` (≤5 phrasings fused; real ids
  among them → `hybrid_search(metaOnly)`) → anchor → depth-2 callees/callers →
  ONE batch; never text search
- non-identifier text — regex syntax, TODO/FIXME, phrase, string to find (debug,
  or a search tool demanded on an error → bug-hunt), even "every …" → shell rg
  -l, not tea-rags; phrase/error string → plan these three lines, never stop at
  the hit: `shell rg -l "<phrase>" <dir> (literal, line cap)` →
  `find_symbol(relativePath: <hit file>)` outline →
  `find_symbol(symbol: <enclosing symbolId>)` body. DSL `ns:task` = symbol; code
  name, even a "pattern"/"glob" → usages row. Command output, failing tests,
  counts → `<cmd> 2>&1 | grep -E 'FAIL|✗'` (`| wc -l`), no skill
- how X works/what happens when → `get_callees`; who calls X/impact/where Y is
  handled → `get_callers` — `symbolId:`, `depth: 2`; every call/all callers of X
  (grep named) → plan both lines: `get_callers` + the usages row. Then ONE
  batch: needed tree methods
- known symbol / identifier definition/body/outline → `find_symbol(symbol:)`
  `Class#inst`/`C.st`, never text search
- where X is used/referenced, every occurrence, who constructs X, files
  containing X (exact name/constant/string you know; `a|b` only of seen ids),
  "grep for X" → shell rg -l `"<X>" <src dir>` (literal, `-l`) → `find_symbol`
  outline → batch of only the needed methods, never stop at the hit
- symbol + intent ("the X that does Y"), files named X →
  `hybrid_search(metaOnly)`
- code like a chunk in hand → `find_similar(positiveIds:)`
- how does X reach Y / A→B → `find_symbol` ids → `trace_path`
- diff review, a diff's names →
  `review_changes(changes:{base}, sections:[the asked ones])` — `{}` =
  uncommitted, `{base}` = branch
- project's embedding/Qdrant/env → `list_projects(project:)`
- research — layers/wrong-way deps of `<dir>` →
  `get_architecture_report(pathPattern)`; implements `<P>` → `get_callers` +
  `hybrid_search(<P>, metaOnly)`; registered/configured `<X>` →
  `hybrid_search("<X> register config")`; ticket `<T>` →
  `semantic_search(taskId:)`; owners/recent churn/debt/don't-touch →
  `rank_chunks(rerank: ownership|hotspots|techDebt|criticalPath, pathPattern)`;
  dead code → `filter:{presets:"deadCandidates"}`; which to copy →
  `rerank: "proven"`

A name's fit → lexicon `names:[{name,kind}]`, naming a T value → `types:[T]`; a
diff's → `review_changes` verdicts, nothing after.

**Invariants.**

- NEVER call for what you have (row, body, outline, edge in context) → use it;
  never re-query/re-read/re-verify, not "to be sure", not on follow-up. New
  search only for unseen code.
- After `find_symbol`: method = full body; small file (`kind: "file"`) = full
  text, nothing after; outline → drill. Read the `Class#method` ids an answer
  NAMED (rows, outline, graph edges) in ONE `find_symbol(symbols: [<ids>])` —
  never file/dir paths. After a search: `find_symbol` next.
- Anchor = the row whose symbol/path names the task's field or behaviour — any
  row, not row 1, nor the first anchor you drilled; a later answer's row naming
  it better → new anchor. Which files change / every place → in order, before
  any new search: `1. find_symbol(symbol: <anchor id>)`
  `2. get_callers/get_callees(symbolId: <anchor id>)`, `find_co_changed`. Before
  answering: every row that named the behaviour is in the answer, or why it's a
  false lead.
- `symbolId` ends `#partN` = fragment →
  `find_symbol(symbol: <id minus #partN>)`; parts = one hit.
- `truncated` → next call = `truncated.next` verbatim, or narrowed
  (`detectors`/`limit`/`evidenceLimit`/`pathPattern`); never the same call.
- `empty.reason: unknownPath` →
  `find_symbol(relativePath: <dir its suggestions share>)`, never one
  suggestion.
- No `treeState` row, no `degraded` → index IS current code (overlay serves
  uncommitted edits; no `workingTree` on project+path = current): trust it. Lag
  (`changedFiles`>0, `pendingFiles`, drift) → stay in tea-rags. `treeState` row
  = pre-edit copy (say why, e.g. `denseUnavailable`): dependents' fanIn/churn
  valid, not proof of the edit → `find_symbol`; `pendingFiles` > 0 (a count; may
  be yours) → plan both lines: `find_symbol(<same params>)` and
  `still in pendingFiles → find_symbol(<same params>) again`.
- Freshness: (1) subagent → keep reading; no `index_codebase`/ ask the user;
  drift/`--force`/remedy → parent report. Main: (2) cwd in `.claude/worktrees/`
  or ≠ alias's path → print `linked worktree (<test>) — no reindex`; own
  checkout behind (`changedFiles`>0, stale, unindexed edits, said so) →
  incremental `index_codebase(project=)` first, no consent. (3) Drift `Run:`
  `--force*` (status/prime/index only, not a read answer) → subagent: (1); main:
  (2)'s incremental first if behind, plus ONE line ask the user: run <Run:
  line>? — --force not run; reads continue meanwhile`, never awaited, never
  "won't proceed"; next = the task's read call.
- Empty `get_callers` ≠ no callers (jobs, DSL, config) → usages row. Edges at
  changed files, `treeGraphUnavailable` → all 3 steps, in order, none dropped (a
  `--force` ask rides beside, never a slot): `1. index_codebase(project=)` (main
  own checkout; linked/subagent → skip) `2. find_symbol(symbol: <caller>)`
  `3. shell rg -l "<name>" (literal)` — callers the index lacks. No graph retry.
  Graph tools absent from your tool list → codegraph off: callers = usages row,
  never "no cycles"; present → on, no probe call; on + empty `find_cycles` =
  DAG.
- Docs = hypothesis, verify in code; doc as subject ("README says?") → as-is, no
  code pass.
- `rustc driver: unavailable` (status/index/empty Rust graph answer) → tell user
  ONCE: Rust edges static-only (lower bound) + install command; never install it
  or claim "no callers"/"dead code".
- User orders a manual read — "by hand"/"руками"/"вручную"/"with Read":
  unindexed file → shell sed -n '<start>,<end>p' <one file>, no confirm ask;
  indexed → tell user the plugin hook blocks it, read it via `find_symbol` now,
  never `cat`/`sed`. "Whole file"/"весь файл"/"целиком"/"for context"/"lines
  N–M" without that order → `find_symbol` (hit's `symbolId`, then file outline),
  print `Chunk coordinates exist. Use them.`, no file read. Their plan or tool
  idea ("use Grep/Glob") → keep the rule's tool, say why.

**Read `tea-rags://guide/<topic>` when** (no resource tool →
`tea-rags resource <uri>`): after any search → `navigation`; 0/too many hits,
`truncated`, `empty.reason`, ambiguous name, when to stop → `pagination`; skill
pick, fallbacks, research questions → `decision-tree`; stale banner, drift,
`treeState`, linked worktree → `freshness`; embedding/qdrant error,
`denseUnavailable` → `degraded`; raw `filter:` → `filters`; `rerank`, labels →
`presets`, `signals`, `signal-labels`; graph/AST, other language →
`language-capability`; architecture / `review_changes` answer →
`architecture`/`review`; no prime digest → `tea-rags://project/<alias>/digest`;
numeric filter value unknown / bare raw number, no label →
`…/metrics?language=<lang>&section=thresholds`.

**Destructive — explicit consent:** `force_reindex`, `clear_index`, `delete_*`.

**Skills are not loaded for you** — except this core: `$tea-rags-core` IS this
text, never open its `SKILL.md`. A task a skill covers (`$name` /
`$dino-<name>`) → open its `SKILL.md` in this turn, BEFORE planning ("I would
read the skill" is not reading it), then every reference file or `tea-rags://`
resource it marks MANDATORY for your case. A skill that hands off to another
skill (a `$dino-*` wrapper → `$bug-hunt`, `$explore`, `$data-driven-generation`
…) → open that `SKILL.md` too. Plan from that text, not from this core.
`repair/<family>.md`, `rules/…` in any skill or reference = the plugin root (the
folder holding `skills/`), never the skill's own folder. Every skill you name in
a plan → open its `SKILL.md` with its own command first; a plan from memory is
not reading it. A skill path you did not open with a command in this turn is
invalid in a plan — open it first.

**Lag follow-ups.** Incremental `index_codebase` is a prelude, not the answer:
the next step still serves the user's request (search / `$explore` over the code
they asked about). Graph answer with `changedFiles` > 0 and no `codegraph` floor
→ edges touching changed files are the index's: re-check changed-file callers
via `find_symbol`, find missing ones via shell rg -l (literal) — never a bare
retry of the graph call.
