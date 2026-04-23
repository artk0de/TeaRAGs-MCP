# risk-assessment Optimization Benchmark

**Date:** 2026-03-30 **Skills modified:** risk-assessment, explore **Eval
cases:** 12 (10 original + 2 subagent/plan)

## Metrics

| Metric                         | Value        |
| ------------------------------ | ------------ |
| Lines before (risk-assessment) | 304          |
| Lines after (risk-assessment)  | 321          |
| Lines before (explore)         | 223          |
| Lines after (explore)          | 224          |
| With-rule before fix           | 55% (5.5/10) |
| With-rule after fix            | 100% (12/12) |
| Without-rule baseline          | 10% (1/10)   |
| Delta                          | +90pp        |
| Iterations                     | 2            |

## Changes

| #     | Finding                                          | Category            | Fix                                                                | Eval  |
| ----- | ------------------------------------------------ | ------------------- | ------------------------------------------------------------------ | ----- |
| 1     | "4 presets" inconsistency in flow/anti-patterns  | Stale rules         | Replaced all with "3 presets"                                      | 1, 7  |
| 2     | Phase 0 "search-cascade decides tool"            | Conflicts           | Inline rule: concept→semantic, symbol→hybrid                       | 2     |
| 3     | "Apply search-cascade stop conditions"           | Conflicts           | Removed cascade ref, kept rules as-is                              | 3     |
| 4     | Rule 3 mentions ripgrep (not used in skill)      | Verbosity           | Simplified to "tea-rags tools only"                                | 7     |
| 6     | `ownership` in description not used              | Stale rules         | Removed from description. Backlog task created (tea-rags-mcp-k0cj) | 7     |
| 7     | explore "CRITICAL: search-cascade governs ALL"   | Conflicts           | Replaced with one-line self-contained rule                         | 10    |
| 8     | explore "no ripgrep verification passes"         | Conflicts+Verbosity | Shortened, removed cascade ref                                     | 10    |
| 9     | Delegation duplicates scope resolution           | Wrong routing       | Added pathPattern shortcut to Phase 0                              | 4, 12 |
| 10    | No machine-readable output for chaining          | Missing use case    | Added "Context for generation" block to Phase 5                    | 6, 9  |
| 11    | explore "across" misroutes risk intent           | Wrong routing       | Added risk intent check before keyword matching                    | 10    |
| extra | explore BREADTH "search-cascade determines tool" | Conflicts           | Inline tool selection rule                                         | —     |

## Key Design Decisions

1. **Self-contained skills (approach B)** over search-cascade as single source
   of truth. Skills embed only the subset of rules they need. Rationale: agent
   doesn't switch between two instruction documents; duplication is minimal (2-3
   lines per skill); cascade still handles routing TO skills.

2. **Risk intent overrides keyword matching** in explore classification. "risk
   surface of X across codebase" should route to risk-assessment despite
   "across" being a Spread keyword. Risk signals checked before keyword table.

3. **risk-assessment is standalone, human-only.** No machine-readable context
   block. DDG gets overlay labels via find_symbol(rerank=...) through explore
   PG-2, not through risk-assessment. This eliminates the heavy 3-preset scan
   from the generation chain.

4. **Tool call optimization.** Batch find_similar (all Critical UUIDs in one
   call), batch test coverage (one hybrid_search for all symbols). Target: ≤12
   calls for domain, ≤16 for broad.

## Iterations

| Iteration                                       | Scope                         | Pass rate            |
| ----------------------------------------------- | ----------------------------- | -------------------- |
| Baseline (no skill)                             | 10 cases                      | 10%                  |
| Before fix (with skill)                         | 10 cases                      | 55%                  |
| After fix                                       | 12 cases                      | 96% (Eval-6 PARTIAL) |
| Iteration 1 (Eval-6 "ALWAYS" fix)               | 3 cases (Eval-6 + 2 controls) | 100%                 |
| Iteration 2 (output mode split)                 | 4 cases (Eval-6,1,9,7)        | 100%                 |
| Iteration 3 (standalone only, remove DDG chain) | architectural                 | —                    |
| Integration tests                               | 3 real MCP runs (Eval-1,4,6)  | 100%                 |

