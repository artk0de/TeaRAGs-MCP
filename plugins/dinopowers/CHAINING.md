# dinopowers Chaining Rule

## Chaining rule (MANDATORY)

Wrapped `superpowers:` skill may instruct next `superpowers:Y` (TDD after
planning, verification after editing, review after completion…). **Redirect
every onward `Skill(superpowers:Y)` → `Skill(dinopowers:Y)` when wrapper
exists.**

Wrapped — use `dinopowers:` form, NOT `superpowers:`:

- `dinopowers:brainstorming`
- `dinopowers:executing-plans`
- `dinopowers:finishing-a-development-branch`
- `dinopowers:receiving-code-review`
- `dinopowers:requesting-code-review`
- `dinopowers:systematic-debugging`
- `dinopowers:test-driven-development`
- `dinopowers:verification-before-completion`
- `dinopowers:writing-plans`
- `dinopowers:writing-skills`

Why: wrapper injects tea-rags signals (ownership, churn, imports, bugFixRate,
risk tiers) BEFORE inner skill; direct `superpowers:Y` skips it.

`superpowers:Y` direct only when Y not listed (e.g.
`superpowers:using-git-worktrees`, `superpowers:subagent-driven-development`).

## Missing superpowers (MANDATORY)

Every wrapper chains into a superpowers skill; dinopowers does not bundle
superpowers. Wrapped `superpowers:` skill not available (not listed, invocation
fails) → STOP and ask the user to install superpowers:

- Source: https://github.com/obra/superpowers
- Claude Code: `/plugin install superpowers@claude-plugins-official`
- Codex / Cursor: the install steps in the superpowers repository README

NEVER run the wrapper's tea-rags enrichment alone and present it as the full
workflow.

Available = `$Y` / `superpowers:Y` is in your skills list. superpowers is a
separate plugin, never under the dinopowers dir — a missing file next to the
wrapper is not "unavailable".
