# tea-rags core (continued)

The first part of this core arrives as the tea-rags MCP server instructions;
this continues it where they stop. Their code search tool is the Grep tool
(absent → Bash `grep`; zsh: quote globs `--include='*.rb'`, no `echo ===`);
their code read tool is the Read tool. No tea-rags server instructions in
context → read `tea-rags://guide/core` (no MCP:
`tea-rags resource tea-rags://guide/core`) first.

- project's embedding/Qdrant/env → `list_projects(project:)`
- research — layers/wrong-way deps of `<dir>` → explicit diagnosis/refactoring
  only: `get_architecture_report(pathPattern)`; never for context gathering or
  overviews. Implements `<P>` → `get_callers` + `hybrid_search(<P>, metaOnly)`;
  registered/configured `<X>` → `hybrid_search("<X> register config")`; ticket
  `<T>` → `semantic_search(taskId: <T>, level: "chunk")` → ONE
  `find_symbol(symbols: <touched ids>)`, no grep; owners/recent
  churn/debt/don't-touch →
  `rank_chunks(rerank: ownership|hotspots|techDebt|criticalPath, pathPattern)`;
  dead code → `filter:{presets:"deadCandidates"}`; which to copy →
  `rerank: "proven"`

**Invariants.**

- Reuse held code, outlines, edges and instructions (skills/guides) on
  follow-ups. Refresh only affected edited/stale or missing material, including
  after compaction. Each read closes a current evidence gap, not a future
  question; a held body may need zero calls.
- Batch missing symbols/files → `find_symbol(symbols:)`, never dirs;
  config/spec/migrations → concurrent bounded per-file reads.
- Fresh full bodies from ANY tea-rags tool (`semantic_search` included) are
  authoritative code, not hints. Never confirm the same body via `find_symbol`,
  Read or shell. Metadata/outline/signature/container header ≠ method body.
- Anchor = the hit for the requested behaviour. Flow/impact → needed edges
  (`depth: 2`); change-impact may need `find_co_changed`. Batch required
  methods, not classes/trees; headers/shared declarations only if needed. Stop
  once supported.
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
  `2. find_symbol(symbol: <caller>)`
  `3. Grep tool "<name>" (literal)` — callers the index lacks. No
  graph retry. Graph tools absent from your tool list → codegraph off: callers =
  usages row, never "no cycles"; present → on, no probe call; on + empty
  `find_cycles` = DAG.
- Docs = hypothesis, verify in code; doc as subject ("README says?") → as-is, no
  code pass.
- `rustc driver: unavailable` → tell user ONCE: Rust edges static-only (lower
  bound) + install command; never install it, never "no callers"/"dead code".
- User orders a manual read — "by hand"/"руками"/"вручную"/"with Read" → Read tool, no confirm ask. "Whole file"/"весь файл"/"целиком"/"for
  context"/"lines N–M" of source code without that order → `find_symbol` (hit's
  `symbolId`, then file outline), print `Chunk coordinates exist. Use them.`
  Their tool idea ("use Grep/Glob") → keep the routed tool, say why.

**Read `tea-rags://guide/<topic>` when** (no resource tool →
`tea-rags resource <uri>`): unfamiliar result/navigation contract →
`navigation`; 0/too many hits, `truncated`, `empty.reason`, ambiguous name, when
to stop → `pagination`; tool pick → `tool-choice`; skill/preset →
`skill-choice`; research question → `research-questions`; banned move, fallback
→ `prohibited-patterns`; stale banner, drift, `treeState`, linked worktree →
`freshness`; embedding/qdrant error, `denseUnavailable` → `degraded`; raw
`filter:` → `filters`; `rerank`, labels → `presets`, `signals`, `signal-labels`;
graph/AST, other language → `language-capability`; architecture /
`review_changes` answer → `architecture`/`review`; no prime digest →
`tea-rags://project/<alias>/digest`; numeric filter value unknown / bare raw
number, no label → `…/metrics?language=<lang>&section=thresholds`.

**Destructive — explicit consent:** `force_reindex`, `clear_index`, `delete_*`.
