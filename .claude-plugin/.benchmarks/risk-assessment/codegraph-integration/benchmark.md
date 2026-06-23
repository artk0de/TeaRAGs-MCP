# Benchmark — risk-assessment codegraph integration (b65a TR3)

Add a **structural risk axis** to `risk-assessment`, prescribed (not improvised):
`architecturalHub` as a Phase-4 blast-radius amplifier + `find_cycles` as a
structural-risk section, codegraph-gated; and expand
`rules/references/signal-interpretation.md` with codegraph signals + two new
architectural patterns (blast-radius hub, cyclic coupling).

## Summary

| Metric | Value |
| --- | --- |
| Eval cases | 8 (3 integration, 1 classification, 2 codegraph-OFF guard, 1 no-regression control, 1 edge, 1 subagent) |
| with-rule current | ~7.5/8 (structural axis only by improvisation; skill prescribes churn-only) |
| without-rule baseline | ~5/8 (improvises codegraph partially, LOSES risk-assessment discipline: stratified scan, negativeIds) |
| with-rule FIXED | 8/8 — structural axis prescribed; OFF-guard honest; no churn-flow regression |

## Key finding (consistent with codegraph-presence-fallback run)

An Opus-class agent **improvises** codegraph structural analysis when the tools
are present (ENV-B), so the raw behavioral delta is modest. The real value of
the integration:

1. **Prescription over improvisation.** The unedited skill mandates a churn-only
   flow (4 git presets + decomposition). The with-rule agent's own meta-note: a
   disciplined agent following the skill literally would surface NO hubs/cycles.
   The fix makes the structural axis a prescribed Phase-4 step with a defined
   shape (amplifier, not a 5th MERGE preset) — consistent, not ad-hoc.
2. **Grounded classification.** signal-interpretation now documents real
   `fanIn`/`isHub`/`instability`/`transitiveImpact`/cycle-membership and says
   they supersede the `imports` proxy — so god-module-vs-bug-attractor is decided
   on edge truth, not improvised.
3. **Honest OFF-guard** (inherits the codegraph-presence-fallback canon):
   E4/E5 — skip step 3b, never claim "no cycles / no hubs" when codegraph is off.
4. **Weaker-model robustness** — the prescribed steps help models that won't
   improvise the axis. (Not measurable with this Opus-only eval.)

## Changes

| File | Change |
| --- | --- |
| `risk-assessment/SKILL.md` | Phase-1 codegraph-transparency note (techDebt/dangerous absorb structural signals); Phase-4 step **3b** (architecturalHub blast-radius amplifier + find_cycles), codegraph-gated with OFF skip; disambiguator note (prefer fanIn/isHub over imports proxy); Flow + OUTPUT "Structural risks" section. |
| `rules/references/signal-interpretation.md` | New "Codegraph signals" table (fanIn/fanOut/isHub/instability/connectionCount/transitiveImpact/pageRank/cycle-membership, gated, supersede imports proxy); god-module + bug-attractor enriched with codegraph; two new patterns: **Blast-radius hub**, **Cyclic coupling**. |

Plugin bump: tea-rags 0.26.1 → **0.27.0** (feat — new structural-risk capability; also covers the bundled codegraph-presence-fallback patch in this worktree).

## Per-case verdicts

| Case | ENV | without-rule | with-rule current | with-rule FIXED |
| --- | --- | --- | --- | --- |
| 1 hub-amplifier-and-cycles | B | partial (not 4 presets) | improvised | PASS |
| 2 explicit-cycles | B | partial (no stratified) | improvised | PASS |
| 3 classification-pair-diag | B | partial (imports proxy) | improvised | PASS |
| 4 off-guard-hub-amplifier | A | PASS | PASS | PASS |
| 5 off-guard-cycles | A | PASS | PASS | PASS |
| 6 control-no-regression | B | FAIL (no stratified scan) | PASS | PASS |
| 7 edge-no-hubs-no-cycles | B | PASS | PASS | PASS |
| 8 subagent-delegated | B | PASS | improvised | PASS |

## Limitations

- Modest behavioral delta on Opus (tool presence ⇒ improvised use); value is
  prescription/consistency/grounding/robustness.
- Eval tests instruction clarity (plan), not live tool execution.
- couplingComplexity (gated on C-AST `tea-rags-mcp-wtkz`, OPEN) deliberately
  excluded.
