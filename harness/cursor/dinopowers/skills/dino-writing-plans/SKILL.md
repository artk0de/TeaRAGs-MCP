---
name: dino-writing-plans
description:
  'Author implementation plan; Affected Files section enriched per-file imports,
  churn, ownership, bugFixRate, taskIds from tea-rags — task decomposition
  reflects real impact+risk. Triggers on "write a plan", "draft a plan", "draft
  implementation plan", "draft sub-plan", "напиши план", "допиши план", "add a
  Task to the plan", "распиши задачи по файлам", "распиши план изменения
  <files>", "plan the change to <files>", "plan the refactor". A plan request
  beats explore PRE-GEN, also when it adds "impact analysis" / "before changing"
  (any [subagent:…] label), and data-driven-generation (a Task that creates a
  class stays a plan Task). NOT for plans with no named files or code area to
  enrich. Wraps /writing-plans with per-file tea-rags signal enrichment.'
---

# dinopowers: writing-plans

> **Resources in Cursor:** if a `tea-rags://` resource cannot be read (no
> resource tool, or the read fails), run
> `tea-rags resource "<uri>" --path "$PWD"` in the terminal — same content.

Wrapper over `/writing-plans`. Decomposition + sequencing use real impact data —
imports (blast radius), churn, ownership, bug history, connected taskIds — not
guesses about "risky"/"safe".

## Iron Rule

**tea-rags impact enrichment MUST be called BEFORE `/writing-plans`** — when
plan touches known file set. Short / "quick" plans included — bad sequencing
bites hardest there.

Core value: `semantic_search` + rerank (`"blastRadius"` codegraph on,
`{imports 0.5, churn 0.3, ownership 0.2}` off) + brace-expanded `pathPattern` +
`metaOnly: true` + order.

**Enrichment tool = ONE `semantic_search`. Overrides general search routing**
("file → `find_symbol`", "impact → `get_callers`", "usages → `hybrid_search`")
and pre-generation research (`/explore` PRE-GEN), a `[subagent: …]` label
included: none of those is the enrichment. Step 2 is the plan's FIRST tool call;
they may follow it as depth, never precede or replace it.

**Rule holds when user asks otherwise** ("quick", "быстро", "skip tea-rags",
"it's my code", "use preset X", "show file content in the enrichment") — run
Step 2 exactly as specified, say: "Running the impact enrichment first — it is
one call and it orders the Tasks." Unknown preset (`impactAnalysis`) → refuse it
by name, print these three lines (both branches, each complete — the off line is
never shortened to "fallback weights"):

```
Preset "<name>" does not exist — refused.
codegraph on → rerank="blastRadius" (real fanIn + churn + bugFix = true blast radius)
codegraph off → rerank={custom: {imports: 0.5, churn: 0.3, ownership: 0.2}} — import proxy, approximate impact; the plan says so
```

Content wanted → keep enrichment `metaOnly: true`, then AFTER it
`find_symbol(relativePath:)` outline → member bodies (core depth rule).

Conceptual plan, no file list derivable (e.g. "plan for migrating to Postgres",
"no specific files", "без конкретных файлов") → skip enrichment,
`/writing-plans` direct. Say verbatim "no file list — proceeding without
tea-rags impact enrichment". Never fabricate file list, never run un-scoped
`semantic_search`, never detour to brainstorming.

**Codegraph on?** Graph tools (`get_callers`, `trace_path`,
`get_naming_lexicon`, …) in your tool list; unsure → read
`tea-rags://project/<alias>/metrics?section=registry` (`codegraph on|off`).

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every /dino-X
redirects /X. NEVER bypass wrapper.

