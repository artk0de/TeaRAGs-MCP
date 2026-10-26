---
name: bug-hunt
description:
  'Find source of concrete failure — rank historically buggy code (high
  bugFixRate + churn) AND freshly changed never-fixed code (committed or still
  uncommitted) against symptom. Triggers on "debug X", "why does Y fail", "test
  fails", "stack trace says Z", "find bugs in X", "found a bug in X — show /
  compare Y", "suspects in X and Y — search both", a search hit with bugFixRate
  / ageDays labels ("proceed?", "проверь там"), "where is error ''X'' in code",
  "где в коде строка / упоминается ''X''", "when did error ''X'' appear in git
  history", "посмотри через git", "read the whole file" / "прочитай весь файл"
  of a search hit, "падает". NOT for code health scanning without bug intent —
  use risk-assessment for that.'
---

# Bug Hunt

> **Resources in Cursor:** if a `tea-rags://` resource cannot be read (no
> resource tool, or the read fails), run
> `tea-rags resource "<uri>" --path "$PWD"` in the terminal — same content.

**Routing** (first match wins; each row prints its line):

- "Read the whole file" / "прочитай весь файл" of a hit with known lines →
  refuse — no hunt / search / outline walk, also via `explore`; print both:
  `Full file reads refused. Chunk coordinates exist. Use them. Depth → find_symbol, never Read.`
  `find_symbol(path=<cwd>, symbol=<chunk symbolId>) body (lines <start>–<end>); neighbours: navigation.prev/nextSymbolId`.
