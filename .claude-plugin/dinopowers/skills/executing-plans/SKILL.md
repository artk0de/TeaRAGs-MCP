---
name: executing-plans
description:
  Use when executing a written implementation plan that modifies files — before
  each Task's edits (Edit/Write/MultiEdit), queries tea-rags git signals for the
  files about to change and issues a SAFE/CAUTION/UNSAFE verdict. Triggers when
  superpowers:executing-plans would normally fire on a plan whose Tasks name
  concrete files. NOT for one-off single-file edits — use direct Edit.
---

# dinopowers: executing-plans

Wrapper over `superpowers:executing-plans`. Adds a **pre-touch modification
guard** — before each Task's first Edit/Write, queries tea-rags impact signals
for the files the Task will modify and produces a verdict. High-blast-radius /
hotspot / silo-owned files get flagged before edits begin, not after a broken
commit.

## Iron Rule

**For every plan Task that modifies files, the pre-touch guard MUST run BEFORE
the first Edit/Write/MultiEdit of that Task.**

Correct tool (`semantic_search`) + correct custom impact rerank
(`imports: 0.5, churn: 0.3, ownership: 0.2`) + correct parameters
(brace-expanded `pathPattern` over Task-local files, `metaOnly: true`) + correct
verdict ladder (SAFE / CAUTION / UNSAFE) + correct gating (CAUTION = confirm,
UNSAFE = pause) is the core value.

If a Task is purely additive (creates new files, touches no existing ones): skip
the guard for that Task — state it explicitly. Do not invent a pathPattern to
justify a guard call.

## Step 1 — Extract Task's file list

From the current plan Task identify:

| Source                      | Example                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- |
| Task explicitly names files | "Task 3: update `a.ts`, `b.ts`"                                                    |
| Task refers to symbols      | "refactor `Class.method()`" → resolve via `mcp__tea-rags__find_symbol` to get file |
| Task refers to a small dir  | "update all files in `chunker/hooks/ruby/`" → `Glob`                               |

Output:

- `taskFileList`: relative paths the Task will modify (typically 1-5)
- `taskIntent`: one-sentence of what the Task does

If `taskFileList` is empty (pure new-file creation): skip to Step 4 with verdict
`SAFE (new files only)`.

## Step 2 — Pre-touch guard call

Issue ONE `mcp__tea-rags__semantic_search` call — SAME idiom as
`dinopowers:writing-plans` Step 2:

```
path:        <current project path>
query:       <taskIntent from Step 1>
pathPattern: "{taskFile1,taskFile2,...}"   ← brace expansion
rerank:      { custom: { imports: 0.5, churn: 0.3, ownership: 0.2 } }
limit:       <taskFileList.length * 3>
metaOnly:    true
```

Do NOT substitute:

| Wrong tool                                                      | Why wrong                                                                                     |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `mcp__tree-sitter__modification_guard`                          | Structural (AST) guard, misses git-signal blast radius (imports count, bugFixRate, ownership) |
| `mcp__tea-rags__hybrid_search`                                  | Custom rerank is tied to `semantic_search`                                                    |
| Named preset (`"hotspots"`, `"codeReview"`, `"impactAnalysis"`) | `impactAnalysis` does not exist; named presets miss `imports` weight                          |
| One call per file, sequential                                   | Brace expansion covers all in one                                                             |
| `mcp__tea-rags__find_similar` without a prior guard call        | Finds analogs, doesn't return blast-radius signals                                            |

Do NOT pass:

- `metaOnly: false` — we want verdict inputs, not content
- Different weights — the project idiom
  `{imports 0.5, churn 0.3, ownership 0.2}` must match
  `dinopowers:writing-plans` and `tea-rags:data-driven-generation` Step 6 for
  cross-skill comparability
- `filter` narrowing the file set — the `pathPattern` already scopes; filters
  hide signal

If results are empty (files are brand-new, not yet in git): verdict defaults to
`SAFE (new files)`. Do NOT fabricate blast-radius signals for untracked files.

