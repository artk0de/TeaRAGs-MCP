# tea-rags core

**Addressing.** Every read call: `project=<alias>` (which index) +
`path=<this task's cwd>` (which tree, re-checks too). Alias: prime `## Project`,
SubagentStart line or `workingTree.project`; unknown/"not registered" → `path`
alone, never ask; only a `collection` → it alone, then say
`next: project=<workingTree.project> + path`. No cwd → call now, `project`
alone. `workingTree.tree` ≠ cwd → rows unusable; re-call `path=<cwd>`.
`index_codebase`: `project` ONLY; unregistered cwd → `path=<cwd>`.

**Routing** (first match wins; a loaded skill's steps run first, override rows —
a file path in them → row 1; tools `mcp__tea-rags__*`):

- file path / doc TOC → `find_symbol(relativePath:)`
- known symbol body/outline → `find_symbol(symbol:)` `Class#inst`/`C.st`
- every/all callers of X → `get_callers` AND `hybrid_search(metaOnly)`
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

- Never `Read` after `find_symbol` — method = full body; outline
  (class/file/doc) → drill `find_symbol(symbol: <id>)`. After a search:
  `find_symbol` next, not re-search/`Read`.
- `symbolId` ends `#partN` = fragment → `find_symbol(symbol: parentSymbolId)`;
  parts = one hit.
- Lag (`changedFiles`, `pendingFiles`, `floors: []`, drift) → stay in tea-rags.
  No `treeState` = current; `treeState` row = pre-edit copy (say why, e.g.
  `denseUnavailable`): dependents' fanIn/churn valid, not proof of the edit →
  `find_symbol`; in `pendingFiles` → re-call.
- Freshness: (1) subagent → keep reading; no `index_codebase`/
  `AskUserQuestion`; drift/`--force`/remedy → parent report. Main: (2) cwd in
  `.claude/worktrees/` or ≠ alias's path → print
  `linked worktree (<test>) — no reindex`; own checkout behind
  (`changedFiles`>0, stale, unindexed edits, said so) → incremental
  `index_codebase(project=)` first, no consent. (3) Drift `Run:` `--force*` →
  subagent: (1); main: own `AskUserQuestion: run <Run: line>?`, never awaited;
  print `--force not run; reads continue`, next = a read.
- Empty `get_callers` at low resolve ≠ no callers → `hybrid_search`; edges at
  changed files → own checkout → `index_codebase` first, then `find_symbol`
  caller + `hybrid_search(metaOnly)`, no graph retry. Codegraph off → never
  claim "no cycles"; on + empty `find_cycles` = DAG.
- Docs = hypothesis; verify in code.
- User names a tool/action ("read `x.ts`" → `Read`) → do it, over rows; user's
  weaker search method → keep rule's, say why.

**Read `tea-rags://guide/<topic>` when** (no resource tool →
`tea-rags resource <uri>`): after any search → `navigation`; 0/too many hits,
ambiguous name, when to stop → `pagination`; skill pick, fallbacks →
`decision-tree`; stale banner, drift, `treeState`, linked worktree →
`freshness`; embedding/qdrant error, `denseUnavailable` → `degraded`; raw
`filter:` → `filters`; `rerank`, labels → `presets`, `signals`, `signal-labels`;
graph/AST, other language → `language-capability`; no prime digest/labelMap →
`tea-rags://project/<alias>/digest` / `…/metrics`.

**Destructive — explicit consent:** `force_reindex`, `clear_index`, `delete_*`.
