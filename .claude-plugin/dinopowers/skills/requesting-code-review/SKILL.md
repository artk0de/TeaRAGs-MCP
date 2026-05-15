---
name: requesting-code-review
description:
  Prepare a code-review request bundle with per-file ownership, churn, and
  connected taskIds drawn from tea-rags git signals before composing the review
  request, so reviewers know who to ping and where the risk lives. Triggers on
  "request review", "open a PR", "ready for review", "готовлю PR", "запрос на
  ревью", "code review please". NOT for self-review or draft-PR exploration.
  Wraps superpowers:requesting-code-review with a tea-rags reviewer-context
  bundle.
---

# dinopowers: requesting-code-review

Wrapper over `superpowers:requesting-code-review`. Ensures the review request
arrives at the reviewer with git-context bundle — who owns each file, churn
levels, connected tickets — so reviewers can pair-match by expertise and trace
coordinated changes immediately instead of re-excavating context.

## Iron Rule

**tea-rags git-bundle query MUST run on `git diff --name-only` BEFORE composing
the review request** — whenever ≥1 file is changed.

Correct tool (`semantic_search`) + correct custom impact rerank
(`imports: 0.5, churn: 0.3, ownership: 0.2`) + correct parameters
(brace-expanded `pathPattern` over diff files, `metaOnly: true`) + correct
bundle format (per-file ownership/churn/taskIds, NOT blast-radius verdict) is
the core value.

If diff is empty: skip wrapper, invoke `superpowers:requesting-code-review`
directly. Do not fabricate.

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every dinopowers:X
redirects superpowers:X. NEVER bypass the wrapper.

**Index freshness:** see [FRESHNESS.md](../../FRESHNESS.md) — MUST run
`mcp__tea-rags__reindex_changes` if any file was edited in this session, BEFORE
the first tea-rags call.

## Step 1 — Collect diff file list

From `git diff --name-only <base>...HEAD` (branch diff) or `git diff --staged`
(pre-commit):

| Source                | Example                               |
| --------------------- | ------------------------------------- |
| Branch against base   | `git diff main...HEAD --name-only`    |
| Uncommitted + staged  | `git diff --name-only HEAD`           |
| Specific commit range | `git diff <sha1>..<sha2> --name-only` |

Output:

- `diffFiles`: files changed in the review's scope (M/A, exclude pure D)
- `intent`: one-sentence description of what the diff accomplishes

Pure deletions (D only): skip wrapper — reviewers need code-in-diff for context.
Empty diff: skip.

## Step 2 — Git-bundle query

Issue ONE `mcp__tea-rags__semantic_search` — SAME idiom as
`dinopowers:writing-plans`:

```
project:     <alias from list_projects — RECOMMENDED, omit path when set>
path:        <current project path — fallback when no alias is registered>
query:       <intent from Step 1>
pathPattern: "{diffFile1,diffFile2,...}"   ← brace expansion
rerank:      { custom: { imports: 0.5, churn: 0.3, ownership: 0.2 } }
limit:       <diffFiles.length * 3>
metaOnly:    true
```

Do NOT substitute:

| Wrong tool                                    | Why wrong                                                                     |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `mcp__tea-rags__hybrid_search`                | Custom rerank tied to `semantic_search`                                       |
| Named preset (`"codeReview"` / `"ownership"`) | `codeReview` misses `imports`; `ownership` misses churn + taskIds in one call |
| `git blame` / `git log --format` per-file     | Manual git commands are slower and miss the indexed overlay                   |
| `mcp__tea-rags__find_similar`                 | Finds code analogs, not diff metadata                                         |

Do NOT pass:

- `metaOnly: false` — bundle inputs are signals; content is already in the PR
  diff
- Different weights — must match project idiom
- `filter` narrowing — pathPattern already scopes

Empty results (files too new to be indexed): skip bundle, invoke
`superpowers:requesting-code-review` with note "diff files not yet indexed — no
git-context available". Do not fabricate.

## Step 3 — Build reviewer-context bundle

Aggregate by `relativePath`. Per unique file extract:

- `blameDominantAuthor` + `blameDominantAuthorPct` — live-line owner (who must
  approve based on current code state)
- `recentDominantAuthor` + `recentDominantAuthorPct` — recent committer (who's
  loaded in mentally for fastest turnaround)
- `blameContributorCount` (live owners) and `recentContributorCount` (recent
  committers)
- `commitCount` + `ageDays`
- `taskIds` (connected tickets)
- `bugFixRate` (risk signal)

Pick reviewers by `blame*` (authority) and prioritize fast turnaround by
`recent*` (cache locality).

Compose bundle (this goes INTO the review request, not as a verdict):

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

If bundle would exceed 20 lines: truncate per-file table to top 10 by `imports`
score, note "N more files omitted".

## Step 4 — Invoke superpowers:requesting-code-review

Invoke the `Skill` tool with `superpowers:requesting-code-review`. Prepend the
bundle as context. Phrase handoff as:

> "Include this reviewer-context bundle in the review request: …<block>…
> Reviewers can pair-match by ownership and see coordinated-change context
> without re-excavating history.
>
> Chaining rule reminder: when your cycle would next invoke
> `superpowers:verification-before-completion` (or any wrapped `superpowers:Y`),
> invoke `dinopowers:Y` instead — see the Chaining rule section above."

Let `superpowers:requesting-code-review` run its standard review-composition
cycle. The wrapper enriches the request, does not replace the review process.

## Red Flags — STOP and restart from Step 2

- "Reviewer knows the codebase, they don't need a bundle" → bundle is for
  PAIR-MATCHING, not education. Run Step 2.
- "Diff is small, skip the bundle" → small diffs to high-churn files still
  benefit from ownership context
- Substituted git blame/log → redo with semantic_search + custom rerank
- Named preset instead of custom weights → redo
- Composed request before Step 2 → revert, restart
- Pasted raw diff into bundle → bundle is METADATA (ownership/churn/tickets),
  not code
- Let `superpowers:requesting-code-review` chain into a raw
  `superpowers:verification-before-completion` without redirecting to
  `dinopowers:verification-before-completion` → intercept and invoke the wrapper
  instead (see Chaining rule)

## Common Mistakes

| Mistake                                                         | Reality                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Use `rerank: "ownership"` alone                                 | Returns ownership-dominant rank but misses `imports`, `churn`, `taskIds` in one call |
| Use `rerank: "codeReview"` preset because "this is code review" | codeReview is for finding reviewable code, not building reviewer context             |
| Paste full git log per file into bundle                         | Bundle is structured metadata, not raw history                                       |
| Skip `taskIds` in bundle                                        | Connected tickets are the highest-value signal for reviewers — don't omit            |
| Include files with `D` status in bundle                         | Pure deletions don't need reviewer-context; show them in diff, not bundle            |
| Fabricate dominant author when data is thin                     | Empty bundle > fake bundle; reviewers distrust fabricated ownership                  |