## Step 3 — Compute verdict per file, aggregate to Task verdict

For each unique `relativePath` in results, extract from `payload.git.file.*`:

- `commitCount` — churn magnitude
- `bugFixRate` — historical quality (percent of commits tagged as fix/bug)
- `dominantAuthorPct` — silo indicator
- `imports` score (from ranking overlay) — blast radius proxy

Compute per-file verdict via this ladder:

| Verdict   | Any of these triggers                                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `UNSAFE`  | `imports` score top 5% of result set AND `bugFixRate ≥ 40%`; OR `dominantAuthorPct ≥ 95%` AND `commitCount ≥ 15` (deep silo) |
| `CAUTION` | `imports` top 15%; OR `bugFixRate ≥ 30%`; OR `dominantAuthorPct ≥ 85%`                                                       |
| `SAFE`    | none of the above                                                                                                            |

Task verdict = worst of per-file verdicts (UNSAFE dominates CAUTION dominates
SAFE).

Compose guard block:

```
### dinopowers guard — Task N ("<taskIntent>")

| File | imports | churn | bugFix | owner | Verdict |
|---|---|---|---|---|---|
| src/a.ts | 47 imports | 23 commits | 35% | Alice (92%) | CAUTION |
| src/b.ts | 3 imports  | 5 commits  | 0%  | shared (42%) | SAFE |

**Task verdict: CAUTION** — high-blast-radius in `src/a.ts`. Owner Alice has 92% dominance.
```

## Step 4 — Gate the Task execution

Branch on Task verdict BEFORE invoking `superpowers:executing-plans` for this
Task:

| Verdict   | Action                                                                                                                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SAFE`    | Proceed — invoke `superpowers:executing-plans` for this Task without interruption                                                                                                                                             |
| `CAUTION` | Surface the guard block to the user. Ask "Proceed with Task N?". Wait for explicit confirmation before invoking `superpowers:executing-plans`.                                                                                |
| `UNSAFE`  | Pause — surface block + recommend one of: (a) split Task into smaller Tasks, (b) add owner as co-author/reviewer, (c) require tests-before-edit. Do NOT invoke `superpowers:executing-plans` until user explicitly overrides. |

Never silently convert UNSAFE→CAUTION or CAUTION→SAFE to "keep momentum". The
verdict is a circuit breaker.

## Red Flags — STOP and restart from Step 2

- "This Task is small, skip the guard" → if `taskFileList` has ≥1 existing file,
  run Step 2
- Substituted `mcp__tree-sitter__modification_guard` → tree-sitter gives
  structural safety, not git-signal blast radius; both are useful but this
  wrapper is git-first. Run Step 2.
- Named preset instead of custom weights → redo with
  `{imports: 0.5, churn: 0.3, ownership: 0.2}`
- Ran guard AFTER the first Edit → wrong order; revert uncommitted changes if
  possible, restart from Step 2 before next Edit
- Silent downgrade of verdict → surface the true verdict; let user downgrade if
  they want
- `metaOnly: false` on guard call → restart with `metaOnly: true`

## Common Mistakes

| Mistake                                                              | Reality                                                                                              |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| One guard call per plan (not per Task)                               | `dinopowers:writing-plans` does per-plan. This wrapper is per-Task — scope matches edit granularity. |
| Use `rerank: "codeReview"` because "review before edit" sounds right | `codeReview` lacks `imports` weight — blast-radius invisible                                         |
| Emit the guard block and proceed without gating                      | The block is not documentation — it's a circuit breaker. CAUTION waits for confirmation.             |
| Treat UNSAFE as "just a warning"                                     | UNSAFE pauses. User must explicitly override before edits.                                           |
| Pre-fetch ALL plan files in one guard at plan start                  | Context stale by the time Task 5 runs. Guard is per-Task, just-in-time.                              |
| Invoke `superpowers:executing-plans` for the whole plan at once      | Wrapper is per-Task — gate each Task separately                                                      |