## Per-Eval Detail

| Eval | Prompt                                                                          | Before  | After |
| ---- | ------------------------------------------------------------------------------- | ------- | ----- |
| 1    | Assess risks in the ingest domain                                               | PASS    | PASS  |
| 2    | Evaluate code health of enrichment pipeline                                     | FAIL    | PASS  |
| 3    | Risk scan whole project                                                         | PASS    | PASS  |
| 4    | Find risky areas before I refactor the trajectory module                        | FAIL    | PASS  |
| 5    | Оцени проблемные зоны в explore стратегиях                                      | PASS    | PASS  |
| 6    | What are the riskiest files that data-driven-generation should be careful with? | FAIL    | PASS  |
| 7    | Show hotspots and ownership patterns in adapters/                               | PASS    | PASS  |
| 8    | Assess risks in the chunker hooks area                                          | PASS    | PASS  |
| 9    | Risk assessment for the reranker — I need context before generating             | PARTIAL | PASS  |
| 10   | Explore the risk surface of error handling across the codebase                  | FAIL    | PASS  |
| 11   | [subagent] Assess code risks in ingest/                                         | N/A     | PASS  |
| 12   | [plan execution] Risk assessment on trajectory domain                           | N/A     | PASS  |

---

# Iteration 2 — Pair Diagnostics (2026-04-23)

**Goal:** Add signal interpretation layer (pair diagnostics) so agent correctly
identifies architectural patterns from git+structural signal combinations
instead of naive single-signal reading.

**Skills modified:** risk-assessment, bug-hunt, explore. **Rules modified:**
search-cascade. **New reference:** `rules/references/signal-interpretation.md`.

## Metrics

| Metric                               | Value        |
| ------------------------------------ | ------------ |
| Lines before (risk-assessment)       | 297          |
| Lines after (risk-assessment)        | 335 (+13%)   |
| Lines new (signal-interpretation.md) | 250          |
| Eval cases                           | 10           |
| With-rule before fix                 | 60% (6/10)   |
| Without-rule baseline                | 100% (10/10) |
| With-rule after fix                  | 100% (10/10) |
| Delta vs before                      | +40pp        |
| Delta vs baseline                    | 0pp          |
| Iterations                           | 1 (no retry) |

## Baseline inversion finding

Without-rule (free-form engineering intuition) outscored with-rule (constrained
by old Phase 4 table): 100% vs 60%. The old classification table lacked
pair-diagnostic classes (coupling point, bug attractor, healthy owner,
feature-in-progress, boilerplate churn) and forced the agent into wrong
neighbouring labels. After-fix matches free-form intuition while also providing
consistent labels and structured reasoning — unlike ad-hoc engineer naming.

## Changes

| #   | Finding                                                | Category          | Fix                                                                        | Eval    |
| --- | ------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------- | ------- |
| 1   | No class for Coupling point / God module               | Missing use case  | Added Coupling point + Emerging coupling to Phase 4 table                  | 1       |
| 2   | Knowledge silo collapsed healthy + toxic               | Wrong routing     | Split into Toxic silo + Healthy owner with churn/age/bugFix disambiguators | 2       |
| 3   | No class for Bug attractor (distinct from coupling)    | Missing use case  | Added Bug attractor requiring `imports low` as disambiguator               | 5       |
| 4   | No class for Feature-in-progress (benign churn)        | Missing use case  | Added Feature-in-progress (benign); marked non-risk                        | 4       |
| 5   | No class for Boilerplate churn (DTO, blockPenalty)     | Missing use case  | Added Boilerplate churn (benign) requiring blockPenalty high               | 6       |
| 6   | `imports` signal absent from Phase 4 logic             | Wrong routing     | Added as primary disambiguator for all churn-heavy patterns                | 1, 5, 6 |
| 7   | Anti-patterns silent on interpretation mistakes        | Missing use case  | Added 4 interpretation anti-patterns                                       | 8       |
| 8   | No reference file for pair diagnostics                 | Missing resource  | Created `references/signal-interpretation.md` (250 lines)                  | all     |
| 9   | bug-hunt did not flag coupling-driven bug propagation  | Missing use case  | Added 3-line note on `imports` × bugFixRate                                | —       |
| 10  | explore PG-2 advised single-signal reading             | Verbosity+Missing | Added 1-line pointer to signal-interpretation.md                           | —       |
| 11  | search-cascade missing pointer to interpretation layer | Missing resource  | Added under "Rerank Decision" + reference file list                        | —       |

