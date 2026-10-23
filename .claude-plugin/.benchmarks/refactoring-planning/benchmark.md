# tea-rags:refactoring-planning Benchmark

**Date:** 2026-10-14 **Eval cases:** 8 **Bead:** tea-rags-mcp-cm9gt.4

## Metrics

| Metric     | Value      |
| ---------- | ---------- |
| With-rule  | 100% (8/8) |
| Baseline   | 38% (3/8)  |
| Delta      | +62pp      |
| Iterations | 1          |

## Method

Blind two-arm run. Subjects were sonnet subagents, one per arm, answering every
scenario from `context` + `prompt` only. Neither arm called an MCP tool or saw
`expected`. The baseline arm read the `get_architecture_report` schema and
description, the four repair `## Ops recipe` sections, architecture-diagnostics
Phase 3i and DDG Step 6b/7. No skill existed at that point. The with-rule arm
read the same files plus the new `SKILL.md`. The orchestrator graded strictly:
every `mustDo` met and no `mustNotDo` hit.

## Cases

| Case                                   | Pins                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `recipe-sdp-inversion`                 | recipe expanded into primitives, foundation path, lexicon check, rationale key |
| `misfit-edge-dropped`                  | MISFIT candidate dropped, `UNJUDGED newFile` kept                              |
| `tradeoffs-not-tasks`                  | trade-offs and unselected listed apart, never Tasks                            |
| `divergence-replans`                   | Step 7 did not converge, so the remaining candidates are re-planned            |
| `scan-annotation-no-reorder`           | refactoring-scan hit becomes a note, order unchanged                           |
| `report-candidates-included`           | cheap estimate leads to `includeReportCandidates` true                         |
| `large-repo-report-candidates-off`     | large repo: `false`, ≤ 15 candidates, bd tea-rags-mcp-vytjl cited              |
| `task-carries-expected-delta-and-gate` | Task carries expected delta + gate line; plan carries execution contract       |

## Baseline failures

- `recipe-sdp-inversion`: the recipe expansion was correct, but the new
  interface name was never checked with `get_naming_lexicon`.
- `tradeoffs-not-tasks`: trade-offs stayed out of the Tasks, but there was no
  hand-off to `dinopowers:writing-plans`.
- `divergence-replans`: the agent stopped and asked the user, following the DDG
  two-round escalation. It proposed the re-plan without running it.
- `large-repo-report-candidates-off`: `false` was right, but all 22 candidates
  went into one call and no reason or bead was given.
- `task-carries-expected-delta-and-gate`: the Task got a "stop and replan" line,
  but there was no execution contract naming `restructurePlan` over the
  remaining candidates.

Three cases pass on both arms: `misfit-edge-dropped`,
`scan-annotation-no-reorder` and `report-candidates-included`. The tool
description and recipes already cover them, so here they only guard against
regression.

## Risks and follow-ups

- The large-repo rule depends on bd tea-rags-mcp-vytjl. Once incremental judging
  or the pre-screen lands, the cost rule in Phase 3 and
  `large-repo-report-candidates-off` need revisiting.
- `divergence-replans` overrides DDG's two-round escalation with a re-plan. If
  DDG Step 7 escalation wording changes, re-run this case.

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet (plan-only simulation, blind; graded by sonnet grader)
- Result: 8/8 PASS (100%)
- Last recorded with-skill rate: 100%
- Delta: +0pp
- FAIL: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default Codex model, plan-only, plugins (tea-rags 0.46.8 + dinopowers 0.24.2 + superpowers 7.0.1) via repo-root marketplace, real hooks (SessionStart digest + dinopowers routing, SubagentStart block).
- Result: 7/8 PASS (88%) over graded cases (N/A excluded: 0).
- Claude T12 for comparison: 8/8 (100%).
- CODEX-ONLY (harness regression candidates):
  - `large-repo-report-candidates-off` — sends all 22 caller candidates in one call (skill caps at 15) and omits bd tea-rags-mcp-vytjl rationale; includeReportCandidates:false was right [model behaviour]
- Both-fail count: 0.

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet (plan-only simulation, blind)
- Result: 8/8 PASS (100%) over scored cases
- Task 12 rate: 8/8 (100%)
- Delta: +0pp
- FAIL:
  - none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1), real hooks (plan-only)
- Result: 5/8 PASS (62%) over 8 graded cases (N/A 0)
- Codex T14 for comparison: 7/8 (88%)
- Claude T22 for comparison: 8/8 (100%)
- FAIL list:
  - ` recipe-sdp-inversion ` — FAIL ( new (T14 PASS); Claude T22 PASS ) never spells the ops (removeEdge / addFile abstract:true / 2x addEdge), foundation component src/core/contracts placement, or rationale = finding key; only "form candidate from recipe" (naming lexicon, plannedEdges, restructurePlan ok) 
  - ` large-repo-report-candidates-off ` — FAIL ( still (different reason: cap 15 + includeReportCandidates:false + not-ordered now OK); Claude T22 PASS ) rationale given as "quadratic judging cost" without citing bd tea-rags-mcp-vytjl / hour-long call 
  - ` task-carries-expected-delta-and-gate ` — FAIL ( new; Claude T22 PASS ) Task carries expected delta, but no quoted `GATE review_changes: introduced=<n>, partial=<bool>` line and execution contract (diverged -> Step 7 -> restructurePlan) not spelled out 

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; strict literal grading)
- Result: 8/8 PASS (100%) over scored cases (superseded: 0)
- Baseline (round 1): 8/8 (100%)
- Delta: +0pp
- FAIL list: none
- Notes: recipe-sdp-inversion names one get_naming_lexicon call over the drafted interface name without spelling the names[] payload — accepted (the check itself is stated).
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 2 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.11 / dinopowers 0.24.4.
- Result: 6/8 PASS (75.0%) (N/A excluded: 0).
- Round-1 Codex: 5/8 (62.5%). Delta: +12.5 pp.
- FAIL list:
  - `recipe-sdp-inversion` — defers to recipe; never spells ops (removeEdge / addFile abstract:true / 2x addEdge), new-file placement under src/core/contracts, or rationale = finding key
  - `large-repo-report-candidates-off` — includeReportCandidates:false + Not ordered right, but sends all 22 caller candidates (mustNotDo; cap ~15 critical-first) and no bd tea-rags-mcp-vytjl citation

## 2026-10-23 — evals-to-100 re-run round 3 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; strict literal grading; no per-case length cap)
- Result: 8/8 PASS (100%) over scored cases (superseded: 0)
- Baseline (round 2): 8/8 (100%)
- Delta: +0pp
- FAIL list: none
- Notes: recipe-sdp-inversion now spells the lexicon payload (`get_naming_lexicon(names=[<drafted interface / file name>])`), closing the round-2 leniency note.
- Context: new SessionStart core+digest / SubagentStart block (tea-rags 0.46.12 / dinopowers 0.24.5, rebuilt from live hook output); old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 3 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.12 / dinopowers 0.24.5.
- Result: 7/8 PASS (87.5%) (N/A excluded: 0).
- Round-2 Codex: 6/8 (75.0%). Delta: +12.5 pp.
- FAIL list:
  - `recipe-sdp-inversion` — lexicon, placement under src/core/contracts, rationale = finding key, restructurePlan all ok, but ops use component dirs (removeEdge worktree→footprint, addEdge <component>→interface) instead of provisioner.ts / footprint-store.ts file edges
