# Benchmark — codegraph-presence-fallback

Bead **tea-rags-mcp-3hkuy**. Cross-cutting correctness pass so skills that route
to codegraph graph-tools detect codegraph availability from the **prime digest**
and fall back to non-codegraph routes (or honest "unavailable") when codegraph
is OFF — without falsely claiming "no cycles", dropping a hypothesis, or naming
an architectural centre they cannot measure.

## Summary

| Metric | Value |
| --- | --- |
| Scope (decided) | Full cross-cutting: `search-cascade.md` (canon) + `explore` SKILL + 4 patterns + `bug-hunt` + `systematic-debugging` + `receiving-code-review` |
| Eval cases | 13 (6 audit-finding OFF, 5 controls ON, 2 subagent-context, incl. 1 non-English) |
| with-rule (current) | 13/13 (100%) |
| without-rule baseline | 12/13 (92%) — case 3 ripgrep-first |
| with-rule (FIXED) | 13/13 (100%), no ON-control regression |
| Behavioral delta (Opus-class) | +8pp — concentrated on fallback route quality, NOT on the audited false-claims |

## Key finding — registration gating reframes the premise

`src/mcp/tools/codegraph.ts:128` gates the four graph tools at registration:
`if (!app.hasProvider("codegraph.symbols")) return;`. When codegraph is OFF the
tools are **not registered** — absent from the tool list, NOT returning empty.

Consequence measured by the honest eval (raw prime block + per-ENV tool list, no
editorial hint): an Opus-class agent trivially infers "graph facts not
computable" from tool absence and **refuses** the dangerous false-claims the
audit hypothesized (F2 false-DAG, F3 drop-hypothesis). Both with-rule and
without-rule arms passed those cases. The audit's premise — that skills would
call a tool, get empty, and misreport — does not hold for a strong model under
registration gating.

The first eval run scored 100%/100% because the harness was **contaminated**
(the tool list told both arms "tools return empty when codegraph disabled" and
the prime was annotated "[NO codegraph.symbols — means OFF]"). The contaminated
run is archived at `workspace/iteration-1/contaminated-v1/`. The honest re-run
(graph tools simply absent from ENV-A, raw prime) is the reported baseline.

## What the fix actually delivers (decided scope: lean correctness-pass)

The value is instruction **correctness** + robustness for weaker subagent
models, not a measured Opus behavior gap:

| # | File | Change |
| --- | --- | --- |
| F1 | `search-cascade.md` Graph navigation | Added prime `codegraph.symbols` availability signal + a "When codegraph is off" per-intent fallback table (the canonical source). |
| F4 | `search-cascade.md` Fallback Chains | Split "Call path A→B" into codegraph-on (trace_path) vs codegraph-off (semantic/hybrid + manual) — the old fallback `get_callees` is itself codegraph-dependent. |
| F1 | `explore/SKILL.md` | "return empty for every input" → "not registered / absent from tool list"; check prime first. |
| F1 | `usage-pattern.md` | Same correction; "prime shows no codegraph.symbols ⇒ get_callers/get_callees not registered". |
| F2 | `cycle-pattern.md` | "empty = DAG" now gated on codegraph ON; when find_cycles is unregistered, empty is NOT a DAG — say cycle detection unavailable. |
| F5 | `architecture-pattern.md` | Added codegraph-off note distinct from no-hubs-in-scope; fan-in centrality unavailable, no false "architectural centre". |
| F5 | `entry-point-pattern.md` | Added codegraph-off note; relevance + chunkSize, flagged content-inferred. |
| F3 | `systematic-debugging.md` | Anti-pattern row "empty trace_path = structurally false → drop" gated on codegraph ON; when off, trace_path absent ≠ evidence, keep hypothesis. Step 3.5 precondition added. |
| F6 | `bug-hunt/SKILL.md` | trace_path chain step gated on codegraph ON; off ⇒ flat suspects only. |
| F6 | `receiving-code-review/SKILL.md` | Step 3.5 trace_path route gated on codegraph ON; off ⇒ stay with Step 2 fanIn. |

Plugin bumps (patch, text-only): tea-rags 0.26.0 → 0.26.1, dinopowers 0.17.5 → 0.17.6.

