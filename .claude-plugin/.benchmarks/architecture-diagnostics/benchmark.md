# architecture-diagnostics benchmark

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet (plan-only simulation, blind; graded by sonnet grader)
- Result: 2/2 PASS (100%)
- Last recorded with-skill rate: none recorded
- Delta: n/a (no prior with-skill run)
- FAIL: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default Codex model, plan-only, plugins (tea-rags 0.46.8 + dinopowers 0.24.2 + superpowers 7.0.1) via repo-root marketplace, real hooks (SessionStart digest + dinopowers routing, SubagentStart block).
- Result: 2/2 PASS (100%) over graded cases (N/A excluded: 0).
- Claude T12 for comparison: 2/2 (100%).
- CODEX-ONLY: none.
- Both-fail count: 0.

## 2026-10-23 — Cursor run (Task 15)

- Subject: Cursor CLI (`agent` 2026.10.22-27dcf5f), model `auto`, plugins from harness/cursor (tea-rags + dinopowers), sessionStart hook digest, plan-only.
- Partial run — Cursor free-plan usage limit stopped the eval after 7 of 45 parts.
- Result: 2/2 PASS (100%) over 2 graded cases (N/A excluded: 0)
- Claude T12 for comparison: 2/2 (100%); Codex T14: 2/2 (100%)
- CURSOR-ONLY: none
- Both-fail (all) count: 0
- FAIL list: none

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet (plan-only simulation, blind)
- Result: 2/2 PASS (100%) over scored cases (superseded: 0)
- Task 12 rate: 2/2 (100%)
- Delta: +0pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only, plugins (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1) via repo-root marketplace, real hooks (SessionStart digest + dinopowers routing, SubagentStart block), AGENTS.md = core.
- Result: 0/2 PASS (0%) over graded cases (N/A excluded: 0).
- Codex T14: 2/2 (100%). Claude T22: 2/2 (100%).
- FAIL list:
  - `1` — FAIL; new: Does not class it cheap-preExisting; reads phase-1-report.md in addition to stableDependencies.md (not "only"); remedy restated with placeholders not quoted. Claude T22 PASS
  - `2` — FAIL; new: Declines to infer hubLike-without-preExisting as introduced/must-fix (hedges, "inspect full finding"); mainSequence not stated as report-only; loads phase-1-report too. Claude T22 PASS

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; graded strict-literal)
- Result: 2/2 PASS (100%) over scored cases (superseded: 0)
- Baseline (round 1, Task 22): 2/2 (100%)
- Delta: +0pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 2 (Task 22)
- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.11 / dinopowers 0.24.4.
- Result: 1/2 PASS (50%) (N/A excluded: 0).
- Round-1 Codex: 0/2 (0%). Delta: +50 pp.
- FAIL list:
  - `2` — loads only repair/hubLike.md (mainSequence.md missing), no compositionRoot-vs-bare-"by design" evidence rule, defers the fix pending the full finding.

## 2026-10-23 — evals-to-100 re-run round 3 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; strict literal grading; no per-case length cap)
- Result: 2/2 PASS (100%) over scored cases (superseded: 0)
- Baseline (round 2): 2/2 (100%)
- Delta: +0pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block (tea-rags 0.46.12 / dinopowers 0.24.5, rebuilt from live hook output); old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 3 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.12 / dinopowers 0.24.5.
- Result: 1/2 PASS (50.0%) (N/A excluded: 0).
- Round-2 Codex: 1/2 (50.0%). Delta: ±0.0 pp.
- FAIL list:
  - `2` — mainSequence report-only + hubLike must-fix + both repair files OK, but never states compositionRoot flag = evidence / bare "by design" not; defers the fix if "specifics" lacking

## 2026-10-23 — Codex re-run round 4 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.13 / dinopowers 0.24.6; Codex core adds "read ONE file per command; output past ~10k tokens loses its middle".
- Result: 0/2 PASS (0.0%) (N/A excluded: 0).
- Round-3 Codex: 1/2 (50.0%). Delta: -50.0 pp.
- FAIL list:
  - `1` — classification cheap-preExisting + verbatim remedy fields OK, but repair/stableDependencies.md never loaded — looked for skills/architecture-diagnostics/repair/ (absent), reported "not present" (regression vs R3)
  - `2` — report-only / must-fix split OK, but compositionRoot-as-evidence vs bare "by design" never stated; repair/mainSequence.md + hubLike.md not loaded (wrong path)
