# dinopowers Chaining Rule

## Chaining rule (MANDATORY)

Wrapped `superpowers:` skill may instruct next `$Y` (TDD after planning,
verification after editing, review after completion…). **Redirect every onward
`$Y` → `$dino-Y` when wrapper exists.**

Wrapped — use `dinopowers:` form, NOT `superpowers:`:

- `$dino-brainstorming`
- `$dino-executing-plans`
- `$dino-finishing-a-development-branch`
- `$dino-receiving-code-review`
- `$dino-requesting-code-review`
- `$dino-systematic-debugging`
- `$dino-test-driven-development`
- `$dino-verification-before-completion`
- `$dino-writing-plans`
- `$dino-writing-skills`

Why: wrapper injects tea-rags signals (ownership, churn, imports, bugFixRate,
risk tiers) BEFORE inner skill; direct `$Y` skips it.

`$Y` direct only when Y not listed (e.g. `$using-git-worktrees`,
`$subagent-driven-development`).

## Missing superpowers (MANDATORY)

Every wrapper chains into a superpowers skill; dinopowers does not bundle
superpowers. Wrapped `superpowers:` skill not available (not listed, invocation
fails) → STOP and ask the user to install superpowers:

- Source: https://github.com/obra/superpowers
- Claude Code: `/plugin install superpowers@claude-plugins-official`
- Codex / Cursor: the install steps in the superpowers repository README

NEVER run the wrapper's tea-rags enrichment alone and present it as the full
workflow.

Available = `$Y` / `$Y` is in your skills list. superpowers is a separate
plugin, never under the dinopowers dir — a missing file next to the wrapper is
not "unavailable".
