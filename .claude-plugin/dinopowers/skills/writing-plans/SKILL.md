---
name: writing-plans
description:
  Use when authoring an implementation plan that names specific files or a small
  set of touchable paths. Triggers on phrases like "write a plan for X", "draft
  implementation plan", "напиши план", "распиши задачи по файлам", or when
  superpowers:writing-plans would normally fire AND a file list is
  known/derivable. Enriches the plan's Affected Files section with per-file
  impact signals (imports, churn, ownership, bugFixRate, taskIds) so
  decomposition and sequencing are data-driven.
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

Correct tool (`semantic_search`) + correct custom rerank weights
(`imports: 0.5, churn: 0.3, ownership: 0.2`) + correct parameters
(brace-expanded `pathPattern`, `metaOnly: true`) + correct ordering is the core
value of this wrapper.

If the plan is conceptual with no file list derivable (e.g. "plan for migrating
to Postgres") — skip enrichment and invoke `superpowers:writing-plans` directly.
State it. Do not fabricate a file list.

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
path:        <current project path>
query:       <intent from Step 1>
pathPattern: "{file1,file2,file3,...}"   ← brace expansion over fileList
rerank:      { custom: { imports: 0.5, churn: 0.3, ownership: 0.2 } }
limit:       <fileList.length * 3>       ← aim for ~3 chunks per file
metaOnly:    true
```

This is the **impact analysis** idiom established in
`tea-rags:data-driven-generation` Step 6 and documented in
`tea-rags-analytics.md`. Do NOT substitute.

Do NOT substitute:

| Wrong tool                                                      | Why wrong                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Separate calls per file                                         | Wasteful — brace expansion does it in one call                                        |
| Named preset (`"hotspots"`, `"codeReview"`, `"impactAnalysis"`) | `impactAnalysis` preset does not exist; named risk presets miss the imports dimension |
| `mcp__tea-rags__hybrid_search`                                  | Custom rerank weights are tied to `semantic_search`                                   |
| `mcp__tea-rags__find_similar`                                   | Gives symbol analogs, not file impact                                                 |
| `mcp__tea-rags__find_symbol`                                    | Per-symbol, not per-file signal aggregation                                           |
| Built-in `Glob` or `git blame` for signals                      | Loses imports + ownership + bugFixRate overlay                                        |

Do NOT pass:

- `metaOnly: false` — content is not needed for impact analysis; bloats payload
- Different custom weights — the `{imports 0.5, churn 0.3, ownership 0.2}` set
  is the project idiom; deviating makes results non-comparable to
  `tea-rags:data-driven-generation` output
- `filter` on `git.ageDays` / `git.commitCount` — the weights already encode
  these; additional filters hide signal

If results are empty (all files new, not yet in git): report "file set not
indexed — area is new; impact enrichment unavailable" and skip to Step 4 without
block. Do not fabricate signals.

## Step 3 — Aggregate per file

Cross-reference returned chunks by `relativePath` (primary key — see
`tea-rags:risk-assessment` Phase 2: MERGE). For each unique file in `fileList`:

Extract from `payload.git.file.*`:

- `dominantAuthor` + `dominantAuthorPct` — owner, silo indicator
- `commitCount` — churn proxy
- `ageDays` — recency
- `bugFixRate` — historical quality
- `taskIds` — connected tickets (coordinated-change signal)

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

## Step 4 — Invoke superpowers:writing-plans

Invoke the `Skill` tool with `superpowers:writing-plans`. Prepend the enrichment
block from Step 3 as context. Phrase the handoff as:

> "Before decomposing, note these impact signals per affected file: …<block>…
> Use them to: (1) order Tasks so shared-taskId files change together, (2)
> isolate high-blast-radius files into dedicated Tasks with explicit tests, (3)
> flag silo-owned files for owner review."

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

## Common Mistakes

| Mistake                                        | Reality                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| Use `rerank: "codeReview"` as proxy for impact | `codeReview` lacks imports weight — wrong lens for plan sequencing                    |
| Use `rerank: "impactAnalysis"`                 | Preset does not exist (see `tea-rags-analytics.md`). Use custom weights.              |
| Issue N calls for N files                      | Brace expansion + `limit: N*3` returns all in one call                                |
| Drop files with empty git data from the table  | Silently hides "new file" status; plans must acknowledge new files                    |
| Collapse aggregation into chunk-level output   | Plans care about files, not chunks. Aggregate by `relativePath`.                      |
| Skip enrichment for "quick plans"              | "Quick" is when enrichment matters most — bad sequencing bites hardest on short plans |
