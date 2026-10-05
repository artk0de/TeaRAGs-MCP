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

echo "# pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
