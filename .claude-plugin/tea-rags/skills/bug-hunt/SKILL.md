---
name: bug-hunt
description:
  Find source of concrete failure — rank historically buggy code (high
  bugFixRate + churn) AND freshly changed never-fixed code (committed or still
  uncommitted) against symptom. Triggers on "debug X", "why does Y fail", "test
  fails", "stack trace says Z", "падает", "почему не работает". NOT for code
  health scanning without a specific symptom — use risk-assessment for that.
argument-hint: [bug description or symptom]
---

# Bug Hunt

Signal-driven root-cause investigation via TeaRAGs git signals. Three suspect
populations: code with bug-fix history, fresh code too young to have one,
uncommitted edits with no git signal yet.

## Rules

1. **Execute YOURSELF** — no subagents.
2. **No `git log`, `git diff`, `git blame`** — overlay has git signals.
   `git status --porcelain -uall` allowed: working-tree state (file NAMES), not
   code history or content — feeds Uncommitted probe only.
3. **No built-in Search/Grep for code discovery** — TeaRAGs + ripgrep MCP only.
4. **Search results contain code.** `metaOnly=false` (default) returns chunk
   content + startLine/endLine. Evaluate checkpoint from results BEFORE any Read
   or navigation.
5. **Partial reads only.**
   `Read(path, offset=startLine, limit=endLine-startLine)` using coordinates
   from results. Never read full files.
6. **Labels are triage, not verdict.** Three suspect classes (Signal triage).
   `bugFixRate` `healthy` alone never drops a chunk. Filled checkpoint →
   PRESENT, whatever the labels.

## Loop

```
0. `git status --porcelain -uall` → uncommitted paths (see Uncommitted probe).
   Paths listed → `index_codebase` (incremental, no consent) BEFORE step 1.

1. Search — ONE message, parallel calls. Same tool (search-cascade),
   same query, rerank="bugHunt", limit=10:
   a. Historical — scope pathPattern, no time filter.
   b. Fresh probe — scope pathPattern + modifiedAfter=<window start>
      (see Fresh probe).
   c. Uncommitted probe — pathPattern = step-0 paths. Step 0 empty → skip.

2. CHECKPOINT — fill from ALL available info:
   - Suspect file(s): ___
   - Buggy line/method: ___
   - Why it breaks: ___

   All filled? → PRESENT. STOP.
   "Not sure" ≠ "don't know" — present with confidence note.

3. ONLY IF checkpoint incomplete — ONE action for what's missing:
   - Symptom names entry point or failure site → Call path (below).
   - Otherwise search-cascade for tool selection.
   Go to step 2.
```

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
  names); else today − N days, N = `recent` bound of `git.file.ageDays` in prime
  `## Signal thresholds`.
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
- Same tool + query + rerank + limit as a/b, same message.
- Hit matching symptom = **uncommitted suspect** — labels describe committed
  version; symptom fit decides.
- Probe reads INDEXED content → step 0 listed paths → incremental
  `index_codebase` BEFORE the search message, always (no consent —
  index-freshness). Never wait for prime stale: prime staleness is time-based,
  blind to working-tree edits → edit an hour after last index = probe returns
  pre-edit chunks at stale line ranges, Rule 4 judges old code. Reindex failed →
  say so; zero hits ≠ clean.

## PRESENT

Ranked suspect list, ranked by symptom fit. Per suspect: file:line, class
(historical | fresh | uncommitted), signal labels (`bugFixRate`,
`relativeChurn`, `ageDays`, `recencyWeightedFreq`), trace position when from
Call path (`entry → … → step`), one-sentence observation why it's the root
cause.

## Anti-patterns

- **Extra parallel searches in discovery.** Historical + fresh probe (+
  uncommitted probe when `git status` lists paths) IS the discovery — no other
  query variant. ONE query finds the area. Returns batch_create AND jobs/create
  — both suspects already found.
- **SKIP on `healthy` alone.** Young code label-capped at `healthy` (Signal
  triage) — fresh class decides.
- **Curiosity search.** "How does the other path work?" → Read or LSP, not
  search. You already know WHERE the code is.
- **Confirmatory search.** Checkpoint has a candidate — present it. Don't search
  for "proof." Confirmatory searches almost never change the answer.
- **Full file reads.** Chunk coordinates exist. Use them.

## pathPattern rules

Use exact `relativePath` values from search results joined with braces:

- GOOD: `{app/services/batch_create.rb,app/services/jobs/create.rb}`
- BAD: `**/services/{batch_create,jobs/create}**` (`**` glued to a name acts as
  `*` → also matches `batch_create_old.rb`)

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

**Requires codegraph** (prime `## Enrichment` lists `codegraph.symbols`).
Codegraph off → graph tools not registered — use Codegraph off below; never read
an absent tool as a fact.

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

**Escalate cheap → full** (search-cascade Graph navigation precedence):

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

**Read trace response:**

- `dangerRanking[0]` → **inspect-first step** — riskiest hop on the route.
- Fresh-class step anywhere on the path → suspect, even when `dangerRanking`
  puts an old hotspot first.
- `aggregateDanger` → ranks competing paths when `maxPaths > 1`; walk the
  highest-danger route first. Bound with `maxDepth` / `maxPaths`; `truncated`
  true → more paths exist, pin endpoints before raising limits.
- Namesake endpoints (component codebases: `BaseTable` in several files) → pin
  `fromPath` / `toPath` with the chunk's `relativePath`; semantics in
  search-cascade Graph navigation.
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
cycle through the suspect is the structural form of that hypothesis.

### Codegraph off

Route per search-cascade "When codegraph is off" table. Bug-hunt specifics:

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

**NEVER use for a symptom search.** A bug may live in a recently-edited stable
file that `panicZone` (high churn filter) would exclude — killing recall. The
ranking already handles triage: `bugHunt` preset defaults to `production`
hygiene filter (excludes tests/docs/boilerplate) without narrowing on churn. Let
the query drive discovery; the overlay surfaces risk signals after the fact.

## After root cause found

Pattern found → `find_similar` from chunk ID for copy-paste bugs in other files.
Fix needed → `/tea-rags:data-driven-generation`.
