---
name: finishing-a-development-branch
description:
  Finalize dev branch (merge/PR/cleanup) with tea-rags:risk-assessment over full
  branch diff — completion options weighed against risk zones across entire
  branch scope. Triggers on "finish the branch", "ready to merge", "wrap up the
  feature", "ветка готова", "доводим до merge", "branch ready", "PR time",
  "shipping the branch", "merge ready". NOT for mid-branch interim commits.
  Wraps superpowers:finishing-a-development-branch with tea-rags:risk-assessment
  over the branch diff.
---

# dinopowers: finishing-a-development-branch

Wrapper over `superpowers:finishing-a-development-branch`. Completion decision
(merge/PR/cleanup) informed by branch-wide risk scan — ALL files branch touched,
not just last Task — so "ready to merge" claims backed by multi-signal evidence.

## Iron Rule

**`Skill(tea-rags:risk-assessment)` MUST run on branch diff BEFORE presenting
completion options** — whenever branch has ≥1 commit beyond base.

Core value: correct delegation (`tea-rags:risk-assessment` skill, not ad-hoc
`semantic_search`) + correct scope (entire branch diff, not last commit) +
ordering (risk-assessment BEFORE completion options).

Branch 0 commits ahead of base (nothing to finish): skip wrapper. Trivial
changes (docs-only, renames-only): risk-assessment skippable with note "trivial
scope — no risk scan needed".

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every dinopowers:X
redirects superpowers:X. NEVER bypass the wrapper.

**Index freshness:** see [FRESHNESS.md](../../FRESHNESS.md) and worktree-clone
lifecycle in `tea-rags/rules/index-freshness.md`. No background reindex hook —
after merge to `main` reindex `main` EXPLICITLY (Step 5); run
`mcp__tea-rags__index_codebase` manually to search uncommitted WIP.

**Second Iron Rule — branch-finish index lifecycle (MANDATORY).** On EVERY
branch finish — local merge to `main` OR abandon/delete — you MUST tear down the
per-worktree index clone with **`tea-rags worktree remove <name>`** (NOT
`delete_collection`, which drops only the Qdrant collection and leaks the DuckDB

- snapshot + registry footprint). Additionally, on the MERGE path you MUST
  reindex `main` EXPLICITLY with `mcp__tea-rags__index_codebase` — no commit
  hook does it for you. Full procedure: Step 5. Never use the deprecated
  `reindex_changes`.

## Step 1 — Determine branch scope

From git state, collect:

| Element                  | Example                              |
| ------------------------ | ------------------------------------ |
| **Branch base**          | `main`, `develop`, origin upstream   |
| **Branch commits ahead** | `git rev-list --count <base>..HEAD`  |
| **Branch diff files**    | `git diff <base>...HEAD --name-only` |
| **Diff character/kind**  | code / docs / config / mixed         |

Compose:

- `branchDiffFiles`: full set of files touched across branch (not just last
  commit)
- `branchIntent`: one-sentence summary of what branch accomplishes

`branchDiffFiles` empty OR docs-only OR renames-only (no content changes): skip
to Step 4 with verdict `TRIVIAL-SCOPE (no risk scan)`.

## Step 2 — Invoke tea-rags:risk-assessment

Invoke `Skill` tool with `tea-rags:risk-assessment`. Pass as input:

- `pathPattern`: brace-expanded over `branchDiffFiles` (scope to this branch's
  footprint)
- `intent`: branch summary

Wait for standard `PRESENT` output — tier-classified risk candidates (Critical /
High / Medium) with multi-preset convergence (hotspots + ownership + techDebt).

Codegraph active: risk-assessment's structural axis runs automatically over
branch-diff scope — blast-radius hubs (`architecturalHub` amplifier) and
**circular dependencies the branch introduces or touches** (`find_cycles`).
Branch adding cross-module cycle is merge-blocker even with clean git signals —
read risk-assessment "Structural risks" section before deciding
merge/PR/cleanup. Codegraph off: that section absent (not "no cycles");
structural risk simply unassessed.

Do NOT substitute:

