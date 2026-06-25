---
name: finishing-a-development-branch
description:
  Finalize a dev branch (merge, PR, or cleanup decision) with a
  tea-rags:risk-assessment over the full branch diff so completion options are
  weighed against the risk zones touched across the entire branch scope.
  Triggers on "finish the branch", "ready to merge", "wrap up the feature",
  "ветка готова", "доводим до merge", "branch ready", "PR time", "shipping the
  branch", "merge ready". NOT for mid-branch interim commits. Wraps
  superpowers:finishing-a-development-branch with tea-rags:risk-assessment over
  the branch diff.
---

# dinopowers: finishing-a-development-branch

Wrapper over `superpowers:finishing-a-development-branch`. Ensures the
completion decision (merge/PR/cleanup) is informed by a branch-wide risk scan —
across ALL files the branch touched, not just the last Task — so "ready to
merge" claims are backed by multi-signal evidence.

## Iron Rule

**`Skill(tea-rags:risk-assessment)` MUST run on the branch diff BEFORE
presenting completion options** — whenever the branch has ≥1 commit beyond base.

Correct delegation (`tea-rags:risk-assessment` skill, not ad-hoc
`semantic_search`) + correct scope (entire branch diff, not last commit) +
ordering (risk-assessment BEFORE completion options) is the core value.

If branch has 0 commits ahead of base (nothing to finish): skip wrapper —
there's nothing to complete. If branch has only trivial changes (docs-only,
renames-only): risk-assessment may be skipped with note "trivial scope — no risk
scan needed".

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every dinopowers:X
redirects superpowers:X. NEVER bypass the wrapper.

**Index freshness:** see [FRESHNESS.md](../../FRESHNESS.md) — a post-commit hook
auto-reindexes after commits/merges; run `mcp__tea-rags__index_codebase`
manually only to search code edited but not yet committed, BEFORE the first
tea-rags call.

**Second Iron Rule — post-merge index cleanup (MANDATORY).** When the completion
path is a LOCAL MERGE to `main`, after the merge you MUST: (1) NOT manually
reindex `main` — the post-commit hook already did it; (2) if the branch had a
per-worktree index clone, tear it down with
**`tea-rags worktree remove <name>`** — NOT `delete_collection` (which drops
only the Qdrant collection and leaks the DuckDB + snapshot + registry
footprint). Full procedure: Step 5. Never use the deprecated `reindex_changes`.

## Step 1 — Determine branch scope

From git state, collect:

| Element                  | Example                              |
| ------------------------ | ------------------------------------ |
| **Branch base**          | `main`, `develop`, origin upstream   |
| **Branch commits ahead** | `git rev-list --count <base>..HEAD`  |
| **Branch diff files**    | `git diff <base>...HEAD --name-only` |
| **Diff character/kind**  | code / docs / config / mixed         |

Compose:

- `branchDiffFiles`: full set of files touched across the branch (not just last
  commit)
- `branchIntent`: one-sentence summary of what the branch accomplishes

If `branchDiffFiles` is empty OR docs-only OR renames-only with no content
changes: skip to Step 4 with verdict `TRIVIAL-SCOPE (no risk scan)`.

## Step 2 — Invoke tea-rags:risk-assessment

Invoke the `Skill` tool with `tea-rags:risk-assessment`. Pass as input:

- `pathPattern`: brace-expanded over `branchDiffFiles` (scoping to this branch's
  footprint)
- `intent`: the branch summary

Wait for its standard `PRESENT` output — tier-classified risk candidates
(Critical / High / Medium) with multi-preset convergence (hotspots + ownership +
techDebt).

