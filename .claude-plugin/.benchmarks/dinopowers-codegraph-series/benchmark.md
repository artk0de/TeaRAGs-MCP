# Benchmark — dinopowers codegraph series (b65a DP1/DP2/DP3/DP5/DP6/DP8)

Integrate READY codegraph surfaces into six dinopowers wrapper skills, each
prescribed with a codegraph-presence gate and a codegraph-OFF fallback.

## Summary

| Metric | Value |
| --- | --- |
| Skills | 6 (writing-plans, executing-plans, verification-before-completion, brainstorming, requesting-code-review, finishing-a-development-branch) |
| Eval cases | 10 (ON prescription + OFF fallback per skill) |
| with-rule FIXED | 10/10 |
| Baseline | not re-measured per-skill — see note |

**Baseline note.** Same localized-change rationale as TR4: the codegraph-presence
agent-behavior baseline was already measured 3× this session (fallback 12/13 vs
13/13; risk-assessment ~5/8 vs ~7.5/8 vs 8/8). Finding holds — Opus improvises
codegraph use when tools are present; value = PRESCRIPTION (consistent preset
over ad-hoc), grounding, and the OFF fallback guard. Full two-arm baselines were
disproportionate for these one-spot wrapper edits; fixed-skill verify confirms
correct prescription + fallback.

## Per-skill change (epic mapping)

| Skill | Epic | Change |
| --- | --- | --- |
| writing-plans | DP1 | Step 2 impact rerank: `"blastRadius"` (codegraph on) / `{imports,churn,ownership}` fallback (off); header + 2 anti-patterns reframed |
| executing-plans | DP2 | Pre-touch guard rerank: same blastRadius-on / weights-off swap; header + 2 anti-patterns |
| verification-before-completion | DP5 | Collateral scan rerank: blastRadius-on / weights-off; blast-tier ladder reads `fanIn` (on) or `imports` (off); header + anti-pattern |
| brainstorming | DP3 | Added Call D `architecturalHub` (structural backbone), codegraph-gated; omitted when off |
| requesting-code-review | DP6 | Added Step 2.5 `get_callers` reviewer-hub awareness, codegraph-gated; ownership bundle weights unchanged (its purpose ≠ blast verdict) |
| finishing-a-development-branch | DP8 | Note: risk-assessment's structural axis (architecturalHub + find_cycles) auto-runs over the branch diff; a branch-introduced cycle = merge-blocker; absent (not "no cycles") when off |

Plugin bump: dinopowers 0.17.6 → **0.18.0** (feat). (tea-rags side carried by
0.27.0 from TR3/TR4 in the same worktree.)

## Per-case verdicts (fixed)

| Case | Skill | ENV | verdict |
| --- | --- | --- | --- |
| 1/2 | writing-plans | B/A | PASS — blastRadius / weights-fallback flagged approximate |
| 3/4 | executing-plans | B/A | PASS — blastRadius guard / weights fallback |
| 5/6 | verification | B/A | PASS — fanIn blast tiers / imports proxy |
| 7/8 | brainstorming | B/A | PASS — Call D runs / Call D omitted + "backbone not assessed" |
| 9 | requesting-code-review | B | PASS — get_callers reviewer-hub line added |
| 10 | finishing-a-branch | B | PASS — find_cycles via risk-assessment, cycle=merge-blocker |

## Limitations

- Modest behavioral delta on Opus; value is prescription/consistency/grounding +
  weaker-model robustness.
- Gated D5 presets (changeRisk for DP2/DP5, couplingComplexity for DP1) excluded
  — blocked on C-AST `tea-rags-mcp-wtkz` (OPEN).
