#!/bin/bash
# SessionStart hook: hand the main session the dinopowers wrapper routing once.
# SubagentStart covers subagents (inject-wrapper-routing.sh); without this note the
# main session picks superpowers:* directly when CLAUDE.md or a skill names it.
# SessionStart re-fires on compaction, so the note survives it — no per-prompt
# injection, and the prompt is never read or echoed.

cat > /dev/null

CONTEXT="## dinopowers wrapper routing (applies to this session)

Matching intent → dinopowers wrapper, not the direct superpowers:* skill — even if
a global rule names superpowers:*. Wrapper runs tea-rags enrichment, then chains
into superpowers itself; nothing skipped.

| User asks to... | Invoke |
|---|---|
| Write / change production code outside a written plan (it owns RED + GREEN) | Skill(tea-rags:data-driven-generation) |
| Brainstorm / design / refactor a feature in a code area | Skill(dinopowers:brainstorming) |
| Write an implementation plan | Skill(dinopowers:writing-plans) |
| Execute a written plan that edits files | Skill(dinopowers:executing-plans) |
| Debug a bug, error, stack trace, test failure | Skill(dinopowers:systematic-debugging) |
| Write a failing test only, no production change | Skill(dinopowers:test-driven-development) |
| Verify before commit / PR / claiming done | Skill(dinopowers:verification-before-completion) |
| Request a code review / open a PR | Skill(dinopowers:requesting-code-review) |
| React to a review comment naming a symbol or file | Skill(dinopowers:receiving-code-review) |
| Finalize a dev branch (merge / PR / cleanup) | Skill(dinopowers:finishing-a-development-branch) |
| Author a SKILL.md in plugins/dinopowers/ | Skill(dinopowers:writing-skills) |

Ignore ONLY when: user names the superpowers version explicitly; intent matches no
row (typo fix, listing, git log); the wrapper's SKILL.md says to fall back."

jq -n --arg context "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $context
  }
}'
exit 0
