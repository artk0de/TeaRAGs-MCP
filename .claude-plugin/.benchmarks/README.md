# Skill Benchmarks

Eval-driven optimization results for tea-rags plugin skills and rules.

## Structure

```
benchmarks/
├── <skill-name>/
│   ├── benchmark.md    — results, iterations, delta, changes (committed)
│   └── workspace/      — evals, snapshots, iteration dirs (gitignored)
│       ├── evals.json
│       ├── skill-snapshot/
│       └── iteration-N/
```

- **benchmark.md** — committed. Permanent record of optimization results.
- **workspace/** — gitignored. Created by `/optimize-skill` on demand. Contains
  eval cases, skill snapshots, iteration outputs. Recreatable.

## Usage

- **Optimize a skill:** `/optimize-skill <skill-name>` — runs eval-driven
  methodology, persists benchmark.md
- **Re-verify:** read `workspace/evals.json` (or regenerate), run with-skill
  eval, compare against benchmark.md

## Current benchmarks

| Skill                                       | Date       | Evals | With-skill | Baseline  | Delta                                                                    |
| ------------------------------------------- | ---------- | ----- | ---------- | --------- | ------------------------------------------------------------------------ |
| search-cascade                              | 2026-03-29 | 20    | 100%       | 22%       | +78pp                                                                    |
| search-cascade (ripgrep overreach)          | 2026-05-07 | 9     | 100%‡‡     | 44%       | +56pp‡‡                                                                  |
| explore                                     | 2026-03-30 | 8+8   | 100%       | 12.5%     | +87.5pp                                                                  |
| research-merge                              | 2026-03-30 | 15    | 100%       | 70%       | +30pp                                                                    |
| risk-assessment                             | 2026-03-30 | 12    | 100%       | 10%       | +90pp                                                                    |
| risk-assessment (pair diagnostics)          | 2026-04-23 | 10    | 100%       | 60%§      | +40pp                                                                    |
| coverage-expander                           | 2026-04-01 | 10    | 100%       | 100%      | 0pp\*                                                                    |
| install                                     | 2026-04-12 | 10    | 100%       | 100%      | 0pp\*\*                                                                  |
| dinopowers:writing-skills                   | 2026-04-20 | 12    | 100%       | 25%       | +75pp                                                                    |
| dinopowers:brainstorming                    | 2026-04-20 | 13    | 100%       | 23%       | +77pp                                                                    |
| dinopowers:writing-plans                    | 2026-04-20 | 14    | 100%       | 29%       | +71pp                                                                    |
| dinopowers:executing-plans                  | 2026-04-20 | 15    | 100%       | 53%       | +47pp                                                                    |
| dinopowers:systematic-debugging             | 2026-04-20 | 15    | 100%       | 27%       | +73pp                                                                    |
| dinopowers:test-driven-development          | 2026-04-20 | 15    | 100%       | 20%       | +80pp                                                                    |
| dinopowers:verification-before-completion   | 2026-04-20 | 15    | 100%       | 13%       | +87pp                                                                    |
| dinopowers:receiving-code-review            | 2026-04-20 | 12    | 100%       | 33%       | +67pp                                                                    |
| dinopowers:requesting-code-review           | 2026-04-20 | 12    | 100%       | 25%       | +75pp                                                                    |
| dinopowers:finishing-a-development-branch   | 2026-04-20 | 13    | 100%       | 38%       | +62pp                                                                    |
| bug-hunt                                    | 2026-04-20 | 15    | 100%       | 53%       | +47pp                                                                    |
| data-driven-generation                      | 2026-04-21 | 15    | 100%       | 20%       | +80pp                                                                    |
| refactoring-scan                            | 2026-04-21 | 14    | 100%       | 36%       | +64pp                                                                    |
| pattern-search                              | 2026-04-21 | 14    | 100%       | 21%       | +79pp                                                                    |
| index                                       | 2026-04-21 | 10    | 100%       | 50%       | +50pp                                                                    |
| force-reindex                               | 2026-04-21 | 10    | 100%       | 80%       | +20pp\*\*\*                                                              |
| facade-discipline                           | 2026-04-21 | 12    | 100%       | 58%†      | +42pp†                                                                   |
| facade-discipline (iter-2)                  | 2026-04-21 | +4    | 100%       | 75%†      | +25pp†                                                                   |
| facade-discipline (iter-3)                  | 2026-04-21 | +3    | 100%       | 100%†     | +0pp†                                                                    |
| dinopowers-chaining-rule                    | 2026-04-21 | 8     | structural | n/a‡      | n/a‡                                                                     |
| dinopowers-wrappers (description+hook)      | 2026-04-30 | 15    | 100%       | 40%¶      | +60pp                                                                    |
| dinopowers:executing-plans (v2 data-driven) | 2026-05-06 | 10    | 100%       | 20%       | +80pp                                                                    |
| wave1-triggering (4.7 migration, 26 skills) | 2026-05-08 | 30    | 30/30 HIGH | 16 HIGH   | +14 HIGH·                                                                |
| wave2-restructure (8 long skills, 4.7)      | 2026-05-08 | n/a·· | structural | n/a       | -247 dino lines + 6 ref files                                            |
| tests-as-context (feature-creation)         | 2026-05-17 | 12    | deferred△  | deferred△ | Phase 2 baseline ready in `evals.json`, runs scheduled next eval session |

\* Baseline was 100% because the skill was **hurting** behavior (10% with-rule).
After fix, skill no longer degrades natural tool selection.

\*\* Same pattern: skill had stale "22+" text (script requires 24+) and `npx`
instead of global binary. 0% with-rule before fix. Fixed version matches
baseline.

\*\*\* Low delta is honest: baseline already handles destructive-op safety well
(8/10) via general caution culture. Skill's unique value is 2 technical protocol
details (background subagent dispatch with `run_in_background=true`, foreground
refusal for zero-downtime alias-switching). Not a weakness — reflects narrow
marginal value.

† facade-discipline has two grading axes. Primary drift prevention (keeping
logic out of facade body) is 100% / 100% — baseline SE intuition already blocks
obvious drift on telegraphed prompts. Strict category precision (`queries/` vs
`strategies/` vs `ops/` vs validator) is 100% / 58% — rule's unique value.
Baseline defaults to calling every extraction "a strategy" because that's the
only pattern visible in the codebase; rule teaches the three-way split and the
`registry.buildMergedFilter` / `api/errors.ts` conventions. The 58% is the
strict number shown.

iter-3 delta is +0pp honestly: the cosmetic-thinning anti-pattern is telegraphed
clearly enough in prompts that baseline catches it. iter-3 exists as documentary
/ counter-example value — a concrete clause to cite in PR review, and a
precedent that prevents over-literal reading of the iter-2 "≤20 lines per
method" clause. The loophole DID trip the agent in a live refactor; iter-3 makes
that failure explicit across sessions.

‡ dinopowers-chaining-rule is a cross-cutting text fix applied to all 10 wrapper
SKILL.md files. Phase 2 baseline subagent eval was skipped — the problem was
pre-confirmed by the existing `inject-wrapper-routing.sh` hook (same bypass
pattern, different tool surface) and a direct user report. Eval cases documented
in `evals.json` as reusable regression tests; verification was structural
(grep + markdownlint delta), not subagent-based.

‡‡ search-cascade (ripgrep overreach) used three-way eval: baseline (no rules,
44%), full-cascade-injected (9/9 misleading 100% — main agent's view, not what
subagents see), SUFFIX-only production-realistic (8/9 = 89% before fix). After
fix, SUFFIX-only reaches 9/9 (100%). The 100%‡‡ is the production-realistic
score against the actual hook-injected SUFFIX, not the misleading full-cascade
score. Methodology change: previous iterations measured rule wording quality;
this iteration adds the production injection path as a separate config to expose
gaps between documented rule and actually-injected subagent context.

· wave1-triggering: 30 eval cases × 3 simulated runs (baseline names-only,
with-rule OLD descriptions, with-rule NEW descriptions). Pre-fix had 16 HIGH

- 13 MED + 1 LOW; post-fix all 30 HIGH, 0 regressions. Δ = +14 confidence-class
  upgrades on dinopowers wrappers (removing "USE INSTEAD OF" meta-prefix), +1
  LOW→HIGH on data-driven-generation (concrete code-writing triggers added).
  Methodology limitation: simulator is Opus 4.7 itself (not the real Anthropic
  classifier) — confidence movement is the load-bearing signal, raw 100% is a
  methodology artifact.

·· wave2-restructure: no formal eval (would need 8+ subagent runs for per-skill
following eval). Hypothesis-driven mechanical restructuring: hoist critical
content above line ~50, extract long classification/anti-pattern blocks into
`references/`, replace soft "should" with MUST/STOP markers. Per-skill
following-eval scheduled as Phase 8 future work for the 3 most-used skills
(risk-assessment, executing-plans, optimize-skill).

¶ dinopowers-wrappers (description+hook): cross-cutting fix triggered by user
report "агент все еще предпочитает superpowers". First baseline (curated
18-skill list, no CLAUDE.md weighting) gave a misleading 100% — looked like no
fix needed. Re-ran with realistic context (full skill list + global CLAUDE.md
naming `superpowers:brainstorming`/`superpowers:test-driven-development` as
MANDATORY) and got the honest 40% baseline. Fix bundle: rewrote all 10
descriptions with "USE INSTEAD OF superpowers:X" lead, added Russian triggers to
all 9 (was: only `brainstorming`), removed self-defeating "Triggers when
superpowers:X would fire AND..." anti-marketing, removed "NOT for X — use
superpowers:Y directly" router exits. Added `UserPromptSubmit` hook
(`scripts/inject-main-session-routing.sh`) — the existing `PreToolUse(Agent)`
hook only saw subagent prompts, leaving main session unrouted. Added
`rules/wrapper-priority.md` to override global CLAUDE.md naming. Plugin 0.13.1 →
0.14.0.

△ tests-as-context (feature-creation): new agentic-only skill authored as part
of a feature implementation (DSL test chunks as enrichment for review / verify /
refactor / TDD). Per Phase 6 mandate ("Applies to feature-driven updates too —
eval cases and results MUST still be persisted"), 12 eval cases are persisted in
`evals.json` as ready-to-run regression artifacts; Phase 2 parallel
with-rule/without-rule subagent runs deferred to a follow-up eval session. Phase
1 AUDIT applied 4 inline fixes (F1 brace-expansion exclusion → must_not filter;
F2 cold-subagent preflight fallback probe; F3 dropped near-zero imports weight;
F4 single-element affectedFiles clarification). 5 recipes: tests-at-risk,
fixture-lookup, regression-archaeology, test-flakiness, spec-extraction.
Cross-language safety contract enforced. Consumer wrappers updated: dinopowers
test-driven-development (Step 2 split + fallback), requesting-code-review (Step
3a), verification-before-completion (Step 3a), receiving-code-review (Step 3a).
See `tests-as-context/benchmark.md` for the full eval design and next-session
run plan.

§ risk-assessment pair diagnostics: rare baseline-higher-than-with-rule
inversion. Old Phase 4 classification table lacked coupling/bug-attractor/
healthy-owner/feature-in-progress/boilerplate classes, so the skill _forced_
agents into neighbouring wrong labels (god module → Legacy debt, healthy owner →
Knowledge silo, feature-in-progress → Fragile, boilerplate → Oversized).
Unconstrained engineer intuition (baseline 100%) hit the right architectural
patterns naturally. After-fix skill matches baseline accuracy (100%) AND
provides consistent named classes with explicit disambiguators (`imports`,
`bugFixRate`, `ageDays`, `blockPenalty`) and a
`references/signal-interpretation.md` reference for pair diagnostics.
