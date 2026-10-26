# tea-rags:pattern-search Optimization Benchmark

**Date:** 2026-04-21 **Eval cases:** 14

| Metric    | Value        |
| --------- | ------------ |
| With-rule | 100% (14/14) |
| Baseline  | 21% (3/14)   |
| Delta     | +79pp        |

## Core Value

4-phase SEED → EXPAND → DEDUPLICATE → GROUP flow with strategy-driven rerank
selection (collect/spread/antipattern/reference → different presets or custom
weights), mandatory find_similar expansion, content-overlap dedup (>80% same-dir
only), module-grouped output with overlay labels, and strategy-specific output
markers (⚠️ for antipattern, ✓ for reference).

## Failure Analysis (baseline 11/14 FAIL)

1. **EXPAND step always skipped** (evals 1, 2, 4, 5) — baseline runs ONE search,
   reads results, doesn't systematically `find_similar` from each seed
2. **Reference-strategy custom weights** (eval-3) — baseline picks named
   `proven`/`stable` preset instead of constructing
   `{similarity:0.2, stability:0.3, age:0.3, bugFix:-0.15, ownership:-0.05}`
3. **Cross-domain diversification** (eval-4) — baseline doesn't run additional
   semantic_search with pathPattern excluding found modules
4. **Content-overlap dedup** (eval-6) — baseline has no formal >80%-same-dir
   rule
5. **Group-by-module output** (eval-7) — baseline lists results flat, omits
   overlay labels
6. **Rule 2 CRITICAL — no built-in grep/ripgrep-only-as-fallback** (eval-9) —
   baseline treats ripgrep as first choice for regex, violates cascade
   discipline
7. **Rule 1 Execute-YOURSELF** (eval-10) — baseline delegates broad-scope to
   subagent
8. **Output markers** (evals 11, 12) — baseline uses plain text labels, no ⚠️/✓
   convention
9. **Post-search-validation** (eval-14) — baseline jumps SEED→EXPAND without
   validation gate

## Delta Interpretation

+79pp. Baseline gets 3 correct cases:

- eval-5 (always-EXPAND reasoning under "skip, enough results" pressure —
  natural to continue)
- eval-8 (metaOnly=false — natural to want content for matching)
- eval-13 (single-entity routing to find_symbol — obvious)

Everything else requires the skill's formal 4-phase protocol + strategy table +
output conventions.

## Iteration Log

**Iteration 0:** 14/14 with-rule, 3/14 baseline (21%), delta +79pp. No fix
needed.

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet
- Result: 13/14 PASS (93%)
- Last recorded rate: 100% (14/14 with-rule, iteration 0)
- FAIL list: eval-14 (after SEED, before EXPAND: subject noted chunk ids/seen
  paths but omitted the post-search validation step - no-match detection +
  disambiguation). Cause: pattern-search SKILL.md has no validation step; that
  content now lives in rules/guides/navigation.md and the subject did not read
  it for this case.
- Notes: Delta -7pp. Subject read tea-rags://guide/decision-tree.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default model, plan-only, plugins via repo-root
  marketplace, real hooks (SessionStart digest + dinopowers routing,
  SubagentStart block), AGENTS.md = core
- Result: 4/14 PASS (29%) over 14 graded cases (N/A: 0)
- Claude T12 for comparison: 13/14 (93%)
- Both-fail: 0
- CODEX-ONLY (10):
  - `eval-1` — no rerank=relevance/metaOnly=false, EXPAND only "if gaps" not
    from each seed; pattern-search SKILL.md deferred, not read
  - `eval-2` — no techDebt/refactoring rerank, EXPAND optional
  - `eval-3` — no custom proven weights, EXPAND "only if needed" not from single
    best seed
  - `eval-4` — no relevance rerank, no cross-domain pathPattern-exclusion
    semantic_search
  - `eval-5` — skips EXPAND (violates Rule 4 always-expand)
  - `eval-6` — drops chunk without richer-signals comparison and omits the
    different-dir keep-both rule
  - `eval-7` — no group-by-module, no overlay labels in output
  - `eval-10` — would delegate to a subagent; expected refusal (Rule 1 execute
    yourself)
  - `eval-11` — no warning-sign marker prefix named
  - `eval-12` — no check-mark marker named for best example

## 2026-10-23 — Cursor run (Task 15)

- Subject: Cursor CLI (`agent` 2026.10.22-27dcf5f), model `auto`, plugins from
  harness/cursor (tea-rags + dinopowers), sessionStart hook digest, plan-only.