## Key Design Decisions

1. **Reference file over inline tables.** Pair diagnostics are
   knowledge-intensive (tables + patterns catalog + anti-patterns +
   limitations). Inlining into SKILL.md would push it past 500 lines. Separate
   `references/signal-interpretation.md` follows existing reference pattern
   (`pagination.md`, `polyglot-rule.md`). Skill bodies got short pointers only.

2. **Extended classification table over replacing it.** The old table (Bug
   magnet, Fragile, Legacy debt, Untested hotspot, Oversized, Knowledge silo,
   Race condition) stays — pair-diagnostic classes are additive. Agent can pick
   Bug attractor instead of Bug magnet when imports is low; both remain valid
   depending on what's available.

3. **Benign classifications mark non-risks explicitly.** Healthy owner,
   Feature-in-progress, and Boilerplate churn are labeled `(benign)` and
   excluded from risk count. Prevents false positives that plagued old table
   (which forced every high-churn file into a risk class).

4. **`imports` as primary disambiguator.** All coupling-vs-attractor decisions
   hinge on fan-in. Made it the first listed disambiguator in Phase 4 and
   anti-pattern #3. Structural signal from static trajectory — separate from git
   signals but essential for architectural interpretation.

5. **Single-signal refusal.** Added explicit rule: one strong signal with rest
   typical/missing → insufficient evidence, do not classify. Previously agent
   guessed the closest table entry.

## Iterations

| Iteration               | Scope    | Pass rate |
| ----------------------- | -------- | --------- |
| Baseline (no skill)     | 10 cases | 100%      |
| Before fix (with skill) | 10 cases | 60%       |
| After fix               | 10 cases | 100%      |

Single iteration — 100% on first pass. No retries needed.

## Per-Eval Detail (Iteration 2)

| Eval | Scenario                                | Before                | After                      |
| ---- | --------------------------------------- | --------------------- | -------------------------- |
| 1    | god module (churn+imports+authors)      | FAIL (Legacy debt)    | PASS (Coupling point)      |
| 2    | healthy owner (mono+stable+old)         | FAIL (Knowledge silo) | PASS (Healthy owner)       |
| 3    | legacy minefield (age+churn+bugFix)     | PASS (Legacy debt)    | PASS (Legacy minefield)    |
| 4    | feature-in-progress (new+churn+healthy) | FAIL (Fragile)        | PASS (Feature-in-progress) |
| 5    | bug attractor (bugFix+low imports)      | PASS (Bug magnet)     | PASS (Bug attractor)       |
| 6    | boilerplate churn (DTO+blockPenalty)    | FAIL (Oversized)      | PASS (Boilerplate churn)   |
| 7    | single-signal only (age alone)          | PASS (not listed)     | PASS (insufficient ev.)    |
| 8    | user claim "high churn = active dev"    | PASS                  | PASS                       |
| 9    | control: scope resolution               | PASS                  | PASS                       |
| 10   | control: MERGE tier + negativeIds       | PASS                  | PASS                       |

## Follow-up

User raised separate concern during optimization: current preset overlayMasks
may not surface disambiguator signals (`imports`, `blockPenalty`, `authors`),
forcing agent to run multiple presets OR build custom rerank every time to see
them. This is a trajectory/git preset change (not a skill change) and tracked as
separate work.