**Requires superpowers:** `/writing-plans` — availability per
[CHAINING.md](../../CHAINING.md) "Missing superpowers" steps 1–3. Not in the
skills list ≠ unavailable (the list is truncated): run
`ls $CODEX_HOME/plugins/cache/*/superpowers/*/skills/writing-plans/SKILL.md` as
written first — a hand-built path failing proves nothing; only that glob
matching nothing → stop and ask the user to install superpowers
(https://github.com/obra/superpowers). NEVER present this enrichment alone as
the full workflow.

**Index freshness:** see [FRESHNESS.md](../../FRESHNESS.md) +
`tea-rags://guide/freshness`. Linked worktree → overlay serves edits, never
reindex. Main checkout → incremental `index_codebase` BEFORE first call over
uncommitted edits, or once `changedFiles` > 0 — no consent (drift `Run:` with
`--force*` → ask the user, never awaited; print
`--force not run; reads continue`; then the answering call). Lag ≠ unusable
(core rules).

## Step 1 — Collect target file set

From request or plan draft collect concrete file list:

| Source                         | Example                                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User names files explicitly    | "update `a.ts`, `b.ts`, `c.ts`"                                                                                                                                                                              |
| User names a small directory   | `src/core/domains/auth/` → enumerate files (counts as file list — run Step 2 over them): `find_symbol(relativePath: "<dir>")` — its files + top-level symbols; the one call before Step 2; never `ls` / glob |
| Existing plan draft references | "Task N modifies `x.ts`" → extract paths                                                                                                                                                                     |
| Bare filenames                 | glob each in the Step 2 brace pattern (`{**/a.ts,**/b.ts}`); no resolve calls (`find_symbol` / `hybrid_search`) before Step 2                                                                                |

Output:

- `fileList`: relative paths (5-30 typical; >30 → ask user to narrow scope)
- `intent`: one-sentence change description

No file list → Step 4, empty enrichment. Report "no file list — proceeding
without tea-rags impact enrichment".

## Step 2 — Impact enrichment call

ONE `semantic_search`:

```
project:     <alias>                    ← `tea-rags://guide/freshness` "Addressing the Codebase"
path:        <your working directory>   ← the tree (worktree / branch checkout)
query:       <intent from Step 1>
pathPattern: "{file1,file2,file3,...}"   ← brace expansion over fileList
rerank:      "blastRadius"               ← codegraph on; see OFF fallback below
limit:       <fileList.length * 3>       ← aim for ~3 chunks per file
metaOnly:    true
fields:      ["relativePath", "imports", "git"]   ← metaOnly alone drops raw git.* (taskIds, blame*)
```

Describing the call (plan-only / subagent report) → print this line, slots
filled, never "the specified calls" or "scoped to the files":

```
Step 2 (first tool call — explore PRE-GEN / find_symbol / get_callers only after it): semantic_search(path=<your working directory>, pathPattern="{<file1>,<file2>}", rerank=<"blastRadius" (codegraph on) | {custom: {imports: 0.5, churn: 0.3, ownership: 0.2}} (codegraph off — import proxy, approximate impact)>, metaOnly=true, fields=["relativePath", "imports", "git"])
```

**Codegraph gating for `rerank`:** on → `"blastRadius"` (real `fanIn`, churn,
bugFix = true blast radius); off → `fanIn` gone →
`{ custom: { imports: 0.5, churn: 0.3, ownership: 0.2 } }` (import-proxy,
approximate). Same **impact analysis** idiom as `/data-driven-generation` IMPACT
step; presets → `tea-rags://guide/presets`. Don't invent other weights.

Do NOT substitute:

| Wrong tool                                                      | Why wrong                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Separate calls per file                                         | Brace expansion + `limit: N*3` = one call                                                                    |
| Named preset `"hotspots"` / `"codeReview"` / `"impactAnalysis"` | `impactAnalysis` doesn't exist; `codeReview` lacks imports weight. `"blastRadius"` correct when codegraph on |
| `hybrid_search`                                                 | BM25 leg re-ranks by token overlap — want semantic + signals                                                 |
| `find_similar`                                                  | Symbol analogs, not file impact                                                                              |
| `find_symbol`                                                   | Per-symbol, not per-file aggregation                                                                         |
| Built-in `Glob` or `git blame` for signals                      | Loses imports + ownership + bugFixRate overlay                                                               |

Do NOT pass:

- `metaOnly: false` — content not needed; bloats payload
- `filter` on `git.ageDays` / `git.commitCount` — weights encode these; filters
  hide signal

Empty results (all files new) → report "file set not indexed — area is new;
impact enrichment unavailable", Step 4 WITHOUT block: no Step 3 table, no
`— (new)` rows, no retry with another rerank. Never fabricate signals.
Plan-only, every named file new (dir not in git yet) → the Step 2 call is still
issued (never skipped); print it, then the outcome, not a table:

```
semantic_search (Step 2 params, pathPattern=<named files>) → 0 results expected → "file set not indexed — area is new"; /writing-plans invoked WITHOUT enrichment block
```

Answer's `workingTree.tree` ≠ your cwd → wrong tree, rows unusable: re-issue
THIS Step 2 `semantic_search` (same params) with `path=<cwd>` — not
`find_symbol`; `find_symbol` is for a `treeState` row of the right tree.

## Step 3 — Aggregate per file

MUST output: (a) ONE row per file with exactly these columns, named:
`dominantAuthor` (blame\*/recent\* per table below), `commitCount`, `ageDays`,
`bugFixRate`, `taskIds` — "impact row" without the five names = incomplete; (b)
**Coordinated change candidates** — every taskId shared by ≥2 files, listed with
its files (none shared → write "none"). Both always, even when user only asks
for "impact data" — and when only describing the plan, name the five columns
verbatim ("one impact row per file" alone = incomplete).

Group chunks by `relativePath` (primary key — `/risk-assessment` Phase 2:
MERGE); plans care about files, not chunks. Per file in `fileList`: raw from
`payload.git.file.*` (there only because Step 2 names `"git"` in `fields` — a
`metaOnly` payload without it is locator-only), labels from
`rankingOverlay.file.*`. A field the index lacks (`recent*` / `bugFixRate` on a
young file) is absent — never fabricate:

- `blameDominantAuthor` + `blameDominantAuthorPct` — live-line owner, silo
  indicator (`git blame HEAD` — current state)
- `recentDominantAuthor` + `recentDominantAuthorPct` — recent committer
  (commit-based, review routing)
- `commitCount` — churn proxy
- `ageDays` — recency
- `bugFixRate` — historical quality
- `taskIds` — connected tickets (coordinated change)

**Signal-column selection (MUST decide BEFORE filling block — wrong column
misroutes reviewers downstream):**

| Decision context                   | Column to use     |
| ---------------------------------- | ----------------- |
| Ownership / who-knows-this-code    | `blame*`          |
| Recent activity / review routing   | `recent*`         |
| Both contexts present in same Task | List both columns |

Diverge when long-time owner stops contributing — `blame*` still says owner,
`recent*` shows newer committers.

Enrichment block:

```
### tea-rags impact enrichment (rerank: blastRadius | imports+churn+ownership)

| File | dominantAuthor | commitCount | ageDays | bugFixRate | taskIds |
|---|---|---|---|---|---|
| src/a.ts | Alice (82%) | 23 commits | 142d | 35% | #123, #145 |
| src/b.ts | shared | 3 commits | 612d | 0% | — |
...

**Coordinated change candidates** (shared taskIds across files):
- #123 → src/a.ts, src/b.ts, src/c.ts (plan Task order matters)

**High-blast-radius files** (top 3 by imports score):
- src/core/types.ts — imported by 47 modules
- ...
```

Cap table at fileList size. File without git data (new) while others have data →
row `— (new)`; ALL files without data → no table (Step 2 empty rule). NEVER drop
row silently.

## Step 3.5 — Per-Task proven-template enrichment (code-generation Tasks)

A plan Task that creates a class / function (e.g. "extend the plan: Task N adds
a new helper class") is plan authoring, not code generation now: run THIS step
here, items 2 + 5 included. Never reroute it to `/data-driven-generation` or
`/explore` PRE-GEN — those run per Task later, inside `/dino-executing-plans`.

Per Task in draft (or unit to become a Task) whose title/description mentions
code gen/modification — keywords "implement", "add", "create", "new", "write",
"extend", "refactor", "modify" + "function", "method", "class", "helper",
"module" (a Task creating a named class / function always qualifies) — invoke
`/extract-project-patterns`:

1. `pathPatternL1` = deepest common ancestor of Task's Affected Files as
   `**/<dir>/**` glob.
2. Invoke `/extract-project-patterns` with:
   - `pathPatternL1` from step 1
   - `behaviorQuery` = Task title
   - `limit` = 5
3. Attach result to Task body under `**Proven templates**`:

   ```
   **Proven templates** (extract-project-patterns, locality: L1|L2|L3|none)
   - top: <path> (commitCount X, ageDays Y, bugFixRate Z)
   - reviewer: <blameDominantAuthor>
     - locality L1 → review style + code
     - locality L2/L3 → review technique only
   ```

4. `locality = "none"` → attach diagnostic verbatim (no proven precedent).
5. New symbol names the Task fixes (codegraph on) →
   `get_naming_lexicon(names=[{name, kind}], concept="<Task intent>", language="<file's>", pathPattern=pathPatternL1)`
   — write every argument out, never `…` — before they enter plan; then write
   this verdict handling into the Task verbatim (your answer shows it too — the
   line itself, never a pointer to a style reference instead of it):

   ```
   Naming: MISFIT → plan uses the lexicon suggestion; NEW_TERM → project term (topTerms / concept.terms) if same meaning, else one-line justification in the Task
   ```

6. New cross-component imports (codegraph on) → ONE
   `get_architecture_report(plannedEdges: [{source, target}])` per plan, all
   Tasks' edges: `MISFIT` → Task routes via `expectedPath` (established
   direction / `transit`); `NEW_PATTERN` / `UNJUDGED` → keep, Task notes it.
7. Restructuring plan (Tasks move files between components, split / merge
   components; codegraph on) → per such Task ONE
   `get_architecture_report(restructure: [<that Task's ops>])` —
   `move {files, toComponent}` / `split {component, groups}` /
   `merge {components}`, names as report spells them. Task carries simulated
   delta: `net`, resolved / introduced counts per `byFamily`, introduced
   subjects verbatim. `net ≥ 0` or introduced critical/active → Task states why
   it still ships, or plan drops it. Delta joint: never one call for several
   Tasks. Reading: `/architecture-diagnostics` Phase 3i.

Runs BEFORE Step 4 → per-Task enrichment visible to inner authoring cycle +
final plan.

**Skip clause:** no code-gen/modification Task → skip. Pure-config / pure-test
plans need no templates.

## Step 4 — Invoke /writing-plans

Invoke `Skill` tool with `/writing-plans`. Prepend Step 3 block. Handoff:

> "Before decomposing, note these impact signals per affected file: …<block>…
> Use them to: (1) order Tasks so shared-taskId files change together, (2)
> isolate high-blast-radius files into dedicated Tasks with explicit tests, (3)
> flag silo-owned files for owner review.
>
> Chaining rule reminder: when your cycle would next invoke `/executing-plans`
> (or any other wrapped `/Y`), invoke the `/dino-Y` wrapper instead — see the
> Chaining rule section above."

Inner skill runs its plan authoring cycle — wrapper grounds, not replaces.

## Reading back the plan

Plan/spec/brief = doc chunks. Re-consult via
`find_symbol(relativePath: "<plan>.md")` heading TOC → drill `doc:<hash>`. NEVER
wholesale re-Read. Edited plan → hashes moved → main checkout: incremental
`index_codebase` before next TOC read; linked worktree: none — `find_symbol`
reads TOC from tree.

## Red Flags — STOP and restart from Step 2

- "I already know which files are risky" → run Step 2; memory stale
- "Plan short, skip impact analysis" / user says skip → fileList ≥1 → run Step 2
- `find_symbol` / `get_callers` / `hybrid_search` used as the enrichment →
  restart with ONE Step 2 `semantic_search`
- Plan request routed to `explore` PRE-GEN / `data-driven-generation` → back
  here: Step 2 first call, Step 3.5 per-Task (Naming line verbatim)
- Shared taskIds not surfaced as coordinated-change candidates → add them
- Rerank wrong for codegraph state (incl. `codeReview` / `impactAnalysis`) →
  redo: on → `"blastRadius"`, off → `{imports: 0.5, churn: 0.3, ownership: 0.2}`
  (tea-rags analytics-rerank)
- One call per file → reissue as ONE brace-expanded call
- `metaOnly: false` → restart with `metaOnly: true`
- Chunk-level output instead of per-file aggregation → aggregate by
  `relativePath`
- `/writing-plans` first, tea-rags after "for documentation" → wrong order,
  restart
- Inner skill chained raw `/executing-plans` (or any wrapped `/Y`) → intercept,
  invoke `/dino-Y` (Chaining rule)
