# tea-rags core

**Every code search and code read goes through tea-rags.** Shell, `Read`, Grep
only for files outside the index (`db/`, `*.yml`, `*.json`) — say so.

**Addressing.** Every read call, each next/planned call you write included
(`find_symbol(symbol: X, path=<cwd>)`): `project=<alias>` (which index) +
`path=<this task's cwd>` (which tree, re-checks too). Alias: prime `## Project`,
SubagentStart line or `workingTree.project`; unknown/"not registered" → `path`
alone, never ask; only a `collection` → it alone; after either say
`next: project=<workingTree.project> + path`. No cwd → call now, `project`
alone. `workingTree.tree` ≠ cwd → rows unusable; re-call `path=<cwd>`.
`index_codebase`: `project` ONLY; unregistered cwd → `path=<cwd>`.

**Routing** (first match wins; a loaded skill's steps run first, override rows —
a file path in them → row 1; tools `mcp__tea-rags__*`):

- file/dir path, doc TOC → `find_symbol(relativePath:)`; its imports →
  `get_callees(relativePath:)` (`imports[]`; a row's `imports` = a count);
  user's manual-read order → `Read` (Invariants)
- code history — when X appeared/changed, "посмотри через git" → never
  `git log`/`blame`/`-S`/`show`:
  `semantic_search(query: <X>, rerank: "bugHunt")`
- non-identifier text — regex syntax, TODO/FIXME, phrase, string to find (debug,
  or a search tool demanded on an error → bug-hunt), even "every …" → client's
  standard code search tool, never tea-rags; phrase/error string → plan these
  three lines, never stop at the hit:
  `client's standard code search tool "<phrase>" (literal)` →
  `find_symbol(relativePath: <hit file>)` outline →
  `find_symbol(symbol: <enclosing symbolId>)` body. A code name, even called a
  "pattern"/"glob", is a symbol (→ `hybrid_search`, not `rg --files`). Command
  output, failing tests, counts → `<cmd> 2>&1 | grep -E 'FAIL|✗'` (`| wc -l`),
  no skill
- known symbol body/outline → `find_symbol(symbol:)` `Class#inst`/`C.st`
- every/all callers of X → `get_callers` AND `hybrid_search(metaOnly)`
- usages; who constructs X; files named X → `hybrid_search(metaOnly)`
- behaviour/intent, no name → `semantic_search` only, no `hybrid_search`
- code like a chunk in hand → `find_similar(positiveIds:)`
- who calls X / impact → `find_symbol` → `get_callers`/`get_callees`
- how does X reach Y / A→B → `find_symbol` ids → `trace_path`
- diff review, a diff's names →
  `review_changes(changes:{base}, sections:[the asked ones])` — `{}` =
  uncommitted, `{base}` = branch; one name → `get_naming_lexicon`
- project's embedding / Qdrant / env → `list_projects(project:)`
- research — layout of `<dir>` → `get_architecture_report(pathPattern)`;
  implements `<P>` → `get_callers` + `hybrid_search(<P>, metaOnly)`; registered
  / configured `<X>` → `hybrid_search("<X> register config")`; ticket `<T>` →
  `semantic_search(taskId:)`; owners / recent churn / debt / don't-touch →
  `rank_chunks(rerank: ownership|hotspots|techDebt|criticalPath, pathPattern)`;
  dead code → `filter:{presets:"deadCandidates"}`; which to copy →
  `rerank: "proven"`

Never Grep/`rg`/`rg --files`, Glob or `cat`/`sed` to locate or read code —
identifiers (even `a|b`) are SYMBOL searches. A name's fit → lexicon
`names:[{name,kind}]`, naming a T value → `types:[T]`; a diff's →
`review_changes` verdicts, nothing after.

**Invariants.**

- Never `Read` after `find_symbol` — method = full body; small file
  (`kind: "file"`) = full text, the read itself, nothing after; outline
  (class/large file/doc) → drill `find_symbol(symbol: <id>)`; every id or file
  you will read → ONE `find_symbol(symbols: [<ids or paths>])`, never one per
  turn. After a search, or a file/id already known: `find_symbol` next — another
  search is the "Curiosity search" anti-pattern; never re-search/`Read`.
- Anchor = the row whose symbol/path names the task's field or behaviour — any
  row, not row 1, nor the first anchor you drilled; a later answer's row naming
  it better → it becomes the anchor. Which files change / every place → in
  order, before any new search: `1. find_symbol(symbol: <anchor id>)`
  `2. get_callers/get_callees/find_co_changed` on the anchor's file (`next` as
  given only when its `relativePath` is that file); never a re-query of the same
  intent. Before answering: every row that named the behaviour is in the answer,
  or say why it is a false lead.