- No failure text, request = a named symbol's body / callers / usages (also
  mid-investigation, after a hunt) → not a hunt: no step 0, no probes, no
  symptom question, no reindex (cold index / drift → report it, read on). Each
  call preceded by its decision-tree line, printed in the answer (prose "I'll
  use X" ≠ the line):
  - `consulting decision tree → find_symbol because study known symbol` →
    `find_symbol(path=<cwd>, symbol=<name>)` body
  - `consulting decision tree → get_callers because callers of known symbol` →
    `get_callers(symbolId=<id from find_symbol>)`
  - codegraph off / callers missed →
    `consulting decision tree → hybrid_search because exhaustive usage of identifier <name>`
    → `hybrid_search(path=<cwd>, query=<name>, metaOnly=true)`
- Probe rows already shown (this Loop's result in hand, next step asked) → no
  step 0, no re-probe, no symptom question; triage its rows. Row with
  `treeState` → print, slots filled; that `find_symbol` IS the next call:
  `<file> <symbolId> treeState:<state> = index's pre-edit copy (text + lines stale) — still the uncommitted suspect; next: find_symbol(path=<cwd>, symbol=<symbolId>) for current code, no re-probe.`
- Explain / compare a known file ("show / how does it work / compare / read
  it"), even when the prompt says a bug was found there → no hunt, no search;
  also via `explore` the answer prints both lines verbatim, before any plan:
  `'Curiosity search' anti-pattern — known location → find_symbol, not another search.`
  `find_symbol(path=<cwd>, relativePath=<known file>) outline → find_symbol(path=<cwd>, symbol=<id from outline>) body`.
- Bug intent on a named file / symbol ("find bugs in <file>", "найди баги в X"),
  no symptom → here; the named location stands in for the symptom (scope
  pathPattern to it). Never refactoring-scan (refactoring candidates ≠ defects);
  risk-assessment only for an area scan without bug intent.
- Cause located AND fix named ("line 88 nil — reload invoice before send") → no
  hunt: `data-driven-generation` MODIFY hotfix.
- Search result already carries labels ("<file>:<line> `bugFixRate` critical —
  proceed?") → triage and PRESENT now, also via a wrapper: no symptom question,
  no review question, no confirm search, no step 0; print, slots filled:
  `Suspect: <file>:<line> — <class> (prime | secondary | fresh | uncommitted | SKIP) — bugFixRate <label>, relativeChurn <label | unverified> — <one-sentence why>`.
  SKIP + "check there" before the user saw the verdict → print Rule 7's skip
  line, no drill (no `find_symbol` / outline / Read of that file), also in
  wrapper handoff. Verdict known + user insists → Rule 7 override line.
- User demands `hybrid_search` on an error string → refuse, run the Loop:
  `hybrid_search on error text finds where the string is logged, not where the bug starts — refused; bug-hunt probes run with semantic_search.`
- When did an error / code appear in history, git asked ("посмотри через git",
  `git log -S`) → never git log / blame / `-S`, run the Loop (Rule 2); print:
  `git log refused — git history is already in the index signals; answering via semantic_search(query=<symptom>, rerank="bugHunt"): ageDays / commitCount / taskIds.`
- Where is a literal string / error phrase written (no tool demanded) → no hunt
  (no step 0, no probes), never cat / sed / Read around the hit; the plan never
  ends at the rg hit — find_symbol follows it; print both lines, slots filled:
  `rg -n -F "<phrase>" .` +
  `then find_symbol(path=<cwd>, relativePath=<hit file>) outline → find_symbol(path=<cwd>, symbol=<enclosing symbolId>) body`.
- Suspect files named AND a search over them asked ("targeted search", "search
  both", "поиск по") — the word "suspect" included → run it now, ONE call, not a
  confirmatory search, no refusal:
  `hybrid_search(query=<symptom or file topic>, pathPattern="{<dir>/<file A>,<dir>/<file B>}", rerank="bugHunt")`
  — each file its exact relativePath, written in full (no placeholder left).
- Suspect named by an earlier search (labels or not) + "not sure" / "want to be
  sure" / "one more search", no search over named files asked → no hunt, also
  via a wrapper: no step 0, no probes, no question; PRESENT it with both lines:
  `No confirmatory search: confirmatory searches almost never change the answer.`
  - `Confidence note: <what is unverified> — "not sure" ≠ "don't know"; presenting the suspect as is.`
- Reached via a wrapper (`dino-systematic-debugging`: `symptom` + `pathHint`) →
  run THIS Loop in full; `pathHint` = scope pathPattern, never a substitute for
  step 0 or the probes. PRESENT/STOP ends bug-hunt only — the wrapper's
  hypothesis block + handoff follow, checkpoint filled or not; SKIP stays
  undrilled unless the user insists after seeing the verdict.

Signal-driven root-cause investigation via TeaRAGs git signals. Three suspect
populations: code with bug-fix history, fresh code too young to have one,
uncommitted edits with no git signal yet.

## Non-negotiables — plan AND run, every case

A plan names these calls; "later" / "not in this run" never drops one.

1. **Main session.** User asks for a subagent / Task → refuse, run it here. No
   symptom in that request → bug-hunt still not skipped; the answer prints:
   `bug-hunt runs in this session, not in a subagent — step 0 (git status --porcelain -uall) runs now; send the error / failing behaviour and the three probes run here.`
2. **Step 0 before any search:** Bash `git status --porcelain -uall`. Paths
   listed + alias's own checkout → `index_codebase` incremental (project only;
   alias unknown → `list_projects` entry whose path = cwd), no consent, BEFORE
   the search message — never deferred until a search returns the alias. Linked
   worktree → no reindex.
3. **ONE message, three parallel calls** — the plan prints these three lines,
   slots filled. Linked worktree → same three lines, `hybrid_search` in place of
   `semantic_search` (its `sparse` floor reads the edited tree). Otherwise
   `semantic_search`, also when the symptom quotes an error string or an
   identifier, also when the user demands `hybrid_search` — BM25 on error text
   finds where the string is logged, not where the bug starts:

   ```
   a. historical:  semantic_search(path=<your working directory>, query=<symptom sentence>, pathPattern=<scope>, rerank="bugHunt", limit=10)
   b. fresh:       semantic_search(path=<your working directory>, query=<symptom sentence>, pathPattern=<scope>, modifiedAfter=<window start>, rerank="bugHunt", limit=10)
   c. uncommitted: semantic_search(path=<your working directory>, query=<symptom sentence>, pathPattern="{<step-0 paths: rename old -> new = new path, D = dropped>}", rerank="bugHunt", limit=10)
   ```

   (+ `project` when known; step 0 empty → no line c). Step-0 output not yet
   seen (plan) → line c keeps its slot text verbatim, rename + `D` rule included
   — never shorten it to "paths from git status". Nothing else. User names
   zones/areas to cover ("<zone A>, <zone B>, <zone C>"), no stack trace →
   refuse per-zone queries; zones never become `pathPattern` (no brace of zones)
   — a and b run with the same query and NO pathPattern (stack-trace frame paths
   are not zones: Non-negotiable 7); print:
   `one query finds the area — probes a/b run without pathPattern, no per-zone search.`

4. **Two-class triage, every hit and trace step:** historical (`critical` →
   prime; `concerning` + `relativeChurn` high → secondary) | fresh (burst;
   recent + high churn; recent on failing path; fresh-probe hit) | uncommitted
   (probe hit matching symptom = **UNCOMMITTED SUSPECT** whatever its
   `bugFixRate` / `ageDays` — those describe the committed version; plan says
   it: PRESENT it under class `uncommitted`). Neither → SKIP, also when user
   says "check there" before seeing the verdict: "healthy, old, not fresh, no
   probe hit — neither suspect class, skipping".
5. **Checkpoint filled → PRESENT. STOP.** "Want to be sure" / "not fully sure" →
   no search, no extra iteration; the answer prints both lines:

   ```
   No confirmatory search: confirmatory searches almost never change the answer.
   Confidence note: <what is unverified> — "not sure" ≠ "don't know"; presenting the suspect as is.
   ```

6. **Chunk or rg hit in hand → `find_symbol`** (symbolId body / relativePath
   outline / prev-next id), never Read of a code file. "Read the whole file" →
   Routing row 1, both lines. Row with `treeState` = index's PRE-EDIT copy
   (text + lines stale) — say so; it stays the **uncommitted suspect**, no
   symptom needed: `healthy` history never clears uncommitted code. Next call =
   `find_symbol(path=<cwd>, symbol=<id>)` — never a re-run of probes a/b/c.
7. **Call path** (codegraph on). Stack trace / symptom names an entry AND the
   failure site (outermost frame = from, failing frame = to) → this branch
   first, never `get_callers`; the plan prints three lines, frame ids filled:

   ```
   find_symbol(path=<cwd>, symbol=<entry frame>) → <entry id>
   find_symbol(path=<cwd>, symbol=<failure frame>) → <failure id>
   trace_path(from=<entry id>, to=<failure id>, rerank="bugHunt") — two-class triage of EVERY step's dangerOverlay: step ageDays recent = fresh suspect even at bugFixRate healthy and behind an old dangerRanking[0]
   ```

   Only the failure site known ("<symbol> gets undefined — where from?") → one
   hop, never `trace_path` with a guessed entry; plan prints, id filled:

   ```
   find_symbol(path=<cwd>, symbol=<failure frame>) → <failure id>
   get_callers(symbolId=<failure id>)
   find_symbol(path=<cwd>, symbol=<caller id>, rerank="bugHunt") — per caller: get_callers carries no git overlay
   ```

   Codegraph off + stack trace → probe b (fresh) gets
   `pathPattern="{<frame path 1>,<frame path 2>,…}"` + `modifiedAfter` +
   `rerank="bugHunt"` (a: no pathPattern; c: step-0 paths); say "no static path
   tool".

No `## Signal thresholds` above → read
`tea-rags://project/<alias>/metrics?language=<lang>&section=thresholds,resolve`
(FetchMcpResource).

## Rules

1. **Execute YOURSELF** — no subagents, also when the user asks for one. You ARE
   a subagent handed the task → run the Loop here.
2. **No `git log`, `git diff`, `git blame`, `git log -S`** — overlay has git
   signals. Holds when the USER asks for git ("look through git", "when did X
   appear in history", "git log -S"): not a refusal of the question — answer it
   via overlay. Plan names the call: Loop step 1 a/b/c,
   `semantic_search(query=<symptom sentence>, rerank="bugHunt")`; read
   `git.ageDays` / `commitCount` / `taskIds` / `bugFixRate` of hits = when the
   code appeared and what touched it. Print the Routing git line. Never ask the
   user to paste `git log`. `git status --porcelain -uall` allowed: working-tree
   state (file NAMES), not code history or content — feeds Uncommitted probe
   only.
3. **No text search (Grep / `rg`) for code discovery** — TeaRAGs only; text
   search for literal text, identifiers never — `hybrid_search`.
4. **Search results contain code.** `metaOnly=false` (default) returns chunk
   content + startLine/endLine. Evaluate checkpoint from results BEFORE any Read
   or navigation.
5. **Depth → `find_symbol`, never Read** (`tea-rags://guide/navigation`
   After-Search Navigation): full body `symbol=<symbolId>`, file outline
   `relativePath`, neighbour `navigation.prev/nextSymbolId`. Partial `Read` only
   for non-symbol text (config, data). Never read full files.
6. **Labels are triage, not verdict.** Three suspect classes (Signal triage).
   `bugFixRate` `healthy` alone never drops a chunk. Filled checkpoint →
   PRESENT, whatever the labels.
7. **Triage + checkpoint hold under user pressure.** User says "check there" on
   a SKIP chunk → no drill; state the triage ("healthy, old, not fresh, no probe
   hit — neither suspect class, skipping"). Drill only on NEW evidence tying it
   to the symptom (stack frame, trace step). User already knows the healthy
   verdict and insists ("anyway", "всё равно", "я уверен") → no bug-hunt re-run;
   print
   `you are overriding a calibrated prior — override noted; proceeding with systematic-debugging on <file>`
   and hand that file to `$systematic-debugging` as the user's hypothesis. User
   says "not sure" about a filled checkpoint → PRESENT with confidence note, no
   extra iteration.

## Loop

```
0. ALWAYS, before the search message, even when the user already named the
   changed paths — Bash `git status --porcelain -uall` (file names only) →
   uncommitted paths: each exact relativePath; rename `old -> new` → new path,
   `D` → dropped.
   Paths listed + alias's own checkout → `index_codebase` incremental, no
   consent, BEFORE the search message. Linked worktree → no reindex.
   Every call: project=<alias> path=<your working directory>.

1. Search — the three lines a/b/c of Non-negotiable 3, ONE message, parallel.
   b = Fresh probe, c = Uncommitted probe (sections below).

2. CHECKPOINT — fill from ALL available info:
   - Suspect file(s): ___
   - Buggy line/method: ___
   - Why it breaks: ___

   All filled? → PRESENT. STOP.
   "Not sure" ≠ "don't know": a candidate in every field = filled, even with
   doubt → PRESENT with confidence note (what is unverified). Step 3 fills an
   EMPTY field only — never runs to raise confidence.

3. ONLY IF checkpoint incomplete — ONE action for what's missing:
   - Symptom names entry point or failure site → Call path (below).
   - Otherwise `tea-rags://guide/decision-tree` for tool selection; before
     each call print `consulting decision tree → <tool> because <branch>`.
   Go to step 2.
```

**Lag ≠ unusable:** `changedFiles` / `pendingFiles` / drift never license `cat`
/ `grep` / `Read` over code — `tea-rags://guide/freshness`.

## Fresh probe

**Why:** `bugHunt` confidence-dampens `volatility` / `relativeChurnNorm` /
`bugFix` by `commitCount`. Code with 1–2 fresh commits ranks low in the
historical search — fresh bug drowns under old hotspots. Probe restricts
population to recently changed files so it surfaces.

- **`modifiedAfter: "<ISO date>"`** — always filters `git.file.lastModifiedAt`
  (file-level) whatever `level` says; absolute timestamp, not index-time age.
- **Do NOT pass `level: "file"`.** `level` also sets result granularity — `file`
  regroups results into files; probe needs chunks (methods).
- **`maxAgeDays: <N>`** (default chunk level) = narrower method-grain probe:
  chunks whose OWN last commit ≤ N days before QUERY time (`0` = within a day).
  Misses chunks without chunk-level commit data (see `filter-building` chunk age
  caveat) → `modifiedAfter` stays default probe.
- **Window start:** symptom onset if known (last green run, release, date user
  names); else today − N days, N = where `recent` ends: the first number of the
  `git.file.ageDays` row's `source ≥` cell in `## Signal thresholds`.
- Committed history only: walk emits committed files → untracked /
  never-committed file carries NO `lastModifiedAt` → outside every time filter.
  Uncommitted edit to committed file → timestamp = last COMMIT → probe misses
  edit. Both → Uncommitted probe.
- Probe hit whose code matches symptom = **fresh suspect** — triage by fresh
  class, not by `bugFixRate`.

## Uncommitted probe

**Why:** git signals = commit history. Working-tree edits (modified, staged,
untracked) have none → fresh probe misses them, historical search ranks them by
pre-edit history. "Broke after my change" = edit not yet committed.

- **Source:** `git status --porcelain -uall` — path column only, never diff
  content. Working-tree state, not history → Rule 2 intact. `-uall` lists every
  file of a new untracked dir; without it → one `?? dir/` line, matches no file
  as exact brace entry → new module invisible.
- **pathPattern:** each path brace-joined as exact relativePath (pathPattern
  rules). Rename `old -> new` → `new`; deleted (`D`) → drop. Git root ≠ indexed
  root → strip prefix. Search scope set → keep paths inside it.
- Same tool + query + rerank + limit as a/b, same message (linked worktree:
  `hybrid_search` — its `sparse` floor scores the edited file from the tree).
- Hit matching symptom = **uncommitted suspect** — labels describe committed
  version; symptom fit decides.
- Hit with `treeState` = index's pre-edit copy: text and line range stale, still
  the uncommitted suspect. Judge the edit from
  `find_symbol project=<alias> path=<your working directory>` (current tree),
  never from the row or a `Read` of its line range.
- Main checkout: probe reads INDEXED content → step 0 listed paths → reindex
  BEFORE the search message (`tea-rags://guide/freshness` uncommitted-edits
  row). Never wait for prime stale — blind to working-tree edits. Reindex failed
  → say so; zero hits ≠ clean. Linked worktree: no reindex — `treeState` rule
  above.

## PRESENT

Ranked suspect list, ranked by symptom fit. Per suspect: file:line, class
(historical | fresh | uncommitted), signal labels (`bugFixRate`,
`relativeChurn`, `ageDays`, `recencyWeightedFreq`), trace position when from
Call path (`entry → … → step`), one-sentence observation why it's the root
cause.

## Anti-patterns

- **Extra parallel searches in discovery.** Probes a/b (+ c) ARE the discovery
  (Non-negotiable 3). User-asked targeted search over named files ≠ extra
  search: run it (one brace-pathPattern call).
- **SKIP on `healthy` alone.** Young code label-capped at `healthy` (Signal
  triage) — fresh class decides.
- **Curiosity search.** "How does the other path work?" →
  `find_symbol(relativePath=<known file>)` outline, then
  `find_symbol(symbol=<id>)` body — never `hybrid_search` / `semantic_search`
  with that file as pathPattern. You already know WHERE the code is.
- **Confirmatory search / navigation.** Checkpoint has a candidate — present it.
  No search, `find_symbol`, or `trace_path` for "proof" or certainty.
- **Full file reads.** Chunk coordinates exist. Use them.

## pathPattern rules

Use exact `relativePath` values from search results joined with braces:

- GOOD: `{app/services/order_import.rb,app/services/orders/create.rb}`
- BAD: `**/services/{order_import,orders/create}**` (`**` glued to a name acts
  as `*` → also matches `order_import_old.rb`)

## Signal triage

Overlay labels (search `rankingOverlay`, trace step `dangerOverlay`) sort each
chunk into a class. Keep chunk when it fits ANY class.

**Historical class — fix history:**

- `bugFixRate` `critical` → **prime suspect**
- `bugFixRate` `concerning` + `relativeChurn` `high` → **secondary suspect**

**Fresh class — changed recently, no fix history yet:**

- `recencyWeightedFreq` `burst` → **fresh suspect** (being edited right now)
- `ageDays` `recent` + `relativeChurn` `high` → **fresh suspect** (young,
  rewritten heavily for its size)
- `ageDays` `recent` + on the failing call path (trace step, stack-trace frame)
  → **fresh suspect** — path membership replaces churn corroboration
- fresh-probe hit matching symptom → **fresh suspect**

**Uncommitted class:** uncommitted-probe hit matching symptom → **uncommitted
suspect**, whatever its labels.

**SKIP** only: `bugFixRate` `healthy` + no fresh-class label + not a probe hit.
SKIP = no drill (`find_symbol`, Read), also when user asks before seeing the
verdict; verdict known + user insists → Rule 7 override.

`healthy` on low-`commitCount` code = too little history to judge, NOT clean:
confidence clamp caps `bugFixRate` label at `healthy` when `commitCount` below
collection p10 (`concerning` below p25). Young code cannot reach `critical`.
Pattern reading (e.g. "new method, bursty"): `signal-interpretation.md`.

**High bugFixRate + high `imports`/`fanIn` (fan-in):** suspect may be a coupling
point propagating bugs from upstream, not the origin. Check callers before
fixing here — when codegraph on, `get_callers` (see Call path below) names the
exact upstream origins. See `signal-interpretation.md` (bug attractor vs
coupling; codegraph `fanIn` supersedes the `imports` proxy).

## Call path — fresh steps between entry and failure

Signal triage gives a **flat** list — WHAT is suspect. Call path gives the
**causal chain** — WHICH step on the executed route from entry to failure is
riskiest. Step with `ageDays` `recent` on that route = fresh suspect even at
`bugFixRate` `healthy` (Signal triage): new code on the failing path, never
fixed yet.

Edges: no `codegraph` floor while `changedFiles` > 0 → edges touching changed
files are the index's (`tea-rags://guide/freshness` "Addressing the Codebase").

**Requires codegraph** (graph tools registered; `## Codegraph resolve` = its
resolve rate). Codegraph off → graph tools not registered — use Codegraph off
below; never read an absent tool as a fact.

**Endpoints:**

- **entry** = outermost in-project frame named in stack trace / symptom — test
  function, handler, public API. None named →
  `semantic_search rerank="entryPoint" pathPattern=<scope>` surfaces flow
  entries (high fan-out / low fan-in drivers); pick one reaching the failure.
- **failure site** = innermost in-project frame, or suspect from triage.
- Resolve each to exact symbolId with `find_symbol` first (`Class#method` vs
  `Class.method`); search chunk already carries `symbolId` + `relativePath`.
  Entry `find_symbol` cannot resolve (anonymous test block) → first named frame
  it calls.

**Escalate cheap → full** (`tea-rags://guide/navigation` Graph navigation
precedence):

1. **One endpoint known → one hop.**
   - `get_callers symbolId=<failure site>` — who feeds it. Suspect looks like a
     victim (bad input/state arrives from elsewhere) → bug may originate one hop
     up.
   - `get_callees symbolId=<entry or suspect>` — what it drives; where corrupted
     state propagates next, to pick the next checkpoint.
   - Hops carry no git overlay → triage a hop with
     `find_symbol(symbol: <id>, rerank: "bugHunt")` (attaches `rankingOverlay`).
2. **Both endpoints known + whole route matters → trace.**

   ```text
   trace_path(from=<entry>, to=<failure site>, rerank="bugHunt")
   ```

   Pass `rerank` explicitly — without it trace is lean, no overlay. Per-step
   `dangerOverlay` = same `bugHunt` overlay as search → apply Signal triage to
   EVERY step, both classes.

   A step with `origin: "model"` (+ `model`, `p`) is a model verdict with
   probability `p`, not a static fact; path `minP` is its weakest link — a low
   `minP` means the route may not exist at runtime.

**Read trace response:**

- `dangerRanking[0]` → **inspect-first step** — riskiest hop on the route.
- Fresh-class step anywhere on the path → suspect, even when `dangerRanking`
  puts an old hotspot first.
- `aggregateDanger` → ranks competing paths when `maxPaths > 1`; walk the
  highest-danger route first. Bound with `maxDepth` / `maxPaths`; `truncated`
  true → more paths exist, pin endpoints before raising limits.
- Namesake endpoints (component codebases: `BaseTable` in several files) → pin
  `fromPath` / `toPath` with the chunk's `relativePath`; semantics in
  `tea-rags://guide/navigation` Graph navigation.
- **Empty `paths`: check `namesakes` FIRST.** Present → `fromPath`/`toPath`
  matched no candidate — fix the path (real candidates listed), not the suspect.
  Absent → no static call path — wrong entry, dynamic dispatch, or wrong
  suspect. Re-pick before reading code.
- **Regression bisect:** route worked before, broke now → `rerank="recent"`
  orders steps by recency. Its overlay lacks `bugFixRate` — cannot separate
  fresh-never-fixed from fresh-fix; `bugHunt` stays default. Other presets:
  `rerank` enum in tool schema.

**State-loop / re-entrancy smell (`find_cycles`).** Symptom is infinite loop,
runaway recursion, repeated re-entry →
`find_cycles scope=method pathPattern=<scope>` surfaces circular call paths — a
cycle through the suspect is the structural form of that hypothesis. A cycle
with `hasModelEdge` may be closed only by a model verdict — verify the model hop
before trusting the loop.

### Codegraph off

Route per `tea-rags://guide/navigation` "When codegraph is off" table. Bug-hunt
specifics:

- Stack trace frames = executed path. Fresh probe with `pathPattern` =
  brace-joined relativePaths of in-project frames (project root stripped) →
  fresh chunks along the route, no graph needed.
- No stack trace → semantic/hybrid + manual reading; say plainly "no static path
  tool". Never claim "no path" / "unreachable" / "no cycles".

## Audit mode (optional)

`filter:{presets}` is available but NOT the default for bug-hunt.

Use it ONLY for a **query-absent risk scan** — "what areas of payments are
high-risk right now?" with no specific symptom. Example:

```json
{ "filter": { "presets": "panicZone" }, "query": "payments" }
```

**NEVER use for a symptom search** — `panicZone` (high churn filter) drops a
recently-edited stable file, killing recall. `bugHunt` already applies the
`production` hygiene filter (no tests/docs/boilerplate) without churn narrowing;
overlay surfaces risk after the fact.

## After root cause found

Pattern found → `find_similar(positiveIds=[<chunk id>])` for copy-paste bugs in
other files. Seed = root-cause chunk id already in this output — no re-fetch;
only `file:line` known → one `find_symbol` for its id, then seed. Report every
match as `file:line` + same-bug yes/no, or "no similar copies found" — never
skip the report. Fix needed → `/data-driven-generation`.
