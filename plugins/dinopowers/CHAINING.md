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