| Wrong approach                                   | Why wrong                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Direct `semantic_search` with any single rerank  | Risk assessment converges 3+ presets (hotspots/ownership/techDebt); one call misses the convergence signal         |
| `dinopowers:verification-before-completion` scan | That scan is POST-edit blast-radius per file; risk-assessment is MULTI-SIGNAL tier classification — different lens |
| `mcp__tea-rags__hybrid_search` on branch name    | Branch name isn't a risk signal                                                                                    |
| `git log --stat <base>..HEAD` alone              | Shows what changed, not what's risky                                                                               |
| `git diff <base>..HEAD` review by eye            | Human eye misses hotspot/silo/debt convergence                                                                     |

Do NOT pass:

- `pathPattern` including UNTOUCHED parts of project — scope must equal branch
  diff, not broader project
- `pathPattern` including only last-commit files — Step 1 output is BRANCH-wide,
  not commit-wide

Branch diff files unindexed (new module created on branch): note "branch scope
unindexed — risk-assessment unavailable; relying on test suite + human review".

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

risk-assessment returned "No critical risks found. Codebase appears healthy" —
note `CLEAN-SCAN — ready to present completion options`.

## Step 4 — Invoke superpowers:finishing-a-development-branch

Invoke `Skill` tool with `superpowers:finishing-a-development-branch`. Prepend
scan block as context. Phrase handoff as:

> "Before presenting completion options, note branch-wide risk scan: …<block>…
> Completion options (merge / PR / cleanup) should factor in these risks — don't
> present 'ready to merge' if Critical risks are untested.
>
> Chaining rule reminder: when your cycle would next invoke
> `superpowers:requesting-code-review` or
> `superpowers:verification-before-completion` (or any wrapped `superpowers:Y`),
> invoke `dinopowers:Y` instead — see the Chaining rule section above."

Let `superpowers:finishing-a-development-branch` run its standard
merge/PR/cleanup decision presentation. Wrapper informs recommendation, does not
force specific outcome.

## Step 5 — Post-merge index cleanup

After merge to `main` succeeds (the `superpowers` cycle performs it), close
index lifecycle:

- **Reindex `main` EXPLICITLY after the merge.** No background commit hook — run
  `mcp__tea-rags__index_codebase` (incremental) against the `main` alias so
  `main` reflects the merged change. (`index_codebase` is the only incremental
  entrypoint; never the deprecated `reindex_changes`.) Abandon/delete paths skip
  this — nothing merged into `main`.
- **Drop the per-worktree index clone (MANDATORY on EVERY finish).** Branch
  developed in a worktree with its own tea-rags index clone (collection
  `<project>-worktree-<name>`, created by `tea-rags worktree create`): remove
  now: `tea-rags worktree remove <name>` — on merge AND on abandon/delete. Clone
  is throwaway; leaving it leaks Qdrant + DuckDB + snapshot footprint. Run even
  if the git worktree directory is already gone — index clone tracked
  separately, outlives the directory. A cleanup-only `PostToolUse` hook is the
  backstop if you bypass this with a raw `git worktree remove` /
  `git branch -D`, but do it explicitly here anyway.
- **No clone → no cleanup.** Branch developed on the main checkout (no
  `tea-rags worktree` clone): nothing to remove.

Skip this step only on a PR-only completion path (no local merge): clone stays
until the PR merges — note it for later cleanup.

Do NOT substitute:

| Wrong approach                                   | Why wrong                                                                                                                                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp__tea-rags__delete_collection` for the clone | Drops ONLY the Qdrant collection — leaks the clone's DuckDB graph, file-hash snapshots, stats/quarantine, and registry entry. `tea-rags worktree remove <name>` tears down the FULL footprint. |
| Skipping the explicit `main` reindex after merge | There is no commit hook — `main` stays stale until you run `mcp__tea-rags__index_codebase` against the `main` alias yourself. Reindex `main` explicitly on the merge path.                     |
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
  `dinopowers:Y` wrapper → intercept, invoke the wrapper instead (see Chaining
  rule)
- Merged to `main` and did NOT reindex `main` → stale; no commit hook. Run the
  explicit `mcp__tea-rags__index_codebase` on the `main` alias (Step 5).
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
