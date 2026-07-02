---
name: verification-before-completion
description:
  Before claiming work is complete, run tea-rags imports/churn signals on
  just-edited files to surface collateral-damage candidates (files whose
  dependents could break), then run verification commands so success claims are
  backed by evidence and blast-radius awareness. Triggers on "ready to commit",
  "all done", "should be fixed now", "готово", "проверь перед commit", "все
  работает". NOT for mid-work sanity checks without a completion claim. Wraps
  superpowers:verification-before-completion with a tea-rags collateral-damage
  scan.
---

# dinopowers: verification-before-completion

Wrapper over `superpowers:verification-before-completion`. Adds
**collateral-damage scan**: before claiming complete, query tea-rags
blast-radius signals (imports count, churn, ownership) on just-edited files;
surface which dependents to verify too.

## Iron Rule

**tea-rags collateral-damage scan MUST run BEFORE claiming "done"** — whenever
session edited ≥1 existing file.

Correct tool (`semantic_search`), correct impact rerank (`"blastRadius"` when
codegraph on, `{imports 0.5, churn 0.3, ownership 0.2}` fallback when off),
correct params (brace-expanded `pathPattern` over `git diff --name-only`,
`metaOnly: true`), correct verdict (surface high-`fanIn`/`imports` files with
explicit "verify dependents" rec) = core value.

Only new files created (no edits to existing): skip scan, verdict
`SAFE (no existing-file edits)`. Don't fabricate pathPattern.

## Verdict Ladder (PRESCRIPTIVE — apply before claiming done)

🛑 STOP — read the ladder, then act.

Read blast signal from `fanIn` when codegraph on (real dependents), else
`imports` proxy.

| Verdict        | Triggers                                                              |
| -------------- | --------------------------------------------------------------------- |
| `HIGH-BLAST`   | `fanIn`/`imports` top 10% of result set (or absolute: >20 dependents) |
| `MEDIUM-BLAST` | `fanIn`/`imports` top 30% (or 5-20 dependents)                        |
| `LOW-BLAST`    | `fanIn`/`imports` ≤ 5 dependents                                      |

Block is prescriptive, not informational — DO NOT skip ladder evaluation.

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every dinopowers:X
redirects superpowers:X. NEVER bypass the wrapper.

**Index freshness:** see [FRESHNESS.md](../../FRESHNESS.md) and
`tea-rags/rules/index-freshness.md`. No background reindex hook — worktree-plan
freshness explicit (clone + per-task reindex in `dinopowers:executing-plans`);
run `mcp__tea-rags__index_codebase` manually to search code edited but not
committed, BEFORE first tea-rags call.

## Step 1 — Collect edited file set

From `git status --short` or `git diff --name-only`, collect:

| Source                                 | Example                                  |
| -------------------------------------- | ---------------------------------------- |
| Modified files (`M`) in working tree   | `src/core/domains/explore/reranker.ts`   |
| Staged files (`A`/`M` in index)        | `tests/explore/reranker.test.ts`         |
| Files changed in session (uncommitted) | any file touched by Edit/Write/MultiEdit |

Output:

- `editedFiles`: relative paths with actual content changes (exclude pure
  renames, new-only files)
- `intent`: one sentence — what session changed

`editedFiles` empty (pure new-file session): skip to Step 4, verdict
`SAFE (no existing-file edits)`.

## Step 2 — Collateral-damage scan call

Issue ONE `mcp__tea-rags__semantic_search` call — SAME idiom as
`dinopowers:writing-plans` and `dinopowers:executing-plans`:

```
project:     <alias from list_projects — RECOMMENDED, omit path when set>
path:        <current project path — fallback when no alias is registered>
query:       <intent from Step 1>
pathPattern: "{editedFile1,editedFile2,...}"   ← brace expansion
rerank:      "blastRadius"               ← codegraph on; OFF fallback below
limit:       <editedFiles.length * 3>
metaOnly:    true
```

**Codegraph gating for `rerank`:** `"blastRadius"` (real `fanIn`) when prime
`## Enrichment` lists `codegraph.symbols`; else fall back
`{ custom: { imports: 0.5, churn: 0.3, ownership: 0.2 } }` (import-proxy).

Do NOT substitute:

| Wrong tool                                                      | Why wrong                                                                                                               |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `mcp__tea-rags__hybrid_search`                                  | Custom impact rerank tied to `semantic_search`                                                                          |
| Named preset `"hotspots"` / `"codeReview"` / `"impactAnalysis"` | `impactAnalysis` does not exist; these miss the blast-radius dimension. `"blastRadius"` IS correct when codegraph is on |
| `mcp__tree-sitter__trace_impact`                                | Structural trace is complementary (call graph), not blast-radius on git signals; use tea-rags first                     |
| One call per file                                               | Brace expansion covers all                                                                                              |
| Built-in `grep -r "import.*<file>"`                             | Misses the ranked `imports` overlay signal; slower                                                                      |
| `git log --oneline <files>`                                     | Shows history of edited files, not their dependents                                                                     |

