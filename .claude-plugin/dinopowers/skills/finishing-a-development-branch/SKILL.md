---
name: finishing-a-development-branch
description:
  Finalize dev branch (merge/PR/cleanup) with tea-rags:risk-assessment over full
  branch diff. Triggers on "finish the branch", "ready to merge", "wrap up the
  feature", "ветка готова", "доводим до merge", "branch ready", "PR time",
  "shipping the branch", "merge ready". NOT for mid-branch interim commits or a
  "готово, коммить и пушь" / "done, commit and push" claim (→ verification).
  Wraps superpowers:finishing-a-development-branch.
---

# dinopowers: finishing-a-development-branch

Wrapper over `superpowers:finishing-a-development-branch`. Completion decision
(merge/PR/cleanup) informed by branch-wide risk scan — ALL files branch touched,
not last Task — "ready to merge" backed by multi-signal evidence.

## Iron Rule

**`Skill(tea-rags:risk-assessment)` MUST run on branch diff BEFORE presenting
completion options** — whenever branch ≥1 commit beyond base.

Value = right delegation (`tea-rags:risk-assessment` skill, not ad-hoc
`semantic_search`) + right scope (whole branch diff, not last commit) + order
(risk-assessment BEFORE options).

**Scope = whole branch diff (`<base>...HEAD`), even when user asks otherwise.**
"Only check the last commit" / "only the critical one" → refuse the narrower
scope, scan full branch, say: "Scanning the whole branch — risk accumulates
across commits; a merge ships all of them, not just HEAD."

Plain done-claim ("готово, можно коммитить и пушить") with no merge/PR/cleanup
decision → not this wrapper; `dinopowers:verification-before-completion` owns
it.

0 commits ahead → skip wrapper. Trivial (docs-only, renames-only) → scan
skippable, note "trivial scope — no risk scan needed".

**Chaining rule:** [CHAINING.md](../../CHAINING.md) — every onward
`superpowers:Y` → `dinopowers:Y`. NEVER bypass wrapper.

**Requires superpowers:** `superpowers:finishing-a-development-branch`
unavailable → stop, ask the user to install superpowers
(https://github.com/obra/superpowers; steps in
[CHAINING.md](../../CHAINING.md)). NEVER run this enrichment alone and present
it as the full workflow.

**Freshness:** [FRESHNESS.md](../../FRESHNESS.md) (owner
`tea-rags://guide/freshness`). Lag ≠ unusable — never Bash `cat`/`grep`/`Read`
over code; `treeState` row → `find_symbol`.

**Second Iron Rule — branch-finish index lifecycle (MANDATORY).** Every finish
with a clone — local merge to `main` OR abandon/delete — MUST tear clone down
with **`tea-rags worktree remove <name>`** (NOT `delete_collection` — drops only
Qdrant collection, leaks DuckDB graph + file-hash snapshots + stats/quarantine +
registry entry). MERGE path also MUST reindex `main` EXPLICITLY with
`mcp__tea-rags__index_codebase` — no commit hook does it. Never deprecated
`reindex_changes`. Procedure: Step 5.

## Step 1 — Determine branch scope

| Element                  | Example                              |
| ------------------------ | ------------------------------------ |
| **Branch base**          | `main`, `develop`, origin upstream   |
| **Branch commits ahead** | `git rev-list --count <base>..HEAD`  |
| **Branch diff files**    | `git diff <base>...HEAD --name-only` |
| **Diff character/kind**  | code / docs / config / mixed         |

Compose `branchDiffFiles` (all files touched across branch, not last commit) +
`branchIntent` (one sentence).

`branchDiffFiles` empty OR docs-only OR renames-only → Step 4 with verdict
`TRIVIAL-SCOPE (no risk scan)`.

## Step 2 — Invoke tea-rags:risk-assessment

Invoke `Skill` tool with `tea-rags:risk-assessment`. Input:

