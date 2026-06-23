# Benchmark — bug-hunt codegraph fault-chain (b65a TR2 completion)

bug-hunt already had `trace_path` + `blastRadius`. This completes TR2 by adding
the remaining READY codegraph surfaces: `get_callers`/`get_callees` (fault
chain), `entryPoint` (path origin), `find_cycles` (state-loop hypothesis) — all
codegraph-gated with an OFF fallback.

## Summary

| Metric | Value |
| --- | --- |
| Eval cases | 4 (upstream-origin, entry-then-trace, state-loop, OFF fallback) |
| with-rule FIXED | 4/4 |
| Baseline | not re-measured — session-wide finding applies (see note) |

**Baseline note.** Localized addition; codegraph-presence agent behavior already
measured 3× this session. Value = prescribing the fault-chain tools (so the agent
reaches for get_callers/entryPoint/find_cycles rather than improvising or
stopping at the flat list) + OFF guard + grounding.

## Change

`bug-hunt/SKILL.md`:
- Signal-triage coupling note now names `get_callers` for upstream origins and
  notes codegraph `fanIn` supersedes the `imports` proxy.
- New "Codegraph fault-chain navigation" section (codegraph-gated): `get_callers`
  (upstream origin) / `get_callees` (downstream blast) / `entryPoint` (find the
  `from` for trace_path) / `find_cycles` (state-loop / re-entrancy). One-hop
  first, escalate to `trace_path` for the full chain.

Plugin bump: covered by tea-rags 0.27.0 (same worktree release).

## Per-case verdicts (fixed)

| Case | ENV | verdict |
| --- | --- | --- |
| 1 upstream-origin | B | PASS — find_symbol → get_callers |
| 2 entry-then-trace | B | PASS — entryPoint → trace_path |
| 3 state-loop | B | PASS — find_cycles scope=method |
| 4 off-fallback | A | PASS — flat list + manual, tools absent |

## Note

Gated state-loop / chain presets requiring C-AST are not involved; all four
surfaces here are Slice-2 READY.
