#!/usr/bin/env bash
# tests/hooks/agent-context-budgets.test.sh — overflow past a harness cap is silent
# (Claude Code: 10,000 chars → 2,000-char preview), so every always-on artifact
# carries a byte budget here.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0; FAIL=0
note() { if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "ok   - $2"; else FAIL=$((FAIL+1)); echo "FAIL - $2"; fi; }

# Subagent block, measured WITH the alias line: `tea-rags` is stubbed to resolve a
# long-ish alias so the prepended line counts against the cap.
SUBAGENT_CAP=3000
STUB_DIR="$(mktemp -d)"; trap 'rm -rf "$STUB_DIR"' EXIT
printf '#!/bin/bash\necho tea-rags-mcp-alias\n' > "$STUB_DIR/tea-rags"; chmod +x "$STUB_DIR/tea-rags"
INPUT='{"session_id":"s","hook_event_name":"SubagentStart","agent_type":"general-purpose"}'
BLOCK="$(echo "$INPUT" | CLAUDE_PROJECT_DIR=/repo PATH="$STUB_DIR:$PATH" bash "$ROOT/plugins/tea-rags/scripts/enforce-tearags-search.sh" | jq -r '.hookSpecificOutput.additionalContext')"
printf %s "$BLOCK" | head -n 1 | grep -Fq '`tea-rags-mcp-alias`'; note $? "subagent block measured with the alias line"
[ "$(printf %s "$BLOCK" | wc -c)" -le $SUBAGENT_CAP ]; note $? "subagent block incl. alias line ≤ $SUBAGENT_CAP bytes"
# Harness-neutral: the Codex/Cursor transforms rewrite only `mcp__tea-rags__`, so the
# block must not name Claude-only tools.
! printf %s "$BLOCK" | grep -Eq 'mcp__ripgrep|Grep/Glob'; note $? "subagent block names no Claude-only search tools"

# dinopowers main-session routing: injected once per session (SessionStart, re-fired
# on compaction), never per prompt, never echoing the prompt.
DP_ROUTING="$ROOT/plugins/dinopowers/scripts/inject-main-session-routing.sh"
DP_PLUGIN="$ROOT/plugins/dinopowers/.claude-plugin/plugin.json"
SS_INPUT='{"session_id":"s","hook_event_name":"SessionStart","source":"compact","prompt":"PROMPT-SENTINEL-42"}'
SS_OUT="$(echo "$SS_INPUT" | bash "$DP_ROUTING" 2>/dev/null)"
[ "$(echo "$SS_OUT" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null)" = "SessionStart" ]
note $? "main-session routing answers SessionStart"
SS_CTX="$(echo "$SS_OUT" | jq -r '.hookSpecificOutput.additionalContext // empty' 2>/dev/null)"
printf %s "$SS_CTX" | grep -Fq "dinopowers:brainstorming"; note $? "main-session routing carries the wrapper table"
[ "$(printf %s "$SS_CTX" | wc -c)" -le 2500 ]; note $? "main-session routing ≤ 2500 bytes"
! printf %s "$SS_OUT" | grep -Fq "PROMPT-SENTINEL-42"; note $? "main-session routing never echoes the prompt"
[ "$(jq '[.hooks.SessionStart[]?.hooks[]?.command | select(test("inject-main-session-routing"))] | length' "$DP_PLUGIN")" = 1 ]
note $? "dinopowers registers main-session routing on SessionStart"
[ "$(jq '.hooks.UserPromptSubmit // [] | length' "$DP_PLUGIN")" = 0 ]
note $? "dinopowers injects nothing per prompt (no UserPromptSubmit hook)"

# SessionStart rules injection: one part, ≤ 8,000 bytes (the core; guides are served on demand).
INJECT="$ROOT/plugins/tea-rags/scripts/inject-rules.sh"
[ "$(bash "$INJECT" --count)" = 1 ]; note $? "rules injection is one part"
[ "$(bash "$INJECT" --part 1 --parts 1 | wc -c)" -le 8000 ]; note $? "rules injection ≤ 8000 bytes"
[ "$(bash "$INJECT" | wc -c)" -le 8000 ]; note $? "legacy no-arg rules dump ≤ 8000 bytes"
# core.md ≤ 6,400 chars. Server `instructions` get a ≤ 4,096 head of it plus a
# pointer to tea-rags://guide/core (serverInstructions); the SessionStart hooks and
# Cursor's tea-rags-core.mdc (≤ 6,800 incl. wrapper) carry the full core. Codex's
# hook budget of 8,500 is shared with the digest — fit-digest trims the digest.
CORE="$ROOT/plugins/tea-rags/rules/core.md"
[ -f "$CORE" ] && [ "$(node -e 'console.log(require("fs").readFileSync(process.argv[1],"utf8").length)' "$CORE")" -le 6400 ]
note $? "rules/core.md ≤ 6400 chars (instructions head ≤ 4096; Cursor documents no size cap, rules < 500 lines)"

# Description = value of the top-level `description:` key: inline text, or an
# indented block (plain, `>` / `|` folded) running to the next top-level key.
desc_len() {
  node -e '
    const t=require("fs").readFileSync(process.argv[1],"utf8");
    const m=t.match(/^---\r?\n([\s\S]*?)\r?\n---/); if(!m){console.log(0);process.exit()}
    const lines=m[1].split(/\r?\n/);
    const i=lines.findIndex(l=>/^description:/.test(l));
    if(i<0){console.log(0);process.exit()}
    const parts=[lines[i].replace(/^description:\s*/,"")];
    for(let j=i+1;j<lines.length&&!/^[A-Za-z_][\w-]*:/.test(lines[j]);j++)parts.push(lines[j]);
    let v=parts.join(" ").replace(/\s+/g," ").trim().replace(/^[>|][+-]?\s*/,"");
    if(/^(".*"|'"'"'.*'"'"')$/.test(v))v=v.slice(1,-1);
    console.log(v.length)' "$1"
}

for f in "$ROOT"/plugins/*/skills/*/SKILL.md; do
  LEN="$(desc_len "$f")"
  [ "$LEN" -le 1024 ]; note $? "description ≤ 1024 chars: ${f#$ROOT/} ($LEN)"
done
echo "# pass=$PASS fail=$FAIL"; [ $FAIL = 0 ]