- Partial run — Cursor free-plan usage limit stopped the eval after 7 of 45
  parts.
- Result: 13/14 PASS (93%) over 14 graded cases (N/A excluded: 0)
- Claude T12 for comparison: 13/14 (93%); Codex T14: 4/14 (29%)
- CURSOR-ONLY: none
- Both-fail (all) count: 0
- FAIL list: eval-14 (vs-codex) - Notes chunk IDs and asks on 2+ unrelated
  clusters (disambiguation) but no no-match detection step; Claude also FAIL,
  Codex PASS.

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet (plan-only simulation, blind)
- Result: 14/14 PASS (100%) over 14 scored cases (0 superseded)
- Task 12 rate: 13/14 (93%)
- Delta: +7pp
- FAIL list: none - notes: (eval-14 now reads pagination guide and names
  disambiguation + no-match detection; thresholds not quoted - weak pass)
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace
  (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1), real hooks
  (plan-only)
- Result: 13/14 PASS (93%) over 14 graded cases (N/A 0)
- Codex T14 for comparison: 4/14 (29%)
- Claude T22 for comparison: 14/14 (100%)
- FAIL list:
  - `eval-6` — FAIL ( still; Claude T22 PASS ) states same-dir >80% keep-richer
    but omits the different-dirs ALWAYS-keep-both rule

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; strict literal grading)
- Result: 13/14 PASS (93%) over 14 scored cases (superseded: 0)
- Baseline (round 1): 14/14 (100%)
- Delta: -7pp
- FAIL list:
  - eval-14 — names "check SEED against the pagination guide (disambiguation +
    no-match detection)" but states none of the actions: no >70%-directory test
    → ask which area → re-SEED with pathPattern, no 2-of-3 warn / 3-of-3
    report-no-match. Round 1 passed it as "weak pass"; strict literal grading
    fails it. pattern-search SKILL.md l.91 only names the guide and the two
    checks; the actions live in guides/pagination.md, which the subject cited
    without opening.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 2 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.11
  / dinopowers 0.24.4.
- Result: 12/14 PASS (86%) (N/A excluded: 0).
- Round-1 Codex: 13/14 (93%). Delta: -7 pp.
- FAIL list:
  - `eval-2` — routed to refactoring-scan (3 rank presets); no EXPAND from
    problematic seeds (mustNotDo: skip EXPAND).
  - `eval-14` — names pagination disambiguation/no-match check only; no
    thresholds or ask/re-SEED / warn / report-no-match actions.

## 2026-10-23 — evals-to-100 re-run round 3 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; strict literal grading; no
  per-case length cap)
- Result: 14/14 PASS (100%) over scored cases (superseded: 0)
- Baseline (round 2): 13/14 (93%)
- Delta: +7pp (eval-14 fixed: SEED validation now spells both checks —
  disambiguation >70% → ask + re-SEED with pathPattern, never EXPAND both;
  no-match spread/overlap/clustering, 2 of 3 warn, 3 of 3 report no match
  without EXPAND)
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block (tea-rags 0.46.12
  / dinopowers 0.24.5, rebuilt from live hook output); old plugin hook text
  present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 3 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.12
  / dinopowers 0.24.5.
- Result: 11/14 PASS (78.6%) (N/A excluded: 0).
- Round-2 Codex: 12/14 (85.7%). Delta: -7.1 pp.
- FAIL list:
  - `eval-6` — same dir >80% → keep richer-signals one, but never states the
    different-directories → always keep both rule
  - `eval-7` — groups "by module/directory" with file:line + description +
    overlay labels, but not by top-level module = first 2 segments after src/
  - `eval-14` — only "check for disambiguation and no-match conditions" via
    pagination; no thresholds (2+ dir groups / none >70% → ask + re-SEED
    pathPattern; 2-of-3 warn / 3-of-3 report no match)

## 2026-10-23 — Codex re-run round 4 (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.13
  / dinopowers 0.24.6; Codex core adds "read ONE file per command; output past
  ~10k tokens loses its middle".
- Result: 11/14 PASS (78.6%) (N/A excluded: 0).
- Round-3 Codex: 11/14 (78.6%). Delta: ±0.0 pp.
- FAIL list:
  - `eval-6` — same-dir >80% -> keep richer applied, but "different directories
    -> always keep both" never stated
  - `eval-7` — groups "by module/directory" without the top-level-module rule
    (first 2 segments after src/)
  - `eval-14` — disambiguation (>70% split -> ask) stated, but No-Match
    Detection (2 of 3 warn / 3 of 3 report no match) missing
