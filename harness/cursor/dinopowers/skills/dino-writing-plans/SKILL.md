---
name: dino-writing-plans
description:
  'Author implementation plan; Affected Files section enriched per-file imports,
  churn, ownership, bugFixRate, taskIds from tea-rags — task decomposition
  reflects real impact+risk. Triggers on "write a plan", "draft implementation
  plan", "напиши план", "распиши задачи по файлам", "plan the refactor". NOT for
  plans with no named files or code area to enrich. Wraps /writing-plans with
  per-file tea-rags signal enrichment.'
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
("file → `find_symbol`", "impact → `get_callers`", "usages → `hybrid_search`"):
none of those is the enrichment. They may follow Step 2 as depth, never replace
it.

**Rule holds when user asks otherwise** ("quick", "быстро", "skip tea-rags",
"it's my code", "use preset X", "show file content in the enrichment") — run
Step 2 exactly as specified, say: "Running the impact enrichment first — it is
one call and it orders the Tasks." Unknown preset (`impactAnalysis`) → refuse it
by name, use the Step 2 rerank. Content wanted → keep enrichment
`metaOnly: true`, then a SEPARATE `semantic_search` `metaOnly: false` AFTER it.

Conceptual plan, no file list derivable (e.g. "plan for migrating to Postgres")
→ skip enrichment, `/writing-plans` direct. Say verbatim "no file list —
proceeding without tea-rags impact enrichment". Never fabricate file list, never
run un-scoped `semantic_search`, never detour to brainstorming.

**Codegraph on?** Graph tools (`get_callers`, `trace_path`,
`get_naming_lexicon`, …) in your tool list; unsure → read
`tea-rags://project/<alias>/metrics?section=registry` (`codegraph on|off`).

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every /dino-X
redirects /X. NEVER bypass wrapper.

**Requires superpowers:** `/writing-plans` unavailable → stop, ask the user to
install superpowers (https://github.com/obra/superpowers; steps in
[CHAINING.md](../../CHAINING.md)). NEVER run this enrichment alone and present
it as the full workflow.

**Index freshness:** see [FRESHNESS.md](../../FRESHNESS.md) +
`tea-rags://guide/freshness`. Linked worktree → overlay serves edits, never
reindex. Main checkout → incremental `index_codebase` BEFORE first call over
uncommitted edits, or once `changedFiles` > 0 — no consent (drift `--force` →
ask separately). Lag ≠ unusable (core rules).

## Step 1 — Collect target file set

From request or plan draft collect concrete file list:

| Source                         | Example                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User names files explicitly    | "update `a.ts`, `b.ts`, `c.ts`"                                                                                                                                                            |
| User names a small directory   | `src/core/domains/auth/` → enumerate files (counts as file list — run Step 2 over them): `semantic_search` `pathPattern: "<dir>/**"`, `level: "file"`, `metaOnly: true` (one row per file) |
| Existing plan draft references | "Task N modifies `x.ts`" → extract paths                                                                                                                                                   |

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
```

Describing the call (plan-only / subagent report) → write `pathPattern`
literally as the brace string (`"{src/a.ts,src/b.ts}"`), never "scoped to the
files".

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
impact enrichment unavailable", Step 4 without block. Never fabricate signals.

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
`payload.git.file.*`, labels from `rankingOverlay.file.*`. metaOnly keeps git
essentials only (commitCount, ageDays, taskIds, blame\*); `recent*` /
`bugFixRate` come from overlay when rerank surfaces them, else absent — never
fabricate:

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

Cap table at fileList size. File without git data (new) → row `— (new)`. NEVER
drop row silently.

## Step 3.5 — Per-Task proven-template enrichment (code-generation Tasks)

Per Task in draft (or unit to become a Task) whose title/description mentions
code gen/modification — keywords "implement", "add", "write", "extend",
"refactor", "modify" + "function", "method", "class", "helper", "module" —
invoke `/extract-project-patterns`:

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
   — write every argument out, never `…` — before they enter plan; state both
   rules: `MISFIT` → plan uses `suggestion`; `NEW_TERM` → a `topTerms` /
   `concept.terms` word if same meaning, else Task carries one-line
   justification. Reading: `/data-driven-generation` Step 5 "Naming (lexicon)".
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