- `pathPattern`: brace-expanded over `branchDiffFiles` (branch footprint)
- `intent`: branch summary

Wait for `PRESENT` output — tiered candidates (Critical / High / Medium),
multi-preset convergence (hotspots + ownership + techDebt).

Codegraph on: risk-assessment's structural axis runs over branch scope —
blast-radius hubs (`architecturalHub` amplifier) + **cycles branch introduces or
touches** (`find_cycles`). Branch adding cross-module cycle = merge-blocker even
with clean git signals → read "Structural risks" section before deciding.
Codegraph off: section absent (≠ "no cycles"); structural risk unassessed.

Do NOT substitute:

| Wrong approach                                   | Why wrong                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Direct `semantic_search` with any single rerank  | Risk assessment converges 3+ presets (hotspots/ownership/techDebt); one call misses the convergence signal         |
| `dinopowers:verification-before-completion` scan | That scan is POST-edit blast-radius per file; risk-assessment is MULTI-SIGNAL tier classification — different lens |
| `mcp__tea-rags__hybrid_search` on branch name    | Branch name isn't a risk signal                                                                                    |
| `git log --stat <base>..HEAD` alone              | Shows what changed, not what's risky                                                                               |
| `git diff <base>..HEAD` review by eye            | Human eye misses hotspot/silo/debt convergence                                                                     |

`pathPattern` MUST equal branch diff — NOT broader (untouched project parts),
NOT narrower (last-commit files only, or "non-risky" files excluded a priori —
risk-assessment decides risk).

Branch files unindexed (new module) → note "branch scope unindexed —
risk-assessment unavailable; relying on test suite + human review".

## Step 3 — Summarize risk into completion context

From PRESENT output extract: Critical (count + file:line + classification), High
(count + list), untested among Critical/High, one-sentence recommendation.

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

"No critical risks found. Codebase appears healthy" → note
`CLEAN-SCAN — ready to present completion options`.

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

`superpowers:finishing-a-development-branch` runs standard presentation —
wrapper informs recommendation, never forces outcome.

## Step 5 — Post-merge index cleanup

After merge to `main` succeeds (`superpowers` cycle performs it):

- **Reindex `main` EXPLICITLY.** No commit hook —
  `mcp__tea-rags__index_codebase` (incremental) on `main` alias. Abandon/delete
  → skip (nothing merged).
- **Drop per-worktree index clone (MANDATORY when exists).** Clone = collection
  `<project>-worktree-<name>` from `tea-rags worktree create` →
  `tea-rags worktree remove <name>` on merge AND abandon/delete. Run even if git
  worktree dir already gone — clone tracked separately, outlives dir.
  Cleanup-only `PostToolUse` hook = backstop for raw `git worktree remove` /
  `git branch -D`; still do it explicitly.
- **No clone → no cleanup.** Main checkout, or worktree read via overlay
  (`tea-rags worktree info --json` → `isWorktree: false`).

PR-only path (no local merge) → skip step; clone stays until PR merges, note for
later cleanup.

## Red Flags — STOP, restart from Step 2

- "Tests pass, just merge" → green tests miss hotspot/silo/debt by design; run
  Step 2
- "Did verification-before-completion after last commit" → that = per-edit
  blast-radius; this = branch-wide multi-signal tiers
- Direct `semantic_search` / single preset (`"hotspots"` alone) → missed
  convergence; invoke skill
- Scan scoped to last commit → expand to full branch diff
- Options presented before Step 2 → revert, restart
- Inner cycle chains raw `superpowers:requesting-code-review` /
  `superpowers:verification-before-completion` → intercept, invoke
  `dinopowers:Y`
- Merged, `main` not reindexed → stale; run `index_codebase` on `main` (Step 5)
- Clone cleaned via `delete_collection` / dir deletion → leaks DuckDB +
  snapshots + registry; `tea-rags worktree remove <name>`
- `reindex_changes` → deprecated; `index_codebase`
