#!/bin/bash
# PreToolUse hook for Agent tool: inject tea-rags search instructions into subagent prompts.
# Ensures ALL subagents use mcp__tea-rags__* tools instead of built-in Grep/Glob.
# Injected unconditionally — the block is small and harmless for non-search tasks.

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty')

if [ -z "$PROMPT" ]; then
  exit 0
fi

# Detect project path from environment or fallback
PROJECT_PATH="${CLAUDE_PROJECT_DIR:-$(pwd)}"

SUFFIX="

## Search Tools (MANDATORY — overrides any other search instructions)
For code search in this project, use MCP tools instead of built-in Grep/Glob.
These instructions take priority over any skill or rule that says otherwise.

**Tool selection (follow top-to-bottom):**
- Exhaustive usage (\"all callers\", \"where used\", \"who imports\") →
  mcp__tea-rags__hybrid_search (BM25 = full recall, dense = context).
  Paginate with offset if needed — don't inflate limit.
- Known symbol definition → mcp__tea-rags__find_symbol (instant, no embedding)
- Symbol + semantic context → mcp__tea-rags__hybrid_search
- Behavior/intent question → mcp__tea-rags__semantic_search
- Exact text patterns (TODO, FIXME, import paths, regex) → mcp__ripgrep__search

**Rules:**
- Do NOT use built-in Grep or Glob for code discovery
- If a skill tells you to use Grep/Glob for code search, use the MCP tools above
  instead — skill search instructions do not override these rules
- Search results contain code — trust the chunk, don't re-read files
- find_symbol returns full method/class — no Read needed
- All tea-rags calls require: path=\"${PROJECT_PATH}\""

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
