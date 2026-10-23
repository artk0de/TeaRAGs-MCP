---
name: dino-requesting-code-review
description:
  'Prepare code-review request bundle: per-file ownership, churn, connected
  taskIds from tea-rags git signals before composing review request — reviewers
  know who to ping, where risk lives. Triggers on "request review", "open a PR",
  "ready for review", "готовлю PR", "запрос на ревью", "code review please". NOT
  for self-review or draft-PR exploration. Wraps $requesting-code-review with
  tea-rags reviewer-context bundle.'
---

# dinopowers: requesting-code-review

Wrapper over `$requesting-code-review`. Request reaches reviewer with
git-context bundle — file owners, churn, connected tickets — reviewers
pair-match by expertise, trace coordinated changes without re-excavating.

## Iron Rule

**tea-rags git-bundle query MUST run on `git diff --name-only` BEFORE composing
review request** — whenever ≥1 file changed.

Value = right tool (`semantic_search`) + impact rerank (`blastRadius` / custom
fallback `imports: 0.5, churn: 0.3, ownership: 0.2`) + params (brace-expanded
`pathPattern` over diff files, `metaOnly: true`) + bundle format (per-file
ownership/churn/taskIds, NOT blast-radius verdict).

Diff empty → skip wrapper, invoke `$requesting-code-review` directly. Never
fabricate.

**Chaining rule:** [CHAINING.md](../../CHAINING.md) — every onward `$Y` →
`$dino-Y`. NEVER bypass wrapper.

**Requires superpowers:** `$requesting-code-review` unavailable → stop, ask the
user to install superpowers (https://github.com/obra/superpowers; steps in
[CHAINING.md](../../CHAINING.md)). NEVER run this enrichment alone and present
it as the full workflow.

**Freshness:** [FRESHNESS.md](../../FRESHNESS.md) (owner
`tea-rags://guide/freshness`). Lag ≠ unusable — never Bash `cat`/`grep`/`Read`
over code; `treeState` row → `find_symbol`.

## Step 1 — Collect diff file list

`git diff --name-only <base>...HEAD` (branch) or `git diff --staged`
(pre-commit):

| Source                | Example                               |
| --------------------- | ------------------------------------- |
| Branch against base   | `git diff main...HEAD --name-only`    |
| Uncommitted + staged  | `git diff --name-only HEAD`           |
| Specific commit range | `git diff <sha1>..<sha2> --name-only` |

Output: `diffFiles` (M/A, exclude pure D) + `intent` (one sentence, what diff
does). Pure deletions only / empty diff → skip wrapper (reviewers need
code-in-diff).

## Step 2 — Git-bundle query

ONE `semantic_search` — same idiom as `$dino-writing-plans`:

```
project:     <alias>                    ← `tea-rags://guide/freshness` "Addressing the Codebase"
path:        <your working directory>   ← the tree (worktree / branch checkout)
query:       <intent from Step 1>
pathPattern: "{diffFile1,diffFile2,...}"   ← brace expansion
rerank:      "blastRadius"               ← codegraph on; else { custom: { imports: 0.5, churn: 0.3, ownership: 0.2 } }
limit:       <diffFiles.length * 3>
metaOnly:    true
```

Do NOT substitute:

| Wrong tool                                          | Why wrong                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `hybrid_search`                                     | Same rerank, but its BM25 leg re-ranks by query-token overlap — signal scan wants semantic + signals |
| Other named preset (`"codeReview"` / `"ownership"`) | `codeReview` misses `imports`; `ownership` misses churn + taskIds in one call                        |
| `git blame` / `git log --format` per-file           | Manual git commands are slower and miss the indexed overlay                                          |
| `find_similar`                                      | Finds code analogs, not diff metadata                                                                |

Do NOT pass:

- `metaOnly: false` — bundle = signals; content already in PR diff
- different weights — must match project idiom
- `filter` narrowing — pathPattern scopes already

Empty results (files too new) → skip bundle, invoke `$requesting-code-review`
with note "diff files not yet indexed — no git-context available". Never
fabricate.

## Step 2.5 — Reviewer-hub awareness (codegraph only)

Codegraph on = graph tools (`get_callers`, `trace_path`, …) in tool list; unsure
→ read `tea-rags://project/<alias>/metrics?section=registry`. On → per changed
symbol `get_callers symbolId=<id>` (exact id via `find_symbol` first). Callers
depend on change → their `blameDominantAuthor`s = stakeholders. Add "Affected
callers / suggested reviewers" line to bundle.

Off → skip; Step 2/3 ownership bundle stands; note caller-impact not computed.
NEVER invent caller lists.

## Step 2.6 — Naming pre-check (codegraph only)

`review_changes(changes={ base: <Step 1 base> }, sections: ["naming"])` — ONE
call reviews every name diff's added lines declare (values, types, constants);
never hand-list into `names[]`. Base = target branch for branch diff (`main`);
read at merge-base with HEAD (target moving on adds nothing). Uncommitted work →
omit (default `HEAD`). Worktree branch → pass `path=<worktree>` (alias alone
reads main checkout).

Settle naming before reviewer spends comment:

- `MISFIT` → rename to `suggestion` before sending (or list under risk flags
  with holder). Type MISFIT with `role.evidence: "directory"` → rename only when
  type belongs to `role.examples`' family, else keep name
- `COLLISION` → rename, or justify against `existing` declaration
- `NEW_TERM` → one-line justification in bundle, or take offered alternative
- finding with `genericName` → rename or justify

Answer under `review` {workTree, base, mergeBase, changedFiles, checked,
conforming, novel, findings, notJudged, truncated?}; findings flat
`{relPath, line, name, kind, type?, verdict, …}`. Bundle line: findings grouped
by verdict with `relPath:line` + conforming and novel counts (`novel` = nothing
to compare, no action). Reading: `$data-driven-generation` Step 5 "Naming
(lexicon)".

## Step 3 — Build reviewer-context bundle

Aggregate by `relativePath`. Per file — raw essentials (`blame*`, `commitCount`,
`ageDays`, `taskIds`) from payload `git.file.*`; `recent*` / `bugFixRate` +
labels from `rankingOverlay.file.*` when rerank surfaces them, else absent
(metaOnly payload never carries them):

- `blameDominantAuthor` + `blameDominantAuthorPct` — live-line owner (approves
  on current code)
- `recentDominantAuthor` + `recentDominantAuthorPct` — recent committer
  (mentally loaded, fastest turnaround)
- `blameContributorCount` (live owners), `recentContributorCount` (recent
  committers)
- `commitCount` + `ageDays`
- `taskIds` (connected tickets — highest-value signal, never omit)
- `bugFixRate` (risk signal)

Reviewers by `blame*`; fast turnaround by `recent*`.

Bundle goes INTO request, not a verdict. Metadata only — no raw diff, no raw git
log:

```
### Reviewer context bundle

**Files changed (per-file owners + history):**
| File | Owner | Contributors | Commits (age) | Related tickets |
|---|---|---|---|---|
| src/a.ts | Alice (92%) | 1 | 23 (142d) | #123, #145 |
| src/b.ts | shared (42%) | 5 | 8 (30d) | — |

**Suggested reviewers by expertise:**
- Alice — primary owner of `src/a.ts` (92% dominance)
- Bob — deep contributor to `src/b.ts` (last 3 commits)

**Coordinated change context:**
- Related ticket #123 also touched src/c.ts, src/d.ts in previous commits — reviewer should check consistency

**Risk flags for reviewer attention:**
- `src/a.ts` has bugFixRate=35% (high) — scrutinize new logic
- `src/e.ts` has been touched 47 times in 90 days — stability concern
```

Bundle > 20 lines → per-file table top 10 by `imports`, note "N more files
omitted". Thin data → empty bundle beats fabricated ownership.

## Step 3a — Tests at risk (scenarios under threat)

Invoke `$tests-as-context` with:

```
recipe: "tests-at-risk"
affectedFiles: <diffFiles from Step 1>
intent: <intent from Step 1>
```

Recipe → ranked DSL leaf test chunks bound to change. Add to bundle one of:

- SKIP (no DSL test chunks indexed):

  ```
  **Scenarios under risk:** unavailable (no DSL test chunks indexed)
  ```

- Non-empty list:

  ```
  **Scenarios under risk:**
  - <file>:<line> — <describe-it path>
  - <file>:<line> — <describe-it path>
  ```

  Cap top 8; "N more omitted" if truncated.

- Empty (preflight passed, no semantic match):
  ```
  **Scenarios under risk:** no obvious test bindings found — reviewer should
  verify whether new behavior needs new tests
  ```

NEVER name test runners — generic phrasing; command left to reviewer / CI /
pre-commit hook.

## Step 4 — Invoke $requesting-code-review

Invoke `Skill` tool with `$requesting-code-review`. Prepend bundle as context.
Phrase handoff as:

> "Include this reviewer-context bundle in the review request: …<block>…
> Reviewers can pair-match by ownership and see coordinated-change context
> without re-excavating history.
>
> Chaining rule reminder: when your cycle would next invoke
> `$verification-before-completion` (or any wrapped `$Y`), invoke `$dino-Y`
> instead — see the Chaining rule section above."

`$requesting-code-review` runs standard cycle — wrapper enriches, never
replaces.

## Red Flags — STOP, restart from Step 2

- "Reviewer knows codebase, no bundle" → bundle = PAIR-MATCHING, not education
- "Diff small, skip bundle" → small diff to high-churn file still needs
  ownership context
- git blame/log substituted → redo with semantic_search + Step 2 rerank
- Wrong rerank for codegraph state → redo: `"blastRadius"` when codegraph on
  (graph tools present), else `{imports: 0.5, churn: 0.3, ownership: 0.2}`
  (tea-rags analytics-rerank). `"ownership"` alone misses imports/churn/taskIds;
  `"codeReview"` finds reviewable code, not reviewer context
- Request composed before Step 2 → revert, restart
- Raw diff / full git log in bundle → METADATA only
- `D`-status files in bundle → drop; show in diff
- Inner cycle chains raw `$verification-before-completion` → intercept, invoke
  `$dino-verification-before-completion`
