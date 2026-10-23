# tea-rags:index Optimization Benchmark

**Date:** 2026-04-21 **Eval cases:** 10

| Metric    | Value        |
| --------- | ------------ |
| With-rule | 100% (10/10) |
| Baseline  | 50% (5/10)   |
| Delta     | +50pp        |

## Core Value

Simplest skill — just a wrapper over `mcp__tea-rags__index_codebase` with 3
enforcement points:

1. **Direct MCP call** (no subagent — overhead 10-15s dwarfs 1-3s reindex)
2. **Routing discipline** — `forceReindex=true` belongs to
   `/tea-rags:force-reindex`, never called from this skill
3. **Error handling** — parse `[CODE]` from isError responses, read Hint,
   confirm with user BEFORE executing fix

## Failure Analysis (baseline 5/10 FAIL)

1. **No-subagent rule** (eval-3) — baseline complies with user's "delegate to
   subagent" despite overhead
2. **forceReindex boundary** (evals 4, 8, 10) — baseline directly calls
   `index_codebase(forceReindex=true)` instead of routing to
   `/tea-rags:force-reindex` which owns the destructive confirmation flow
3. **Full metrics reporting** (eval-7) — baseline condenses result into summary
   prose, loses numbers

## Delta Interpretation

+50pp exactly hits methodology target. Baseline handles obvious cases (direct
path, cwd default, error-hint propose+confirm flow, status check routing)
correctly. Skill adds value specifically on:

- **Skill-to-skill boundaries** (index vs force-reindex separation)
- **Subagent overhead discipline** (most agents don't know 10-15s delegation is
  worse than 1-3s direct call)
- **Verbose reporting** (default is summarize; skill mandates FULL metrics)

## Iteration Log

**Iteration 0:** 10/10 with-rule, 5/10 baseline (50%), delta +50pp. No fix
needed.

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet (plan-only simulation, blind; graded by sonnet grader)
- Result: 5/10 PASS (50%)
- Last recorded with-skill rate: 100%
- Delta: -50pp
- FAIL:
  - `eval-1` — main flow uses project alias or CLI index-codebase --name; index_codebase with path only on decline, not the required call | STALE
  - `eval-2` — plan calls index_codebase with project alias or CLI --name, not index_codebase with path=cwd | STALE
  - `eval-5` — no explicit [CODE] parse; user is asked to start Qdrant, agent never executes the fix after confirm | STALE
  - `eval-6` — user is asked to start ollama serve; agent never executes the fix after confirm | STALE
  - `eval-8` — default flow is incremental index_codebase; routing to force-reindex only conditional on drift or bad data | REAL
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).
