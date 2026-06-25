---
name: writing-plans
description:
  Author an implementation plan with the Affected Files section enriched by
  per-file imports, churn, ownership, bugFixRate, and taskIds drawn from
  tea-rags, so task decomposition reflects real impact and risk. Triggers on
  "write a plan", "draft implementation plan", "напиши план", "распиши задачи по
  файлам", "plan the refactor". NOT for plans with no named files or code area
  to enrich. Wraps superpowers:writing-plans with per-file tea-rags signal
  enrichment.
---

# dinopowers: writing-plans

Wrapper over `superpowers:writing-plans`. Ensures the plan's decomposition and
sequencing decisions use real impact data — imports (blast radius), churn,
ownership, bug history, and connected taskIds — instead of guessing which files
are "risky" or "safe".

## Iron Rule

**tea-rags impact enrichment MUST be called BEFORE
`Skill(superpowers:writing-plans)`** — whenever the plan touches a known set of
files.

Correct tool (`semantic_search`) + correct rerank (`"blastRadius"` when
codegraph is on, the `{imports 0.5, churn 0.3, ownership 0.2}` fallback when
off) + correct parameters (brace-expanded `pathPattern`, `metaOnly: true`) +
correct ordering is the core value of this wrapper.

If the plan is conceptual with no file list derivable (e.g. "plan for migrating
to Postgres") — skip enrichment and invoke `superpowers:writing-plans` directly.
State it. Do not fabricate a file list.

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every dinopowers:X
redirects superpowers:X. NEVER bypass the wrapper.

**Index freshness:** see [FRESHNESS.md](../../FRESHNESS.md) — a post-commit hook
auto-reindexes after commits/merges; run `mcp__tea-rags__index_codebase`
manually only to search code edited but not yet committed, BEFORE the first
tea-rags call.

## Step 1 — Collect target file set

From the user request or existing plan draft, collect the concrete file list:

| Source                         | Example                                                       |
| ------------------------------ | ------------------------------------------------------------- |
| User names files explicitly    | "update `a.ts`, `b.ts`, `c.ts`"                               |
| User names a small directory   | `src/core/domains/auth/` → enumerate current files via `Glob` |
| Existing plan draft references | "Task N modifies `x.ts`" → extract paths                      |

Output:

- `fileList`: array of relative paths (5-30 typical; >30 → prompt user to narrow
  scope)
- `intent`: one-sentence description of the change

If no file list derivable: skip to Step 4 with empty enrichment. Report "no file
list — proceeding without tea-rags impact enrichment".

## Step 2 — Impact enrichment call

Issue ONE `mcp__tea-rags__semantic_search` call:

```
project:     <alias from list_projects — RECOMMENDED, omit path when set>
path:        <current project path — fallback when no alias is registered>
query:       <intent from Step 1>
pathPattern: "{file1,file2,file3,...}"   ← brace expansion over fileList
rerank:      "blastRadius"               ← codegraph on; see OFF fallback below
limit:       <fileList.length * 3>       ← aim for ~3 chunks per file
metaOnly:    true
```

**Codegraph gating for `rerank`:** when prime `## Enrichment` lists
`codegraph.symbols`, use `"blastRadius"` (real `fanIn` + churn + bugFix — true
blast radius). When that line is absent the `fanIn` signal is gone — fall back
to `{ custom: { imports: 0.5, churn: 0.3, ownership: 0.2 } }` (import-proxy,
approximate). This is the **impact analysis** idiom established in
`tea-rags:data-driven-generation` Step 6 and documented in
`tea-rags-analytics.md`. Do NOT substitute the tool.

Do NOT substitute:

| Wrong tool                                                      | Why wrong                                                                                                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Separate calls per file                                         | Wasteful — brace expansion does it in one call                                                                                           |
| Named preset `"hotspots"` / `"codeReview"` / `"impactAnalysis"` | `impactAnalysis` does not exist; these miss the blast-radius dimension. `"blastRadius"` IS the correct named preset when codegraph is on |
| `mcp__tea-rags__hybrid_search`                                  | Custom rerank weights are tied to `semantic_search`                                                                                      |
| `mcp__tea-rags__find_similar`                                   | Gives symbol analogs, not file impact                                                                                                    |
| `mcp__tea-rags__find_symbol`                                    | Per-symbol, not per-file signal aggregation                                                                                              |
| Built-in `Glob` or `git blame` for signals                      | Loses imports + ownership + bugFixRate overlay                                                                                           |

Do NOT pass:

- `metaOnly: false` — content is not needed for impact analysis; bloats payload
- The wrong rerank for the codegraph state — `"blastRadius"` when codegraph is
  on, the `{imports 0.5, churn 0.3, ownership 0.2}` fallback when off. Both
  match `tea-rags:data-driven-generation` Step 6; don't invent other weights
- `filter` on `git.ageDays` / `git.commitCount` — the weights already encode
  these; additional filters hide signal

If results are empty (all files new, not yet in git): report "file set not
indexed — area is new; impact enrichment unavailable" and skip to Step 4 without
block. Do not fabricate signals.

## Step 3 — Aggregate per file

Cross-reference returned chunks by `relativePath` (primary key — see
`tea-rags:risk-assessment` Phase 2: MERGE). For each unique file in `fileList`:

Extract from `payload.git.file.*`:

- `blameDominantAuthor` + `blameDominantAuthorPct` — live-line owner, silo
  indicator (from `git blame HEAD` — current state, not commit history)
- `recentDominantAuthor` + `recentDominantAuthorPct` — recent committer
  (commit-based, useful for review-routing of recently-touched code)
- `commitCount` — churn proxy
- `ageDays` — recency
- `bugFixRate` — historical quality
- `taskIds` — connected tickets (coordinated-change signal)

MUST pick the right column or downstream rerank presets misroute reviewers.

**Signal-column selection (MUST decide BEFORE filling the enrichment block):**

| Decision context                   | Column to use     |
| ---------------------------------- | ----------------- |
| Ownership / who-knows-this-code    | `blame*`          |
| Recent activity / review routing   | `recent*`         |
| Both contexts present in same Task | List both columns |

They diverge when a long-time owner stops contributing — `blame*` still says
they own, `recent*` highlights newer committers.

Compose enrichment block:

```
### tea-rags impact enrichment (rerank: imports+churn+ownership)

| File | Owner | Churn | Age | Bugs | Tasks |
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

Cap table at fileList size. If a file has no git data (new file, not yet
committed): row shows `— (new)`. Do NOT drop the row silently.

## Step 3.5 — Per-Task proven-template enrichment (code-generation Tasks)

For each Task in the plan draft (or each unit you intend to decompose into a
Task) where the title or description mentions code generation / modification —
heuristic keywords: "implement", "add", "write", "extend", "refactor", "modify"
combined with "function", "method", "class", "helper", "module" — invoke
`tea-rags:extract-project-patterns`:

1. Derive `pathPatternL1` from the Task's Affected Files (deepest common
   ancestor as a `**/<dir>/**` glob).
2. Invoke `tea-rags:extract-project-patterns` with:
   - `pathPatternL1` from step 1
   - `behaviorQuery` = Task title
   - `limit` = 5
3. Attach the result to the Task body under a `**Proven templates**` subsection:

   ```
   **Proven templates** (extract-project-patterns, locality: L1|L2|L3|none)
   - top: <path> (commitCount X, ageDays Y, bugFixRate Z)
   - reviewer: <blameDominantAuthor>
     - locality L1 → review style + code
     - locality L2/L3 → review technique only
   ```

4. If `locality = "none"`, attach the diagnostic verbatim so the plan reader
   knows this Task has no proven precedent in the project.

This step runs BEFORE Step 4 so the per-Task enrichment is visible to the
superpowers:writing-plans authoring cycle and surfaces in the final plan
document.

**Skip clause:** if no Task is classified as code-generation /
code-modification, skip this step entirely. Pure-config or pure-test plans have
no template need.

## Step 4 — Invoke superpowers:writing-plans

Invoke the `Skill` tool with `superpowers:writing-plans`. Prepend the enrichment
block from Step 3 as context. Phrase the handoff as:

> "Before decomposing, note these impact signals per affected file: …<block>…
> Use them to: (1) order Tasks so shared-taskId files change together, (2)
> isolate high-blast-radius files into dedicated Tasks with explicit tests, (3)
> flag silo-owned files for owner review.
>
> Chaining rule reminder: when your cycle would next invoke
> `superpowers:executing-plans` (or any other wrapped `superpowers:Y`), invoke
> the `dinopowers:Y` wrapper instead — see the Chaining rule section above."

Let `superpowers:writing-plans` run its standard RED-GREEN-REFACTOR plan
authoring cycle — this wrapper does not replace it, only grounds it.

## Red Flags — STOP and restart from Step 2

- "I already know which files are risky in this plan" → run Step 2 anyway;
  memory is stale
- "The plan is short, skip impact analysis" → if fileList has ≥2 entries, run
  Step 2
- Substituted named preset for custom weights → redo with
  `{imports: 0.5, churn: 0.3, ownership: 0.2}`
- One call per file (sequential) → reissue as ONE call with brace-expanded
  pathPattern
- `metaOnly: false` → restart with `metaOnly: true`
- Called `superpowers:writing-plans` first, tea-rags after for "documentation" →
  wrong order, restart
- Let `superpowers:writing-plans` chain into a raw `superpowers:executing-plans`
  (or any other wrapped `superpowers:Y`) without redirecting to `dinopowers:Y` →
  intercept and invoke the wrapper instead (see Chaining rule)

## Common Mistakes

| Mistake                                        | Reality                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| Use `rerank: "codeReview"` as proxy for impact | `codeReview` lacks imports weight — wrong lens for plan sequencing                    |
| Use `rerank: "impactAnalysis"`                 | Preset does not exist (see `tea-rags-analytics.md`). Use custom weights.              |
| Issue N calls for N files                      | Brace expansion + `limit: N*3` returns all in one call                                |
| Drop files with empty git data from the table  | Silently hides "new file" status; plans must acknowledge new files                    |
| Collapse aggregation into chunk-level output   | Plans care about files, not chunks. Aggregate by `relativePath`.                      |
| Skip enrichment for "quick plans"              | "Quick" is when enrichment matters most — bad sequencing bites hardest on short plans |
