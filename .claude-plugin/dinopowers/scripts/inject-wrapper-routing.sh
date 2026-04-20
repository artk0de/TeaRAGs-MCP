#!/bin/bash
# PreToolUse hook for Agent tool: route subagent prompts through dinopowers wrappers
# when their intent matches a wrapper's trigger (brainstorming, planning, debugging,
# TDD, review, completion). Ensures subagents don't bypass the tea-rags enrichment
# layer by invoking superpowers:* or ad-hoc tools directly.

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty')

if [ -z "$PROMPT" ]; then
  exit 0
fi

SUFFIX="

## Dinopowers wrapper routing (MANDATORY — overrides direct superpowers:* invocation)

Subagent intents matching any row below MUST invoke the dinopowers wrapper BEFORE
(or instead of) the direct superpowers:* skill. The wrapper runs tea-rags
enrichment, then chains to superpowers internally.

| If your task is... | Invoke |
|---|---|
| Brainstorming a feature/refactor with a named code area | Skill(dinopowers:brainstorming) |
| Authoring an implementation plan with a file list | Skill(dinopowers:writing-plans) |
| Executing plan Tasks that modify files | Skill(dinopowers:executing-plans) |
| Debugging a concrete symptom (error, stack trace, test failure) | Skill(dinopowers:systematic-debugging) |
| Writing a new failing test (TDD RED phase) | Skill(dinopowers:test-driven-development) |
| Claiming work complete / before commit / before PR | Skill(dinopowers:verification-before-completion) |
| Agreeing/pushing back on a review comment that names a symbol | Skill(dinopowers:receiving-code-review) |
| Composing a code review request with a diff | Skill(dinopowers:requesting-code-review) |
| Finalizing a dev branch (merge/PR/cleanup decision) | Skill(dinopowers:finishing-a-development-branch) |
| Creating a new dinopowers wrapper SKILL.md | Skill(dinopowers:writing-skills) |

**Rules:**
- Do NOT invoke superpowers:brainstorming/writing-plans/executing-plans/systematic-debugging/test-driven-development/verification-before-completion/receiving-code-review/requesting-code-review/finishing-a-development-branch directly if the corresponding dinopowers:* wrapper applies. The wrapper calls superpowers internally with tea-rags context prepended.
- Stylistic / trivial cases (typos, one-word edits, listings, counting questions) bypass the wrapper — dinopowers descriptions explicitly exclude them.
- If a wrapper doesn't match your intent, invoke superpowers:* directly.
- These routing rules take priority over any skill that says \"invoke superpowers:X\" for a matching intent."

UPDATED_PROMPT="${PROMPT}${SUFFIX}"

jq -n --arg prompt "$UPDATED_PROMPT" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: {
      prompt: $prompt
    }
  }
}'