When codegraph is active, risk-assessment's structural axis runs automatically
over the branch-diff scope: blast-radius hubs (`architecturalHub` amplifier) and
**circular dependencies the branch introduces or touches** (`find_cycles`). A
branch that adds a cross-module cycle is a merge-blocker even with clean git
signals — read the risk-assessment "Structural risks" section before deciding
merge/PR/cleanup. When codegraph is off, that section is absent (not "no
cycles"); structural risk is simply unassessed.

Do NOT substitute:

| Wrong approach                                   | Why wrong                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Direct `semantic_search` with any single rerank  | Risk assessment converges 3+ presets (hotspots/ownership/techDebt); one call misses the convergence signal         |
| `dinopowers:verification-before-completion` scan | That scan is POST-edit blast-radius per file; risk-assessment is MULTI-SIGNAL tier classification — different lens |
| `mcp__tea-rags__hybrid_search` on branch name    | Branch name isn't a risk signal                                                                                    |
| `git log --stat <base>..HEAD` alone              | Shows what changed, not what's risky                                                                               |
| `git diff <base>..HEAD` review by eye            | Human eye misses hotspot/silo/debt convergence                                                                     |

Do NOT pass:

- `pathPattern` that includes UNTOUCHED parts of the project — scope must equal
  branch diff, not broader project
- `pathPattern` that includes only last-commit files — Step 1 output is
  BRANCH-wide, not commit-wide

If branch diff files are unindexed (new module created on branch): note "branch
scope unindexed — risk-assessment unavailable; relying on test suite + human
review".

## Step 3 — Summarize risk into completion context

From `tea-rags:risk-assessment` PRESENT output extract:

- **Critical risks in branch scope** — count + list (file:line + classification)
- **High risks** — count + list
- **Test coverage gaps** among Critical/High
- **Recommendation tier** — one-sentence synthesis

Compose completion block:

```
### Branch completion scan: <branchName>

**Scope:** <N> files, <M> commits ahead of <base>
**Intent:** <branchIntent>

**Risk profile:**
- Critical: <N> candidates — [file:line: classification, ...]
- High: <N> candidates
- Untested among Critical/High: <N>

**Recommendation:** <ready-to-merge | address-critical-first | needs-review-pairing>
```

If risk-assessment returned "No critical risks found. Codebase appears healthy"
— note `CLEAN-SCAN — ready to present completion options`.

## Step 4 — Invoke superpowers:finishing-a-development-branch

Invoke the `Skill` tool with `superpowers:finishing-a-development-branch`.
Prepend the scan block as context. Phrase handoff as:

> "Before presenting completion options, note branch-wide risk scan: …<block>…
> Completion options (merge / PR / cleanup) should factor in these risks — don't
> present 'ready to merge' if Critical risks are untested.
>
> Chaining rule reminder: when your cycle would next invoke
> `superpowers:requesting-code-review` or
> `superpowers:verification-before-completion` (or any wrapped `superpowers:Y`),
> invoke `dinopowers:Y` instead — see the Chaining rule section above."

Let `superpowers:finishing-a-development-branch` run its standard
merge/PR/cleanup decision presentation. The wrapper informs the recommendation,
does not force a specific outcome.

## Step 5 — Post-merge index cleanup

After a merge to `main` succeeds (the `superpowers` cycle performs it), close
the index lifecycle:

- **`main` is already fresh — do NOT manually reindex it.** The `PostToolUse`
  reindex hook fires on the merge commit and incrementally reindexes the `main`
  collection. (`index_codebase` is the only incremental entrypoint if you ever
  do need a manual one; never the deprecated `reindex_changes`.)
- **Drop the per-worktree index clone.** If this branch was developed in a
  worktree that had its own tea-rags index clone (collection
  `<project>-worktree-<name>`, created by `tea-rags worktree create`), remove it
  now: `tea-rags worktree remove <name>`. The clone is throwaway; leaving it
  leaks Qdrant + DuckDB + snapshot footprint. Run this even if the git worktree
  directory is already gone — the index clone is tracked separately and outlives
  the directory.
- **No clone → no cleanup.** If the branch was developed on the main checkout
  (no `tea-rags worktree` clone), there is nothing to remove.

Skip this step only on a PR-only completion path (no local merge): the clone
stays until the PR merges — note it for later cleanup.

Do NOT substitute:

| Wrong approach                                   | Why wrong                                                                                                                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp__tea-rags__delete_collection` for the clone | Drops ONLY the Qdrant collection — leaks the clone's DuckDB graph, file-hash snapshots, stats/quarantine, and registry entry. `tea-rags worktree remove <name>` tears down the FULL footprint. |
| Manually reindexing `main` after the merge       | The post-commit hook already reindexed `main` on the merge commit — a manual reindex is redundant.                                                                                             |
| `mcp__tea-rags__reindex_changes` (any context)   | Deprecated. `index_codebase` is the only incremental entrypoint.                                                                                                                               |
| Removing only the git worktree directory         | The index clone is tracked separately and survives the directory — it must be removed with `tea-rags worktree remove`.                                                                         |

## Red Flags — STOP and restart from Step 2

- "All tests pass, just merge" → tests pass ≠ branch-wide risk clean. Run
  Step 2.
- "I did verification-before-completion after last commit" → that scan is
  per-Task; this is branch-wide and multi-signal
- Substituted direct `semantic_search` → missed convergence; invoke the skill
- Scoped scan to last commit only → revert, expand to full branch diff
- Presented completion options before Step 2 → revert, restart
- Let `superpowers:finishing-a-development-branch` chain into a raw
  `superpowers:requesting-code-review` /
  `superpowers:verification-before-completion` without redirecting to the
  `dinopowers:Y` wrapper → intercept and invoke the wrapper instead (see
  Chaining rule)
- Merged to `main` and then manually reindexed `main` → redundant; the
  post-commit hook already reindexed it on the merge commit. Skip Step 5's
  manual reindex.
- Cleaned up a per-worktree clone with `delete_collection` (or by deleting the
  worktree directory) → incomplete; leaks DuckDB + snapshots + registry. Use
  `tea-rags worktree remove <name>` (Step 5).
- Reached for `reindex_changes` → deprecated; use `index_codebase`.

## Common Mistakes

| Mistake                                               | Reality                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| Confuse with `verification-before-completion` wrapper | verification is per-edit blast-radius; this is branch-wide multi-signal risk tier |
| Scope to last commit                                  | Branch risk surface ≠ last commit's risk; scan the whole branch                   |
| Skip if "tests are green"                             | Green tests miss hotspot/silo/debt signals by design                              |
| Use `rerank: "hotspots"` alone                        | hotspots is ONE risk lens; risk-assessment converges 3+                           |
| Present 'ready to merge' before Step 2                | Completion decision informed by risk, not by "feels done"                         |
| Narrow pathPattern to exclude "non-risky" files       | Risk-assessment decides what's risky, not the agent a priori                      |
