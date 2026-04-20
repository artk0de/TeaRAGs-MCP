---
name: verification-before-completion
description:
  Use when about to claim work complete, fixed, or passing — before committing,
  creating PRs, or saying "done". Queries tea-rags imports/churn signals on
  just-edited files to surface collateral-damage candidates (files whose
  dependents could break) that must be verified. Triggers after edits when
  superpowers:verification-before-completion would normally fire. NOT for
  exploratory questions or planning (use brainstorming).
---

# dinopowers: verification-before-completion

Wrapper over `superpowers:verification-before-completion`. Adds a
**collateral-damage scan**: before claiming complete, queries tea-rags for
blast-radius signals (imports count, churn, ownership) on just-edited files and
surfaces which dependents should be verified too.

## Iron Rule

**tea-rags collateral-damage scan MUST run BEFORE claiming "done"** — whenever
the session has edited ≥1 existing file.

Correct tool (`semantic_search`) + correct custom impact rerank
(`imports: 0.5, churn: 0.3, ownership: 0.2`) + correct parameters
(brace-expanded `pathPattern` over `git diff --name-only`, `metaOnly: true`) +
correct verdict (surface high-`imports` files with explicit "verify dependents"
recommendation) = core value.

If only new files were created (no edits to existing files): skip scan with
verdict `SAFE (no existing-file edits)`. Do not fabricate pathPattern.

## Step 1 — Collect edited file set

From `git status --short` or `git diff --name-only`, collect:

| Source                                 | Example                                  |
| -------------------------------------- | ---------------------------------------- |
| Modified files (`M`) in working tree   | `src/core/domains/explore/reranker.ts`   |
| Staged files (`A`/`M` in index)        | `tests/explore/reranker.test.ts`         |
| Files changed in session (uncommitted) | any file touched by Edit/Write/MultiEdit |

Output:

- `editedFiles`: relative paths with actual content changes (exclude pure
  renames, exclude new-only files)
- `intent`: one sentence describing what the session changed

If `editedFiles` is empty (pure new-file session): skip to Step 4 with verdict
`SAFE (no existing-file edits)`.

## Step 2 — Collateral-damage scan call

Issue ONE `mcp__tea-rags__semantic_search` call — SAME idiom as
`dinopowers:writing-plans` and `dinopowers:executing-plans`:

```
path:        <current project path>
query:       <intent from Step 1>
pathPattern: "{editedFile1,editedFile2,...}"   ← brace expansion
rerank:      { custom: { imports: 0.5, churn: 0.3, ownership: 0.2 } }
limit:       <editedFiles.length * 3>
metaOnly:    true
```

Do NOT substitute:

| Wrong tool                                                        | Why wrong                                                                                           |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `mcp__tea-rags__hybrid_search`                                    | Custom impact rerank tied to `semantic_search`                                                      |
| Named preset (`"hotspots"` / `"codeReview"` / `"impactAnalysis"`) | `impactAnalysis` does not exist; named presets miss `imports` weight                                |
| `mcp__tree-sitter__trace_impact`                                  | Structural trace is complementary (call graph), not blast-radius on git signals; use tea-rags first |
| One call per file                                                 | Brace expansion covers all                                                                          |
| Built-in `grep -r "import.*<file>"`                               | Misses the ranked `imports` overlay signal; slower                                                  |
| `git log --oneline <files>`                                       | Shows history of edited files, not their dependents                                                 |

Do NOT pass:

- `metaOnly: false` — verdict inputs are signals, not content
- Different weights — must match `dinopowers:writing-plans` / `executing-plans`
  / `tea-rags:data-driven-generation` Step 6 for cross-skill comparability
- `filter` narrowing — `pathPattern` already scopes

If results are empty (files are brand-new committed this session, or not in git
yet): skip to Step 4 with verdict `UNVERIFIABLE (edited files not indexed)`. Do
NOT fabricate collateral-damage signals.

## Step 3 — Compute collateral-damage verdict

For each unique `relativePath` in results, extract from `payload.git.file.*` +
overlay:

- `imports` score — how many modules import this file (blast radius)
- `commitCount` — churn indicator
- `dominantAuthorPct` — silo risk

Verdict ladder per edited file:

| Verdict        | Triggers                                                     |
| -------------- | ------------------------------------------------------------ |
| `HIGH-BLAST`   | `imports` top 10% of result set (or absolute: >20 importers) |
| `MEDIUM-BLAST` | `imports` top 30% (or 5-20 importers)                        |
| `LOW-BLAST`    | `imports` ≤ 5 importers                                      |

Aggregate:

```
### dinopowers collateral-damage scan

| Edited file | imports | churn | verdict |
|---|---|---|---|
| src/core/contracts/errors.ts | 47 | 23 commits | HIGH-BLAST |
| src/adapters/qdrant/client.ts | 12 | 8 commits | MEDIUM-BLAST |
| tests/explore/strategies.test.ts | 0 | 2 commits | LOW-BLAST |

**Verify before claiming done:**
- `errors.ts` imported by 47 modules → run full test suite (not just tests/errors/)
- `client.ts` imported by 12 modules → run integration tests touching qdrant
- `strategies.test.ts` → no dependents; unit test is sufficient
```

## Step 4 — Invoke superpowers:verification-before-completion

Invoke the `Skill` tool with `superpowers:verification-before-completion`.
Prepend the collateral-damage block as context. Phrase handoff as:

> "Before claiming done, the edited files have these blast-radius signals:
> …<block>… Run verification commands that exercise HIGH-BLAST dependents, not
> just files directly edited. Evidence before assertions."

Let `superpowers:verification-before-completion` run its standard verification
cycle (tests, type-check, lint, build). The wrapper does not replace it — it
informs the scope of verification.

## Red Flags — STOP and restart from Step 2

- "Only tests need to run, I know the change is isolated" → if ANY edited file
  has `imports > 0`, run Step 2
- "git diff is small (2 lines), skip the scan" → 2-line change in high-blast
  file = catastrophe. Run Step 2.
- Substituted `grep -r` / `git log` → redo with `semantic_search` + custom
  rerank
- Named preset instead of custom weights → redo
- Skipped verification after surfacing HIGH-BLAST → wrapper informs scope, never
  substitutes for verification
- `metaOnly: false` → restart

## Common Mistakes

| Mistake                                           | Reality                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| Claim "done" after tests in edited files pass     | Dependents may still break. `imports > 5` = verify their tests too.              |
| Use `rerank: "hotspots"` instead of custom impact | `hotspots` returns BUG-prone zones (history), not BLAST-radius (structural)      |
| Silent downgrade of HIGH-BLAST to "probably fine" | Verdict informs scope; downgrading without evidence hides risk                   |
| Run full test suite regardless of verdict         | LOW-BLAST files don't need full suite; the scan's point is targeted verification |
| Skip scan for "trivial" renames                   | Renames break imports; ALL dependents may need updates                           |
| Run scan but ignore block in verification         | Block is prescriptive, not informational — it says WHICH tests to run            |
