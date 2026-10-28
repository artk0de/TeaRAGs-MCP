# Per-Turn Routing Re-Inject

**Owner:** `scripts/turn-routing.sh`, run on every user prompt (Claude Code and
Codex `UserPromptSubmit`; Cursor `beforeSubmitPrompt` arms the turn and its
first `postToolUse` delivers). Benchmarks showed tea-rags use collapsing after
~14 questions of one session while the SessionStart core stayed in context: a
short restatement at each turn keeps the routing current.

Single source: the generators copy the block below into each harness
(`scripts/turn-routing.txt`, harness dialect). Keep it ≤ 400 bytes — the test
`tests/hooks/turn-routing.test.sh` pins it — and keep it a restatement of
`rules/core.md` routing, never a new rule.

## The block to inject

```
tea-rags routing (this turn):
- source code via find_symbol; config/migrations/specs, stubs → default code read tool
- behaviour/concept words → semantic_search
- how it works / impact → get_callees / get_callers
- exact text, all X in a dir, absence → default code search tool
- ids or files needed at once: ONE find_symbol(symbols:[…])
```
