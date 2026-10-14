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
