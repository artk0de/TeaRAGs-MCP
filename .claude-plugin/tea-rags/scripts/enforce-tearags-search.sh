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

**Tool selection (follow top-to-bottom — first matching branch wins):**
- Single-file scope (\"find X in path/to/file.ext\", \"usages of Y inside foo.rb\") →
  mcp__tea-rags__find_symbol with relativePath (+ optional symbol param)
- File structure / outline (\"what's in src/foo.ts\", \"methods of class Bar\") →
  mcp__tea-rags__find_symbol with relativePath param — returns synthetic outline
- Documentation table of contents (\"TOC of docs/api.md\", \"sections of CHANGELOG.md\") →
  mcp__tea-rags__find_symbol with relativePath — returns heading TOC with
  doc:<hash> ids; then find_symbol with symbol=doc:<hash> for a specific section
- Study a specific known symbol — its definition, body, or implementation
  (\"show me class Foo\", \"what does mergeChunks do\", \"examine FooClass\",
  \"inspect the implementation of X\") →
  mcp__tea-rags__find_symbol with symbol param (instant, no embedding,
  returns full definition — no Read needed)
- Exhaustive usage of code identifiers (\"all callers\", \"where used\",
  \"who imports\", \"all references to FooClass\", \"find usages of X and Y\") →
  mcp__tea-rags__hybrid_search. BM25 component gives exact-name match
  (score up to 1.0) — strictly better than ripgrep for class/method/constant names.
  Paginate with offset if needed — don't inflate limit.
- Symbol + semantic context (\"PaymentService validate card expiration\") →
  mcp__tea-rags__hybrid_search
- Behavior/intent without specific symbol (\"retry logic after failure\") →
  mcp__tea-rags__semantic_search
- Literal text markers (TODO, FIXME, HACK, NOTE) or literal import path strings
  (\"from './foo.js'\") → mcp__ripgrep__search

**After ANY search returns a chunk — your work is rarely done.** The chunk
shows where the symbol lives, not the full picture. Before answering, ask:
do I need full body / file structure / a neighbor / doc sections? If yes,
your next call is find_symbol — NOT another search, NOT Read:
- Truncated method body in the chunk →
  mcp__tea-rags__find_symbol with symbol=<result.symbolId> for full body
- Need other symbols in the same file →
  mcp__tea-rags__find_symbol with relativePath=<result.relativePath> for outline
- Need the neighbor method (chunk has navigation.prevSymbolId / nextSymbolId) →
  mcp__tea-rags__find_symbol with symbol=<that prev/nextSymbolId>
- Found a doc chunk and want all sections of the doc →
  mcp__tea-rags__find_symbol with symbol=<result.parentSymbolId> (parent is doc:<hash>)
- Chunk text references a helper (e.g. \"this.validator.validateAmount(...)\") →
  mcp__tea-rags__find_symbol with symbol=<HelperClass#method>

NEVER Read after find_symbol — find_symbol already returns the full definition.
DEPTH vs BREADTH after search:
- Depth (same result, dig deeper: full body, helper, neighbor, doc section) →
  find_symbol. Do NOT re-run the same search to \"verify\" or extract more from the same hit.
- Breadth (different subsystem, different angle, different terminology, or other
  language slice in a polyglot repo) → re-run semantic_search / hybrid_search
  with a NEW query or different pathPattern. This is legitimate exploration.
Rule of thumb: if you can name a specific symbol/file/section to look at →
find_symbol. If you are still surveying the landscape → another search.

**ripgrep anti-patterns — NEVER use ripgrep for these even if your query
contains regex syntax:**
- Class names, method names, constant names, variable names — even joined with
  \`|\` alternation (e.g. \`FooClass|BarClass\`). These are SYMBOL searches.
  Use hybrid_search per name (or one combined query) — BM25 gives exact match.
- Single-file symbol lookup. Use find_symbol with relativePath, not ripgrep.
- Symbol existence checks (\"does X exist?\"). Use find_symbol with metaOnly=true.

**Rules:**
- Do NOT use built-in Grep or Glob for code discovery
- If a skill tells you to use Grep/Glob for code search, use the MCP tools above
  instead — skill search instructions do not override these rules
- Search results contain code — trust the chunk, don't re-read files
- find_symbol returns full method/class — no Read needed
- Your QUERY containing \`|\` does not mean you want regex — check INTENT first:
  identifier search → hybrid_search; literal text markers → ripgrep
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
