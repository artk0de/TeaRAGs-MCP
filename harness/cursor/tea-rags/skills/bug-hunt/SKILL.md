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
  history", "когда появилась ошибка ''X''", "read the whole file" / "прочитай
  весь файл" of a search hit, "падает". NOT for code history without an error
  string or failure ("when did X change", "посмотри через git" alone) — core
  routing answers it. NOT for code health scanning without bug intent — use
  risk-assessment for that.'
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
    `find_symbol(path=<cwd>, symbol=<name>)` body; several named → ONE
    `find_symbol(path=<cwd>, symbols=[<names>])`
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
  ends at the code-search hit — find_symbol follows it; print this ONE line,
  slots filled:
  `Grep tool "<phrase>" <dir> (literal, line cap) → find_symbol(path=<cwd>, relativePath=<hit file>) outline → find_symbol(path=<cwd>, symbol=<enclosing symbolId>) body`.
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
   probe hit — neither suspect class, skipping". `healthy` on low-`commitCount`
   code = too little history to judge, NOT clean (confidence clamp). Label
   semantics, clamp, fan-in coupling: `references/triage.md`.
5. **Checkpoint filled → PRESENT. STOP.** "Want to be sure" / "not fully sure" →
   no search, no extra iteration; the answer prints both lines:

   ```
   No confirmatory search: confirmatory searches almost never change the answer.
   Confidence note: <what is unverified> — "not sure" ≠ "don't know"; presenting the suspect as is.
   ```

6. **Chunk or code-search hit in hand → `find_symbol`** (symbolId body /
   relativePath outline / prev-next id), never Read of a code file. "Read the
   whole file" → Routing row 1, both lines. Row with `treeState` = index's
   PRE-EDIT copy (text + lines stale) — say so; it stays the **uncommitted
   suspect**, no symptom needed: `healthy` history never clears uncommitted
   code. Next call = `find_symbol(path=<cwd>, symbol=<id>)`; several suspects /
   hits → ONE `find_symbol(path=<cwd>, symbols=[<ids>])` (core Invariants),
   never one call each — never a re-run of probes a/b/c.
7. **Call path** (codegraph on). Stack trace / symptom names an entry AND the
   failure site (outermost frame = from, failing frame = to) → this branch
   first, never `get_callers`; the plan prints these three lines verbatim, frame
   ids filled — the triage line is its own line, never folded into the call:

   ```
   find_symbol(path=<cwd>, symbols=[<entry frame>, <failure frame>]) → <entry id>, <failure id>
   trace_path(from=<entry id>, to=<failure id>, rerank="bugHunt")
   two-class triage of EVERY step's dangerOverlay: step ageDays recent = fresh suspect even at bugFixRate healthy and behind an old dangerRanking[0]
   ```

   Only the failure site known ("<symbol> gets undefined — where from?") → one
   hop, never `trace_path` with a guessed entry; plan prints, id filled:

   ```
   find_symbol(path=<cwd>, symbol=<failure frame>) → <failure id>
   get_callers(symbolId=<failure id>)
   find_symbol(path=<cwd>, symbols=[<caller ids>], rerank="bugHunt") — ONE call for all callers: get_callers carries no git overlay
   ```

   Codegraph off + stack trace → probe b (fresh) gets
   `pathPattern="{<frame path 1>,<frame path 2>,…}"` + `modifiedAfter` +
   `rerank="bugHunt"` (a: no pathPattern; c: step-0 paths); say "no static path
   tool". Off is decided, not checked, when THIS request says so or graph tools
   are absent from your tool list: print
   `codegraph off (source: <request|tool list>) — no static path tool available`
   as a statement, never "if codegraph is off" / "check the registry". Reading
   the trace / callers response (empty `paths`, `namesakes`, `dangerRanking`,
   model edges, regression bisect, loops → `find_cycles`):
   `references/call-path.md`.

No `## Signal thresholds` table in the output above → read
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
   state (file NAMES), not code history or content — feeds probe c only.
3. **No text search (Grep tool) for code discovery** — TeaRAGs only; text search
   for literal text, identifiers never — `hybrid_search`.
4. **Search results contain code.** `metaOnly=false` (default) returns chunk
   content + startLine/endLine. Evaluate checkpoint from results BEFORE any Read
   or navigation.
5. **Depth → `find_symbol`, never Read** (`tea-rags://guide/navigation`
   After-Search Navigation): full body `symbol=<symbolId>`, file outline
   `relativePath`, neighbour `navigation.prev/nextSymbolId`. Partial `Read` only
   for non-symbol text (config, data). Never read full files.
6. **Labels are triage, not verdict.** Three suspect classes (Non-negotiable 4).
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
   Window start (probe b): symptom onset if known (last green run, release,
   date user names); else today − N days, N = first number of the
   `git.file.ageDays` row's `source ≥` cell in `## Signal thresholds`. Probe
   edge cases (`maxAgeDays`, untracked files, `treeState`, rename / `D`):
   `references/probes.md`.

2. CHECKPOINT — fill from ALL available info:
   - Suspect file(s): ___
   - Buggy line/method: ___
   - Why it breaks: ___

   All filled? → PRESENT. STOP.
   "Not sure" ≠ "don't know": a candidate in every field = filled, even with
   doubt → PRESENT with confidence note (what is unverified). Step 3 fills an
   EMPTY field only — never runs to raise confidence.

3. ONLY IF checkpoint incomplete — ONE action for what's missing:
   - Symptom names entry point or failure site → Non-negotiable 7 lines.
   - Otherwise `tea-rags://guide/tool-choice` for tool selection; before
     each call print `consulting decision tree → <tool> because <branch>`.
   Go to step 2.
```

**Lag ≠ unusable:** `changedFiles` / `pendingFiles` / drift never license `cat`
/ `grep` / `Read` over code — `tea-rags://guide/freshness`.

## PRESENT

Ranked suspect list, ranked by symptom fit. Per suspect: file:line, class
(historical | fresh | uncommitted), signal labels (`bugFixRate`,
`relativeChurn`, `ageDays`, `recencyWeightedFreq`), trace position when from the
call path (`entry → … → step`), one-sentence observation why it's the root
cause.

## pathPattern rules

Use exact `relativePath` values from search results joined with braces:

- GOOD: `{app/services/order_import.rb,app/services/orders/create.rb}`
- BAD: `**/services/{order_import,orders/create}**` (`**` glued to a name acts
  as `*` → also matches `order_import_old.rb`)

## After root cause found

Pattern found → `find_similar(positiveIds=[<chunk id>])` for copy-paste bugs in
other files. Seed = root-cause chunk id already in this output — no re-fetch;
only `file:line` known → one `find_symbol` for its id, then seed. Report every
match as `file:line` + same-bug yes/no, or "no similar copies found" — never
skip the report. Fix needed → `/data-driven-generation`.
