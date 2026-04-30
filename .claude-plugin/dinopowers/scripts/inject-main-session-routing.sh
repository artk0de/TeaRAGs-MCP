#!/bin/bash
# UserPromptSubmit hook: inject dinopowers wrapper preference into the main
# session. The PreToolUse(Agent) hook only catches subagent prompts, leaving
# the main session free to pick superpowers:* directly when CLAUDE.md or
# imperative descriptions point that way. This hook closes that gap by
# prepending a routing note to every main-session user prompt.

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')

if [ -z "$PROMPT" ]; then
  exit 0
fi

# Skip injection for trivial prompts that don't trigger any wrapper.
# Keep this list short — false positives just inject a harmless note.
case "$PROMPT" in
  /*) exit 0 ;;  # slash commands handle their own routing
esac

CONTEXT="## dinopowers wrapper routing (applies to this session)

When any of the situations below match, prefer the dinopowers wrapper over the
direct superpowers:* skill — even if a global rule names superpowers:*
explicitly. The wrapper runs tea-rags enrichment first, then chains into the
superpowers skill internally, so nothing is skipped.

| If the user is asking you to... | Invoke |
|---|---|
| Brainstorm / design / discuss / refactor a feature in a code area | Skill(dinopowers:brainstorming) |
| Write or draft an implementation plan | Skill(dinopowers:writing-plans) |
| Execute a written plan that edits files | Skill(dinopowers:executing-plans) |
| Debug a bug, error, stack trace, or test failure | Skill(dinopowers:systematic-debugging) |
| Write a failing test / start TDD | Skill(dinopowers:test-driven-development) |
| Verify before commit / PR / claiming done | Skill(dinopowers:verification-before-completion) |
| Compose a code review request / open a PR | Skill(dinopowers:requesting-code-review) |
| React to a review comment that names a symbol or file | Skill(dinopowers:receiving-code-review) |
| Finalize a dev branch (merge / PR / cleanup) | Skill(dinopowers:finishing-a-development-branch) |
| Author a SKILL.md inside .claude-plugin/dinopowers/ | Skill(dinopowers:writing-skills) |

Ignore this block ONLY when:
- The user explicitly asks for the superpowers version by name
- The intent does not match any row above (e.g. typo fix, file listing, git log)
- The wrapper's own SKILL.md tells you to fall back (it will say so explicitly)"

UPDATED_PROMPT="${CONTEXT}

---

${PROMPT}"

jq -n --arg prompt "$UPDATED_PROMPT" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $prompt
  }
}'