## Per-case verdicts (honest harness)

| Case | ENV | without-rule | with-rule current | with-rule FIXED |
| --- | --- | --- | --- | --- |
| 1 cycle-off-no-false-dag | A | PASS | PASS | PASS |
| 2 sysdebug-off-no-drop | A | PASS | PASS | PASS |
| 3 usage-off-fallback | A | FAIL (ripgrep-first) | PASS | PASS |
| 4 tracepath-off-fallback | A | PASS | PASS | PASS |
| 5 architecture-off | A | PASS | PASS | PASS |
| 6 bughunt-off-flat | A | PASS | PASS | PASS |
| 7 control-cycle-on | B | PASS | PASS | PASS |
| 8 control-usage-on | B | PASS | PASS | PASS |
| 9 control-tracepath-on | B | PASS | PASS | PASS |
| 10 edge-on-genuine-empty-dag | B | PASS | PASS | PASS |
| 11 edge-nonenglish-off | A | PASS | PASS | PASS |
| 12 subagent-explore-off | A | PASS | PASS | PASS |
| 13 subagent-taskagent-on | B | PASS | PASS | PASS |

## Honest limitations

- Delta is small for an Opus-class agent — tool-absence is self-evident. The fix
  is justified by correctness (the "returns empty" text was factually wrong) and
  by weaker-model robustness (subagents may run on haiku), which this Opus-only
  eval cannot fully measure.
- Eval tests INSTRUCTION CLARITY (tool selection plan), not live tool execution.

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet
- Result: 13/13 PASS (100%)
- Last recorded rate: 100% (13/13 with_rule_fixed, honest-v2)
- FAIL list: none
- Notes: Artifact mapped to context-main.md/context-subagent.md + guides/navigation.md 'When codegraph is off' + tea-rags:explore/bug-hunt skills. Delta 0pp.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace, real hooks (plan-only)
- Result: 13/13 PASS (100%) over graded cases (N/A excluded: 0)
- Claude T12 rate for comparison: 13/13 (100%)
- CODEX-ONLY: none
- Both-fail count: 0

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet (plan-only simulation; graded strictly, borderline = FAIL)
- Result: 5/13 PASS (38%) over scored cases. Subject sonnet; 0 superseded.
- Task 12 rate: 100% (13/13)
- Delta: -62pp
- FAIL list: 
  - 1,2,3,4,5,6,11,12 (all codegraph-OFF cases) — subject decided codegraph ON from its own registered tool list and ignored the scenario prime-digest signal (the eval keys on the missing `codegraph.symbols` line; context-main.md l.46 and navigation.md "When codegraph is off" key on graph tools absent from the tool list). Plans therefore call find_cycles/get_callers/trace_path/entryPoint and may report "no cycles". Diagnostic variant B (scenario framed as tools-unregistered): 12/13 PASS; only 12 FAIL (entry-point fallback omits the explicit relevance + chunkSize heuristic, uses rerank onboarding).
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plugins (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1) via repo-root marketplace, real hooks (plan-only)
- Result: 12/13 PASS (92%) over graded cases (N/A: 0)
- Codex T14 rate: 100% (13/13)
- Claude T22 rate: 38% (5/13)
- FAIL list: 
  - `12` — subagent OFF entry-point used rerank=onboarding, not relevance+chunkSize (entry-point-pattern.md l.34) — new

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; graded strictly)
- Result: 13/13 PASS (100%) over scored cases (superseded: 0)
- Baseline (round 1): 5/13 (38%)
- Delta: +62pp
- FAIL list: none
- Notes: per the suite's honest-v2 harness (per-ENV tool list), each case now carries a scenario line stating whether graph tools are registered; round 1 subjects used their own session tool list instead. All OFF cases detect OFF before any graph call, never claim DAG/no-path, and fall back without get_callees.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 2 (Task 22)
- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.11 / dinopowers 0.24.4.
- Result: 13/13 PASS (100%) (N/A excluded: 0).
- Round-1 Codex: 12/13 (92.3%). Delta: +7.7 pp.
- FAIL list: none. Caveat: prompts sent to Codex used the old digest-signal wording, not the current tool-list wording in evals.json; graded on intent.
