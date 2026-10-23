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

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace, real hooks (plan-only)
- Result: 5/10 PASS (50%) over graded cases (N/A excluded: 0)
- Claude T12 rate for comparison: 5/10 (50%)
- CODEX-ONLY: none
- Both-fail count: 5

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet (plan-only simulation, blind)
- Result: 9/10 PASS (90%) over scored cases (superseded: 0)
- Task 12 rate: 5/10 (50%)
- Delta: +40pp
- FAIL list: 
  - `eval-10` — schema-drift message without a `Run:` line: subject hedges (force-reindex only if Run carries --force, otherwise silent incremental index_codebase) instead of routing to /tea-rags:force-reindex and explaining incremental will not populate new fields
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only, plugins (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1) via repo-root marketplace, real hooks (SessionStart digest + dinopowers routing, SubagentStart block), AGENTS.md = core.
- Result: 7/10 PASS (70%) over graded cases (N/A excluded: 0).
- Codex T14: 5/10 (50%). Claude T22: 9/10 (90%).
- FAIL list:
  - `eval-1` — FAIL; still (T14 FAIL; expectation noted STALE by Claude T12, now realigned): Unregistered branch lacks the "declined -> index_codebase path=" fallback; uses projectName param. Claude T22 PASS
  - `eval-2` — FAIL; still: No linked-worktree branch (do not register/index; read tools already answer), no declined fallback. Claude T22 PASS
  - `eval-10` — FAIL (stale?); same as Claude T22 FAIL: Asks for the `Run:` line instead of routing to force-reindex and stating incremental will not populate new fields; same hedge Claude T22 hit (drift message without Run: line)

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; strict literal grading per round-2 rules)
- Result: 8/10 PASS (80%) over scored cases (superseded: 0)
- Baseline (round 1): 9/10 (90%)
- Delta: -10pp (eval-10 fixed; eval-5/eval-6 now fail under literal grading)
- FAIL list:
  - eval-5 — [QDRANT_UNAVAILABLE]: tells the user to run the hint and re-check status afterwards, but never states STOP + AskUserQuestion + wait for an explicit answer; degraded guide read only conditionally. guides/degraded.md carries the STOP/ask/wait rule for the embedding provider only (no Qdrant-outage line); index SKILL.md has no error-code handling at all.
  - eval-6 — [OLLAMA_UNAVAILABLE]: reads the degraded guide but plans "tell the user to run ollama serve, then re-run status" — no explicit AskUserQuestion / wait for the user's answer, the MUST of degraded.md l.21-22.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 2 (Task 22)
- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.11 / dinopowers 0.24.4.
- Result: 8/10 PASS (80%) (N/A excluded: 0).
- Round-1 Codex: 7/10 (70%). Delta: +10.0 pp.
- FAIL list:
  - `eval-1` — confirmed first index via MCP index_codebase(path, name) instead of `tea-rags index-codebase <path> --name <alias>`.
  - `eval-2` — no linked-worktree branch (do not register/index); confirmed route again not the CLI.

## 2026-10-23 — evals-to-100 re-run round 3 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; strict literal grading; no per-case length cap)
- Result: 10/10 PASS (100%) over scored cases (superseded: 0)
- Baseline (round 2): 8/10 (80%)
- Delta: +20pp (eval-5 / eval-6 fixed: both now STOP, AskUserQuestion with the Hint, WAIT for the explicit answer, never run the fix unasked, then a LIVE get_index_status retry; eval-6 additionally reads guide/degraded and keeps find_symbol / hybrid_search BM25 usable)
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block (tea-rags 0.46.12 / dinopowers 0.24.5, rebuilt from live hook output); old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 3 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.12 / dinopowers 0.24.5.
- Result: 8/10 PASS (80.0%) (N/A excluded: 0).
- Round-2 Codex: 8/10 (80.0%). Delta: +0.0 pp.
- FAIL list:
  - `eval-2` — cwd default + list_projects + CLI --name route ok, but no linked-worktree branch (do not register/index; read tools already answer)
  - `eval-9` — labels the status question "Навык: $tea-rags:index" (mustNotTrigger index skill); get_index_status itself correct
