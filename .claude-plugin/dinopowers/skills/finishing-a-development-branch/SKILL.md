---
name: finishing-a-development-branch
description:
  Use when finalizing a development branch for merge/PR/release — before
  presenting completion options, runs tea-rags:risk-assessment on the whole
  branch diff to surface risk zones touched across the branch's full scope.
  Triggers when superpowers:finishing-a-development-branch would normally fire.
  NOT for single-Task completion (use verification-before-completion).
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
> present 'ready to merge' if Critical risks are untested."

Let `superpowers:finishing-a-development-branch` run its standard
merge/PR/cleanup decision presentation. The wrapper informs the recommendation,
does not force a specific outcome.

## Red Flags — STOP and restart from Step 2

- "All tests pass, just merge" → tests pass ≠ branch-wide risk clean. Run
  Step 2.
- "I did verification-before-completion after last commit" → that scan is
  per-Task; this is branch-wide and multi-signal
- Substituted direct `semantic_search` → missed convergence; invoke the skill
- Scoped scan to last commit only → revert, expand to full branch diff
- Presented completion options before Step 2 → revert, restart

## Common Mistakes

| Mistake                                               | Reality                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| Confuse with `verification-before-completion` wrapper | verification is per-edit blast-radius; this is branch-wide multi-signal risk tier |
| Scope to last commit                                  | Branch risk surface ≠ last commit's risk; scan the whole branch                   |
| Skip if "tests are green"                             | Green tests miss hotspot/silo/debt signals by design                              |
| Use `rerank: "hotspots"` alone                        | hotspots is ONE risk lens; risk-assessment converges 3+                           |
| Present 'ready to merge' before Step 2                | Completion decision informed by risk, not by "feels done"                         |
| Narrow pathPattern to exclude "non-risky" files       | Risk-assessment decides what's risky, not the agent a priori                      |
