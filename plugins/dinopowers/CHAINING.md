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
superpowers. Availability check — in this order, plan-only included:

1. `$Y` / `superpowers:Y` in your skills list → available.
2. Not in the list → that is NOT evidence: the skills list is truncated to a
   character budget, and superpowers often falls off it. Read its installed file
   with ONE command — Codex:
   `ls $CODEX_HOME/plugins/cache/*/superpowers/*/skills/<Y>/SKILL.md` (default
   `~/.codex`) — run that glob as written: the plugin sits one level down, under
   a marketplace dir (`cache/<marketplace>/superpowers/<version>/`), so a bare
   `ls cache` never shows it. Then read that file. superpowers is a separate
   plugin, never under the dinopowers or tea-rags dir — a hand-built path there
   failing proves nothing; run the glob. Found → available; invoke
   `Skill(superpowers:Y)` after the wrapper's required enrichment.
3. Only when step 2's glob itself matches nothing (or the invocation fails) →
   unavailable: STOP and ask the user to install superpowers:

- Source: https://github.com/obra/superpowers
- Claude Code: `/plugin install superpowers@claude-plugins-official`
- Codex / Cursor: the install steps in the superpowers repository README

Unavailable: NEVER run the wrapper's tea-rags enrichment alone and present it as
the full workflow. A wrapper whose SKILL.md requires its enrichment regardless
(verification-before-completion's scan) runs it first; the missing skill then
blocks only the inner step and any completion claim.
