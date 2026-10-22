#!/usr/bin/env bash
# Subagent guidance (tea-rags search block + dinopowers wrapper routing) must reach
# EVERY subagent. Two PreToolUse hooks each rewriting the Agent prompt through
# `updatedInput` collide: the hooks run in parallel and only one rewrite lands, so
# one plugin's block was silently lost (observed 2026-10-05: a worktree subagent
# received the tea-rags block and no dinopowers routing). SubagentStart
# `additionalContext` composes instead — every hook's context is added.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TR_HOOK="$ROOT/.claude-plugin/tea-rags/scripts/enforce-tearags-search.sh"
DP_HOOK="$ROOT/.claude-plugin/dinopowers/scripts/inject-wrapper-routing.sh"
TR_PLUGIN="$ROOT/.claude-plugin/tea-rags/.claude-plugin/plugin.json"
DP_PLUGIN="$ROOT/.claude-plugin/dinopowers/.claude-plugin/plugin.json"
PASS=0; FAIL=0
note() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "ok   - $2"; else FAIL=$((FAIL+1)); echo "FAIL - $2"; fi; }

INPUT='{"session_id":"s","hook_event_name":"SubagentStart","agent_type":"general-purpose"}'

TR_OUT="$(echo "$INPUT" | bash "$TR_HOOK" 2>/dev/null)"
DP_OUT="$(echo "$INPUT" | bash "$DP_HOOK" 2>/dev/null)"

# 1. both hooks answer SubagentStart with additionalContext
[ "$(echo "$TR_OUT" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null)" = "SubagentStart" ]
note $? "tea-rags hook answers SubagentStart"
[ "$(echo "$DP_OUT" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null)" = "SubagentStart" ]
note $? "dinopowers hook answers SubagentStart"

# 2. each carries its own block in additionalContext
echo "$TR_OUT" | jq -r '.hookSpecificOutput.additionalContext // empty' | grep -Fq "## Search Tools (MANDATORY"
note $? "tea-rags additionalContext carries the subagent search block"
echo "$DP_OUT" | jq -r '.hookSpecificOutput.additionalContext // empty' | grep -Fq "Dinopowers wrapper routing"
note $? "dinopowers additionalContext carries the wrapper routing table"

# 3. neither rewrites the tool input any more (the colliding channel)
[ -z "$(echo "$TR_OUT" | jq -r '.hookSpecificOutput.updatedInput // empty' 2>/dev/null)" ]
note $? "tea-rags hook does not rewrite tool input"
[ -z "$(echo "$DP_OUT" | jq -r '.hookSpecificOutput.updatedInput // empty' 2>/dev/null)" ]
note $? "dinopowers hook does not rewrite tool input"

# 4. code changes without a plan route to data-driven-generation
echo "$DP_OUT" | jq -r '.hookSpecificOutput.additionalContext // empty' | grep -Fq "tea-rags:data-driven-generation"
note $? "routing names tea-rags:data-driven-generation for code changes"

# 5. both plugins register the hook on SubagentStart and no longer on PreToolUse/Agent
for P in "$TR_PLUGIN" "$DP_PLUGIN"; do
  name="$(basename "$(dirname "$(dirname "$P")")")"
  [ "$(jq '[.hooks.SubagentStart[]?.hooks[]?.command] | length' "$P")" -ge 1 ]
  note $? "$name registers a SubagentStart hook"
  [ "$(jq '[.hooks.PreToolUse[]? | select(.matcher == "Agent")] | length' "$P")" = 0 ]
  note $? "$name has no PreToolUse Agent prompt rewrite"
done

# 6. the tea-rags block opens with the repository's alias (bd tea-rags-mcp-4nqf5),
#    resolved by `tea-rags project exist --repository`; a missing or failing
#    resolver leaves the block unchanged. `tea-rags` is stubbed on PATH.
STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT
mkdir -p "$STUB_DIR/ok" "$STUB_DIR/fail" "$STUB_DIR/none"
cat > "$STUB_DIR/ok/tea-rags" <<'STUB'
#!/bin/bash
# Answers only the exact resolver call the hook must make.
[ "$*" = "project exist --path /repo/wt --repository --print-name" ] || exit 1
echo "demo"
STUB
cat > "$STUB_DIR/fail/tea-rags" <<'STUB'
#!/bin/bash
exit 1
STUB
chmod +x "$STUB_DIR/ok/tea-rags" "$STUB_DIR/fail/tea-rags"
# A PATH with the hook's tools and no tea-rags at all.
for tool in bash jq awk cat dirname; do ln -s "$(command -v "$tool")" "$STUB_DIR/none/$tool"; done

context_with() { # $1 = PATH
  echo "$INPUT" | CLAUDE_PROJECT_DIR=/repo/wt PATH="$1" bash "$TR_HOOK" 2>/dev/null \
    | jq -r '.hookSpecificOutput.additionalContext // empty'
}
BASE_BLOCK="$(context_with "$STUB_DIR/fail:$PATH")"
ALIAS_LINE='tea-rags project alias for this repository: `demo` — pass project="demo" together with path=<your working directory> on every tea-rags call.'

[ "$(context_with "$STUB_DIR/ok:$PATH" | head -n 1)" = "$ALIAS_LINE" ]
note $? "resolved alias is the first line of the injected context"
context_with "$STUB_DIR/ok:$PATH" | grep -Fq "## Search Tools (MANDATORY"
note $? "the search block still follows the alias line"
! printf '%s\n' "$BASE_BLOCK" | grep -Fq "project alias for this repository"
note $? "a failing resolver injects the block without an alias line"
printf '%s\n' "$BASE_BLOCK" | grep -Fq "## Search Tools (MANDATORY"
note $? "a failing resolver still injects the search block"
[ "$(context_with "$STUB_DIR/none")" = "$BASE_BLOCK" ]
note $? "no tea-rags on PATH injects the block unchanged"
echo "$INPUT" | CLAUDE_PROJECT_DIR=/repo/wt PATH="$STUB_DIR/fail:$PATH" bash "$TR_HOOK" >/dev/null 2>&1
note $? "a failing resolver never fails the hook"

echo "# pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
