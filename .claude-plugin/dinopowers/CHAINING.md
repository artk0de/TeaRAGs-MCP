# dinopowers Chaining Rule

## Chaining rule (MANDATORY)

When the wrapped `superpowers:` skill runs its cycle it may instruct you to
invoke another `superpowers:Y` skill next (TDD after planning, verification
after editing, review after completion, etc.). **Redirect every such onward
`Skill(superpowers:Y)` call to `Skill(dinopowers:Y)` whenever a `dinopowers:Y`
wrapper exists.**

Wrapped skills — use the `dinopowers:` form, NOT `superpowers:`:

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

Why: each `dinopowers:Y` wrapper injects tea-rags signals (ownership, churn,
imports, bugFixRate, risk tiers) BEFORE the inner skill runs. A direct
`superpowers:Y` call skips that enrichment — exactly what this wrapper layer
prevents.

Only invoke `superpowers:Y` directly when Y is NOT in the list above (e.g.
`superpowers:using-git-worktrees`, `superpowers:subagent-driven-development`).
