# tea-rags core

**Each step takes the tool its routing row names.**

**Addressing.** Every tea-rags read call, each next/planned call you write
included (`find_symbol(symbol: X, path=<cwd>)`): `project=<alias>` +
`path=<this task's cwd>` (tree, re-checks too). Alias: digest `project`,
SubagentStart line or `workingTree.project`; unknown/"not registered" → `path`
alone, never ask; only a `collection` → it alone; after either say
`next: project=<workingTree.project> + path`. No cwd → call now, `project`
alone. `workingTree.tree` ≠ cwd → rows unusable; re-call `path=<cwd>`.
`index_codebase`: `project` ONLY; unregistered cwd → `path=<cwd>`.

Grep tool: `-l` first or a line cap, in the anchor's dir when known, else the
source root (`<src dir>`: a dir under cwd, never cwd itself), never a search for
the dir. No find/Glob to locate code.

**Routing** (first match wins; a loaded skill's steps run first, override rows —
a file path in them → row 1; tools `mcp__tea-rags__*`):

- config/DSL/routes/migrations/specs, an unindexed file, a `find_symbol` stub →
  Read tool (path unknown → Grep tool first); all X in a known `<dir>`, proving
  absence ("no X exists") → Grep tool over that dir (empty = proof);
  table/column exists, `create_table` → that search over `db/` (schema, then
  migrations; `:<table>` and `"<table>"` before "absent"), never
  `semantic_search`. Other file/dir path, lines N–M, doc TOC, how `<dir>` works
  / what's in it → `find_symbol(relativePath:)` outline first, then ONE batch of
  the needed ids (N–M: ids spanning it); no structure word (architecture,
  structure, organized, end to end, backbone, walk me through) → never codegraph
  / `get_architecture_report`; its imports → `get_callees(relativePath:)`
  (`imports[]`; a row's `imports` = a count)
- code history — when X appeared/changed, "посмотри через git" → never
  `git log`/`blame`/`-S`/`show`:
  `semantic_search(query: <X>, rerank: "bugHunt")`
- behaviour/intent: no name, or concept words/synonyms/spellings (even as `a|b`)
  → ONE `semantic_search(query: "a ||| b ||| c")` (≤5 phrasings fused; real ids
  among them → `hybrid_search(metaOnly)`) → anchor → depth-2 callees/callers →
  ONE batch; never text search
- non-identifier text — regex syntax, TODO/FIXME, phrase, string to find (debug,
  or a search tool demanded on an error → bug-hunt), even "every …" → Grep tool,
  not tea-rags; phrase/error string → plan these three lines, never stop at the
  hit: `Grep tool "<phrase>" <dir> (literal, line cap)` →
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
  "grep for X" → Grep tool `"<X>" <src dir>` (literal, `-l`) → `find_symbol`
  outline → batch of only the needed methods, never stop at the hit
- symbol + intent ("the X that does Y"), files named X →
  `hybrid_search(metaOnly)`
- code like a chunk in hand → `find_similar(positiveIds:)`
- how does X reach Y / A→B → `find_symbol` ids → `trace_path`
- diff review, a diff's names →
  `review_changes(changes:{base}, sections:[the asked ones])` — `{}` =
  uncommitted, `{base}` = branch; its verdicts = answer, nothing after
- a name's fit → `get_naming_lexicon(names:[{name,kind}])`; naming a T value →
  `types:[T]`
- project's embedding/Qdrant/env → `list_projects(project:)`
- research — layers/wrong-way deps of `<dir>` →
  `get_architecture_report(pathPattern)`; implements `<P>` → `get_callers` +
  `hybrid_search(<P>, metaOnly)`; registered/configured `<X>` →
  `hybrid_search("<X> register config")`; ticket `<T>` →
  `semantic_search(taskId: <T>, level: "chunk")` → ONE
  `find_symbol(symbols: <touched ids>)`, no grep; owners/recent
  churn/debt/don't-touch →
  `rank_chunks(rerank: ownership|hotspots|techDebt|criticalPath, pathPattern)`;
  dead code → `filter:{presets:"deadCandidates"}`; which to copy →
  `rerank: "proven"`

**Invariants.**

- NEVER call for what you have (row, body, outline, edge in context) → use it;
  never re-query/re-read/re-verify, not "to be sure", not on follow-up. New
  search only for unseen code.
- After `find_symbol`: small file (`kind: "file"`) = full text, nothing after;
  outline → drill. Needed at once → ONE `find_symbol(symbols: [...])`: NAMED
  `Class#method` ids (rows, outline, edges) and several FILES; never a dir.
- Anchor = the row whose symbol/path names the task's field or behaviour — any
  row, not row 1, nor the first anchor you drilled; a later answer's row naming
  it better → new anchor. Which files change / end to end / every place → next
  call, before any new search or answer:
  `1. get_callers/get_callees(symbolId: <anchor id>, depth: 2)`,
  `find_co_changed` `2. ONE find_symbol(symbols: [anchor + needed ids])`. Before
  answering: every row that named the behaviour is in the answer, or why it's a
  false lead.
- `symbolId` ends `#partN` = fragment →
  `find_symbol(symbol: <id minus #partN>)`; parts = one hit.
- `empty.reason: unknownPath` with suggestions →
  `find_symbol(relativePath: <dir they share>)`, never one suggestion.
- No `treeState` row, no `degraded` → index IS current code (overlay serves
  uncommitted edits; no `workingTree` = current): trust it. Lag
  (`changedFiles`>0, `pendingFiles`, drift) → stay in tea-rags. `treeState` row
  = pre-edit copy (say why, e.g. `denseUnavailable`): dependents' fanIn/churn
  valid, not proof of the edit → `find_symbol`; `pendingFiles` > 0 (a count; may
  be yours) → plan both lines: `find_symbol(<same params>)` and
  `still in pendingFiles → find_symbol(<same params>) again`.
- Freshness (subagent: keep reading, never `index_codebase`/`AskUserQuestion`,
  drift/`--force` → parent report). Main: cwd in `.claude/worktrees/` or ≠
  alias's path → print `linked worktree (<test>) — no reindex`; own checkout
  behind (`changedFiles`>0, stale, unindexed edits, said so) → incremental
  `index_codebase(project=)` first, no consent. Drift `Run:` `--force*`
  (status/prime/index only, not a read answer) → own-checkout incremental first
  if behind, plus ONE line
  `AskUserQuestion: run <Run: line>? — --force not run; reads continue meanwhile`,
  never awaited, never "won't proceed"; next = the task's read call.
- Edges at changed files, `treeGraphUnavailable` → all 3 steps, in order, none
  dropped (a `--force` ask rides beside, never a slot):
  `1. index_codebase(project=)` (main own checkout; linked/subagent → skip)
  `2. find_symbol(symbol: <caller>)` `3. Grep tool "<name>" (literal)` — callers
  the index lacks. No graph retry. Graph tools absent from your tool list →
  codegraph off: callers = usages row, never "no cycles"; present → on, no probe
  call; on + empty `find_cycles` = DAG.
- Docs = hypothesis, verify in code; doc as subject ("README says?") → as-is, no
  code pass.
- `rustc driver: unavailable` → tell user ONCE: Rust edges static-only (lower
  bound) + install command; never install it, never "no callers"/"dead code".
- User orders a manual read — "by hand"/"руками"/"вручную"/"with Read" → Read
  tool, no confirm ask. "Whole file"/"весь файл"/"целиком"/"for context"/"lines
  N–M" of source code without that order → `find_symbol` (hit's `symbolId`, then
  file outline), print `Chunk coordinates exist. Use them.` Their tool idea
  ("use Grep/Glob") → keep the routed tool, say why.

**Read `tea-rags://guide/<topic>` when** (no resource tool →
`tea-rags resource <uri>`): after any search → `navigation`; 0/too many hits,
`truncated`, `empty.reason`, ambiguous name, when to stop → `pagination`; tool
pick → `tool-choice`; skill/preset → `skill-choice`; research question →
`research-questions`; banned move, fallback → `prohibited-patterns`; stale
banner, drift, `treeState`, linked worktree → `freshness`; embedding/qdrant
error, `denseUnavailable` → `degraded`; raw `filter:` → `filters`; `rerank`,
labels → `presets`, `signals`, `signal-labels`; graph/AST, other language →
`language-capability`; architecture / `review_changes` answer →
`architecture`/`review`; no prime digest → `tea-rags://project/<alias>/digest`;
numeric filter value unknown / bare raw number, no label →
`…/metrics?language=<lang>&section=thresholds`.

**Destructive — explicit consent:** `force_reindex`, `clear_index`, `delete_*`.