- `symbolId` ends `#partN` = fragment →
  `find_symbol(symbol: <id minus #partN>)`; parts = one hit.
- Answer has `truncated` → next call = `truncated.next` as given, or narrowed
  (`detectors`/`limit`/`evidenceLimit`/`pathPattern`); never the same call.
- `empty.reason: unknownPath` →
  `find_symbol(relativePath: <dir its suggestions share>)`, never one suggested
  file.
- Lag (`changedFiles`, `pendingFiles`, `floors: []`, drift) → stay in tea-rags.
  No `treeState` = current; `treeState` row = pre-edit copy (say why, e.g.
  `denseUnavailable`): dependents' fanIn/churn valid, not proof of the edit →
  `find_symbol`; `pendingFiles` > 0 (a count; your file may be one) → plan both
  lines: `find_symbol(<same params>)` and
  `still in pendingFiles → find_symbol(<same params>) again`.
- Freshness: (1) subagent → keep reading; no `index_codebase`/
  `AskUserQuestion`; drift/`--force`/remedy → parent report. Main: (2) cwd in
  `.claude/worktrees/` or ≠ alias's path → print
  `linked worktree (<test>) — no reindex`; own checkout behind
  (`changedFiles`>0, stale, unindexed edits, said so) → incremental
  `index_codebase(project=)` first, no consent. (3) Drift `Run:` `--force*` →
  subagent: (1); main: (2)'s incremental still runs first when the checkout is
  behind, plus ONE line
  `AskUserQuestion: run <Run: line>? — --force not run; reads continue meanwhile`,
  never awaited, never "won't proceed"; next = the task's read call.
- Empty `get_callers` at low resolve ≠ no callers → `hybrid_search`. Edges at
  changed files, no `codegraph` floor (timeout, `floors: []`) → all 3 steps, in
  order, none dropped (a `--force` ask rides beside them, never takes a slot):
  `1. index_codebase(project=)` (main own checkout; linked/subagent → skip)
  `2. find_symbol(symbol: <caller>)` `3. hybrid_search(metaOnly)` — callers the
  index lacks. No graph retry. Codegraph off → never claim "no cycles"; on +
  empty `find_cycles` = DAG.
- Docs = hypothesis; verify in code — unless the doc is the subject ("what does
  README say") → report it as-is, no code pass.
- `rustc driver: unavailable` (prime / `get_index_status` / `index_codebase`) →
  tell the user ONCE per session: Rust call edges static-only (lower bound),
  quote the install command from that line; never install yourself; never claim
  "no callers" / "dead code" from the Rust graph then.
- User orders a manual read — "by hand"/"руками"/"вручную"/"with Read" → `Read`,
  no confirm question. "Whole file"/"весь файл"/"целиком"/"for context" without
  that order → `find_symbol` (hit's `symbolId`, then file outline), print
  `Chunk coordinates exist. Use them.`, never `Read`. Their plan or tool idea
  ("use Grep/Glob") → keep the rule's tool, say why.

**Read `tea-rags://guide/<topic>` when** (no resource tool →
`tea-rags resource <uri>`): after any search → `navigation`; 0/too many hits,
`truncated`, `empty.reason`, ambiguous name, when to stop → `pagination`; skill
pick, fallbacks, other research questions → `decision-tree` "Question → call";
stale banner, drift, `treeState`, linked worktree → `freshness`;
embedding/qdrant error, `denseUnavailable` → `degraded`; raw `filter:` →
`filters`; `rerank`, labels → `presets`, `signals`, `signal-labels`; graph/AST,
other language → `language-capability`; architecture report / `review_changes`
answer → `architecture` / `review`; no prime digest →
`tea-rags://project/<alias>/digest`; numeric filter value not given
(minCommitCount/minAgeDays/maxAgeDays/minFanIn/modifiedAfter window) or bare raw
number, no label → `…/metrics?language=<lang>&section=thresholds`.

**Destructive — explicit consent:** `force_reindex`, `clear_index`, `delete_*`.
