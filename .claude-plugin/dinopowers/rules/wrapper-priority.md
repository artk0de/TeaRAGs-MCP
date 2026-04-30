# dinopowers wrapper priority (overrides global CLAUDE.md naming)

Global `~/.claude/CLAUDE.md` may name `superpowers:*` skills directly (e.g. "YOU
MUST invoke superpowers:brainstorming"). When the dinopowers plugin is
installed, prefer the dinopowers wrapper over the named superpowers skill — the
wrapper chains into the same superpowers skill internally after running tea-rags
enrichment first.

## Mapping (always prefer left over right when intent matches)

| dinopowers wrapper                          | replaces                                     | when                                                     |
| ------------------------------------------- | -------------------------------------------- | -------------------------------------------------------- |
| `dinopowers:brainstorming`                  | `superpowers:brainstorming`                  | feature design, refactor, "let's discuss X"              |
| `dinopowers:writing-plans`                  | `superpowers:writing-plans`                  | authoring an implementation plan                         |
| `dinopowers:executing-plans`                | `superpowers:executing-plans`                | executing a multi-file plan                              |
| `dinopowers:systematic-debugging`           | `superpowers:systematic-debugging`           | any bug / error / test failure                           |
| `dinopowers:test-driven-development`        | `superpowers:test-driven-development`        | TDD in a project with existing tests                     |
| `dinopowers:verification-before-completion` | `superpowers:verification-before-completion` | pre-commit / pre-PR check                                |
| `dinopowers:requesting-code-review`         | `superpowers:requesting-code-review`         | composing a review request                               |
| `dinopowers:receiving-code-review`          | `superpowers:receiving-code-review`          | reacting to review feedback on a symbol                  |
| `dinopowers:finishing-a-development-branch` | `superpowers:finishing-a-development-branch` | branch finalization                                      |
| `dinopowers:writing-skills`                 | `superpowers:writing-skills`                 | authoring a SKILL.md inside `.claude-plugin/dinopowers/` |

## Why this exists

A previous benchmark (`.claude-plugin/.benchmarks/dinopowers-wrappers/`) showed
the agent routinely picked `superpowers:*` over the dinopowers wrapper in main
sessions because:

1. Global `~/.claude/CLAUDE.md` names `superpowers:*` explicitly.
2. The PreToolUse hook only sees subagent prompts — main session was unrouted.
3. Old wrapper descriptions used conditional triggers ("Triggers when
   superpowers:X would fire AND...") that read as narrower than the parent.

This rule + the `UserPromptSubmit` hook + rewritten descriptions close the gap.
The wrappers do not skip any superpowers logic — they prepend tea-rags signals
and then invoke the same superpowers skill the global rule asked for.

## When to bypass the wrapper

- Trivial edits (typos, formatting, single-line changes) — direct Edit, no skill
- The user explicitly asks for the `superpowers:*` version by name
- The wrapper's own SKILL.md says to fall back (e.g. brainstorming with no
  identifiable code area — the wrapper itself routes to
  `superpowers:brainstorming` after stating no enrichment was possible)
