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
you did not see is not a rule you may guess. Missing instructions → read only
their missing ranges (`sed -n`). For source, follow the tea-rags continuation
only if needed code is missing; never reread retained bodies because output was
truncated.

**Each step takes the tool its routing row names.**

**Addressing.** Every read or suggested call: `project=<alias>` +
`path=<task cwd>`. Alias: digest, SubagentStart or `workingTree.project`.
Unknown/"not registered" → `path` alone, never ask; only a `collection` → it
alone; then use `project=<workingTree.project> + path`. No cwd → `project`
alone. `workingTree.tree` ≠ cwd → discard those rows, re-call with `path=<cwd>`.
`index_codebase`: `project` ONLY; unregistered cwd → `path=<cwd>`.

Shell rg -l --hidden --glob '!.git': unknown filenames/inventory/absence; known
file → content; `| head` ≠ absence proof. Use anchor dir, else `<src dir>` (a
dir under cwd, never cwd itself); no dir search or find/Glob.

**Routing** (first match wins; a loaded skill's steps run first, override rows —
a file path in them → row 1; tools `mcp__tea-rags__*`):

- config/DSL/routes/migrations/specs, an unindexed file, a `find_symbol` stub →
  shell sed -n '<start>,<end>p' <one file> (path unknown → shell rg -l --hidden
  --glob '!.git' first); all X in a known `<dir>`, proving absence ("no X
  exists") → shell rg -l --hidden --glob '!.git' over that dir (empty = proof);
  migration `X` → `"X"` over `db/migrate/`; table/column exists, `create_table`
  → that search over `db/schema.rb`, then `db/migrate/` (`:<table>`, `"<table>"`
  before "absent"), never `semantic_search`. Other file/dir path, lines N–M, doc
  TOC, how `<dir>` works / what's in it → `find_symbol(relativePath:)` outline
  first, then ONE batch of needed ids (N–M: ids whose `L<a>-<b>` covers N–M,
  never Read offset/limit); known method id → body, no outline. Imports →
  `get_callees(relativePath:)` (`imports[]`; a row's `imports` = a count)
- code history — when X appeared/changed, "посмотри через git" → never
  `git log`/`blame`/`-S`/`show`:
  `semantic_search(query: <X>, rerank: "bugHunt")`
- behaviour/intent: no name, or concept words/synonyms/spellings (even as `a|b`)
  → ONE `semantic_search(query: "a ||| b ||| c", metaOnly:true, limit:5)` (≤5
  phrasings fused; real ids → `hybrid_search(metaOnly:true, limit:5)`). Choose
  anchors before bodies; expand only as needed, never text search for meaning
- non-identifier text — regex syntax, TODO/FIXME, phrase, string to find (debug,
  or a search tool demanded on an error → bug-hunt), even "every …" → shell rg
  -l --hidden --glob '!.git', not tea-rags; phrase/error string → plan these
  three lines, never stop at the hit:
  `shell rg -l --hidden --glob '!.git' "<phrase>" <dir> (literal, line cap)` →
  `find_symbol(relativePath: <hit file>)` outline →
  `find_symbol(symbol: <enclosing symbolId>)` body. DSL `ns:task` = symbol; code
  name, even a "pattern"/"glob" → usages row. Command output, failing tests,
  counts → `<cmd> 2>&1 | grep -E 'FAIL|✗'` (`| wc -l`), no skill
- how X works/what happens when → `get_callees` (body unseen → `find_symbol`
  first); who calls X/impact/where Y is handled → `get_callers` — `symbolId:`,
  `depth: 2`; every call/all callers of X (grep named) → plan both lines:
  `get_callers` + the usages row. Then ONE batch: needed tree methods
- known symbol / identifier definition/body/outline → `find_symbol(symbol:)`
  `Class#inst`/`C.st`, never text search
- where X is used/referenced, every occurrence, who constructs X, files
  containing X (exact name/constant/string you know; `a|b` only of seen ids),
  "grep for X" →
  `shell rg -l --hidden --glob '!.git' "<X>" <src dir, e.g. app/ or src/>`
  (literal, `-l`) → `find_symbol` outline → batch of only the needed methods,
  never stop at the hit
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
- A requested row without `treeState` / `degraded` is current, overlay too;
  global `changedFiles` / `pendingFiles` alone never require a reread. A
  `treeState` body is pre-edit; fanIn/churn remain usable. **Repeat the same
  `find_symbol` arguments once**: it reads the working tree, not a cached body.
  No Read/shell refresh. Still stale → state the gap. No `workingTree` →
  current.
- Freshness (subagent: keep reading, never `index_codebase`/ask the user,
  drift/`--force` → parent report). Main: cwd in `.claude/worktrees/` or ≠
  alias's path → print `linked worktree (<test>) — no reindex`; own checkout
  behind (`changedFiles`>0, stale, unindexed edits, said so) → incremental
  `index_codebase(project=)` first, no consent. Drift `Run:` `--force*`
  (status/prime/index only, not a read answer) → own-checkout incremental first
  if behind, plus ONE line ask the user: run <Run: line>? — --force not run;
  reads continue
  meanwhile`, never awaited, never "won't proceed"; next = the task's read call. No available `index_codebase`→ needed stale bodies via`find_symbol`;
  never look up indexing/mutator schemas.
- Edges at changed files, `treeGraphUnavailable` → all 3 steps, in order, none
  dropped (a `--force` ask rides beside, never a slot):
  `1. index_codebase(project=)` (main own checkout; linked/subagent → skip)
  `2. find_symbol(symbol: <caller>)`
  `3. shell rg -l --hidden --glob '!.git' "<name>" (literal)` — callers the
  index lacks. No graph retry. Graph tools absent from your tool list →
  codegraph off: callers = usages row, never "no cycles"; present → on, no probe
  call; on + empty `find_cycles` = DAG.
- Docs = hypothesis, verify in code; doc as subject ("README says?") → as-is, no
  code pass.
- `rustc driver: unavailable` → tell user ONCE: Rust edges static-only (lower
  bound) + install command; never install it, never "no callers"/"dead code".
- User orders a manual read — "by hand"/"руками"/"вручную"/"with Read" → shell
  sed -n '<start>,<end>p' <one file>, no confirm ask. "Whole file"/"весь
  файл"/"целиком"/"for context"/"lines N–M" of source code without that order →
  `find_symbol` (hit's `symbolId`, then file outline), print
  `Chunk coordinates exist. Use them.` Their tool idea ("use Grep/Glob") → keep
  the routed tool, say why.

**Read `tea-rags://guide/<topic>` when** →
`read_mcp_resource(server: "tea-rags", uri: "tea-rags://guide/<topic>")`, never
a bare `list_mcp_resources` (list only with `server: "tea-rags"`) (no resource
tool → `tea-rags resource <uri>`): unfamiliar result/navigation contract →
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

**tea-rags tools** are MCP tools of server `tea-rags`. In JS code mode use
`await tools.mcp__tea_rags__<tool>({...})`; discover names with
`ALL_TOOLS.filter(t => t.name.includes("tea_rags")).map(t => t.name)`
(`"tea-rags"` matches none). Missing argument schema → select ONE named tool,
print only
`tool.description.split("exec tool declaration:")[1]?.split("Promise<")[0]`.
Reuse known schemas; never print full descriptions, core instructions or return
schemas. No declaration → use the listed interface. Direct tools → call as
listed.

**Core navigation.** Focused questions about existing behavior, definitions or
local contracts use core directly, including discovery of the relevant code. Do
not load Explore merely because the location is unknown. Start with the missing
source evidence: known file/symbol → `find_symbol`; unknown behavior location →
`semantic_search({project,path,query,metaOnly:true,limit:5})`. These argument
contracts are known; no schema-only prelude is needed. Broad structure,
cross-component flow/impact, examples, pre-change investigation, explicit skill
requests and code changes still load their selected skill first.

For a complete adapter/extension contract, derive required members from actual
production dispatch sites, including background entry points. Inventory learned
receiver/registry references across the source root; a provider registry or one
directory does not establish the whole interface. For operational lessons,
retain explicit retry/window bounds and reset conditions that change guarantees.

**Property questions.** For units/type/representation of a named business
construct, the FIRST query contains ONLY that construct's short noun phrase. Add
property terms only if that query misses; inspect the property in its owner. A
vendor name or generic object is not the construct. Workflow questions retain
their behavior and domain; never shorten them to a vendor name alone.

**Reuse before reading**, inside skills too: fetch only the current question's
missing facts. Held code proves its explicit adapter/implementation selection;
graph closes a missing caller/trigger/flow fact. Outline, header and blocked
read are not bodies. Read a caller's qualified member directly; inventory its
owner only after missing/ambiguous lookup. Do not guess receivers. If an
entrypoint proves a request stops before dispatch, stop there; downstream
workflow/retry internals are needed only when the question asks about them.
Codex unknownPath exception: if exactly one suggested file has the requested
basename, read that relativePath directly. With ambiguous suggestions, inventory
their common directory first. This replaces the unconditional directory
fallback. For config filenames/policy names from a manifest, resolve paths with
one scoped filename inventory (`rg --files <known config dir>`), then read the
selected files. Searching a filename in file contents does not locate that file.
Positive filename globs are alternatives: `-g '*name*' -g '*.rb'` includes all
Ruby files. For name AND extension use one `-g '*name*.rb'`; omit the extension
glob when any matching filename is wanted. Do not widen a narrow inventory.

**Tool execution and waiting.** Select missing evidence from held
outlines/nextCall hints for each requested fact. A helper is unnecessary when
held code proves it. Put ready needed bodies AND independent reference/absence
searches in one executor wave. Two already-known groups may use concurrent batch
calls in the same exec; preserve their output budgets instead of spending a
model response per group. Do not prefetch context for future questions. Use
`find_symbol(symbols:[…])` for methods/files (at most 20 targets per call; split
larger sets into concurrent calls); config/spec reads are bounded per-file
calls. Directories use separate `find_symbol(relativePath:)` calls, never
`symbols`. Dispatch independent calls together (`Promise.allSettled` /
`Promise.all` in code mode); await prerequisites before dependent calls.
Different tool kinds do not create a dependency. Another wave needs a newly
discovered locator, ambiguity, prerequisite or actual output-budget constraint;
merge pending independent work before following a continuation. Read only
evidence for the current request, not future questions. Parallelism never
justifies extra context reads or competing edits. Keep each result (or error)
labelled by its input path/id; emit the labelled results after awaiting the
batch, never anonymous output in completion order. Inspect all settled outcomes
and cover every requested item. A returned result is ready. A running executor
with a cell/session id needs its matching native `wait` / `write_stdin`, reusing
that id; do not restart the work. For subagents use the harness's agent-wait or
completion notification. For user input ask the question, then yield control
until the reply; clarification is allowed. Continue independent work when
useful. Never use `sleep`, shell/Python/JS timer delays or busy polling to await
tools, agents or users.

**Skills are not loaded for you** — except this core: `$tea-rags-core` IS this
text, never open its `SKILL.md`. A task a skill covers (`$name` /
`$dino-<name>`) → read its `SKILL.md` before using it, unless its instructions
are already in the current context. Reuse loaded skills, references and guides
across follow-ups; a new turn alone is not a reason to read them again. Retained
current text satisfies a workflow's read-before-use requirements. Reopen only
changed instructions or material missing after compaction. Load only the
selected workflow's needed references and handoffs, using the listed skill paths
rather than inventing paths or loading adjacent skills. Every skill you name in
a plan must be available in context; a plan from memory is not reading it.
`repair/<family>.md`, `rules/…` resolve from the plugin root (the folder holding
`skills/`), never the skill's own folder.

**Lag follow-ups.** Incremental `index_codebase` is a prelude, not the answer:
continue the requested source task. For changed-file graph answers, re-check
changed-file callers via `find_symbol`, find missing ones via shell rg -l
--hidden --glob '!.git' (literal); never retry the graph.