Do NOT pass:

- `metaOnly: false` — verdict inputs are signals, not content
- Different weights — must match `dinopowers:writing-plans` / `executing-plans`
  / `tea-rags:data-driven-generation` Step 6 for cross-skill comparability
- `filter` narrowing — `pathPattern` already scopes

Results empty (files brand-new committed this session, or not in git yet): skip
to Step 4, verdict `UNVERIFIABLE (edited files not indexed)`. Don't fabricate
collateral-damage signals.

## Step 3 — Compute collateral-damage verdict

For each unique `relativePath` in results, extract from `payload.git.file.*` +
overlay:

- `imports` score — how many modules import this file (blast radius)
- `commitCount` — churn indicator
- `blameDominantAuthorPct` (with adaptive label) — live-line silo risk (use
  label, not magic percentage — `silo` / `deep-silo` are codebase-relative)

Verdict ladder per edited file: See Verdict Ladder near top.

Aggregate:

```
### dinopowers collateral-damage scan

| Edited file | imports | churn | verdict |
|---|---|---|---|
| src/core/contracts/errors.ts | 47 | 23 commits | HIGH-BLAST |
| src/adapters/qdrant/client.ts | 12 | 8 commits | MEDIUM-BLAST |
| tests/explore/strategies.test.ts | 0 | 2 commits | LOW-BLAST |

**Verify before claiming done:**
- `errors.ts` imported by 47 modules → run the project's test suite covering all dependents
- `client.ts` imported by 12 modules → run integration tests touching the qdrant adapter
- `strategies.test.ts` → no dependents; the file's own tests are sufficient
```

Phrasing stays generic — never name specific runners (vitest, jest, pytest,
rspec, etc.). Reading agent resolves project's actual test command from project
context (package.json scripts, Makefile, CI config).

## Step 3a — Tests-at-risk lookup (targeted verification)

Invoke `Skill(tea-rags:tests-as-context)` with:

```
recipe: "tests-at-risk"
affectedFiles: <editedFiles from Step 1>
intent: <intent from Step 1>
```

Recipe surfaces DSL leaf test chunks semantically bound to change. For each
HIGH-BLAST/MEDIUM-BLAST file whose result list non-empty, augment verdict block
with targeted rec:

```
**Targeted scenarios for high-blast files:**
- src/core/contracts/errors.ts → run the tests for these scenarios:
  - tests/errors/typed-errors.test.ts:42 — TypedError > propagates cause
  - tests/api/handler-errors.test.ts:78 — handler > error response shape
```

Output stays runner-agnostic. Phrasing: "run the tests for these files",
"execute these scenarios via the project's standard test command". Never name
specific runner.

Recipe returned SKIP (no DSL test chunks indexed): leave verdict block as-is,
add
`**Targeted scenarios:** unavailable (no DSL test chunks indexed) — verification scope guided by blast-radius signals only`.

Recipe returned empty list (preflight passed, no semantic match): add
`**Targeted scenarios:** no obvious test bindings — run general verification covering blast-radius dependents`.

## Step 4 — Invoke superpowers:verification-before-completion

Invoke `Skill` tool with `superpowers:verification-before-completion`. Prepend
collateral-damage block as context. Phrase handoff as:

> "Before claiming done, the edited files have these blast-radius signals:
> …<block>… Run verification commands that exercise HIGH-BLAST dependents, not
> just files directly edited. Evidence before assertions.
>
> Chaining rule reminder: when your cycle would next invoke
> `superpowers:finishing-a-development-branch` (or any wrapped `superpowers:Y`),
> invoke `dinopowers:Y` instead — see the Chaining rule section above."

Let `superpowers:verification-before-completion` run its standard verification
cycle (tests, type-check, lint, build). Wrapper doesn't replace it — informs
scope of verification.

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
- Let `superpowers:verification-before-completion` chain into a raw
  `superpowers:finishing-a-development-branch` without redirecting to
  `dinopowers:finishing-a-development-branch` → intercept and invoke the wrapper
  instead (see Chaining rule)

## Common Mistakes

| Mistake                                           | Reality                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| Claim "done" after tests in edited files pass     | Dependents may still break. `imports > 5` = verify their tests too.              |
| Use `rerank: "hotspots"` instead of custom impact | `hotspots` returns BUG-prone zones (history), not BLAST-radius (structural)      |
| Silent downgrade of HIGH-BLAST to "probably fine" | Verdict informs scope; downgrading without evidence hides risk                   |
| Run full test suite regardless of verdict         | LOW-BLAST files don't need full suite; the scan's point is targeted verification |
| Skip scan for "trivial" renames                   | Renames break imports; ALL dependents may need updates                           |
| Run scan but ignore block in verification         | Block is prescriptive, not informational — it says WHICH tests to run            |
