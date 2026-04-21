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

| Skill                                     | Date       | Evals | With-skill | Baseline | Delta       |
| ----------------------------------------- | ---------- | ----- | ---------- | -------- | ----------- |
| search-cascade                            | 2026-03-29 | 20    | 100%       | 22%      | +78pp       |
| explore                                   | 2026-03-30 | 8+8   | 100%       | 12.5%    | +87.5pp     |
| research-merge                            | 2026-03-30 | 15    | 100%       | 70%      | +30pp       |
| risk-assessment                           | 2026-03-30 | 12    | 100%       | 10%      | +90pp       |
| coverage-expander                         | 2026-04-01 | 10    | 100%       | 100%     | 0pp\*       |
| install                                   | 2026-04-12 | 10    | 100%       | 100%     | 0pp\*\*     |
| dinopowers:writing-skills                 | 2026-04-20 | 12    | 100%       | 25%      | +75pp       |
| dinopowers:brainstorming                  | 2026-04-20 | 13    | 100%       | 23%      | +77pp       |
| dinopowers:writing-plans                  | 2026-04-20 | 14    | 100%       | 29%      | +71pp       |
| dinopowers:executing-plans                | 2026-04-20 | 15    | 100%       | 53%      | +47pp       |
| dinopowers:systematic-debugging           | 2026-04-20 | 15    | 100%       | 27%      | +73pp       |
| dinopowers:test-driven-development        | 2026-04-20 | 15    | 100%       | 20%      | +80pp       |
| dinopowers:verification-before-completion | 2026-04-20 | 15    | 100%       | 13%      | +87pp       |
| dinopowers:receiving-code-review          | 2026-04-20 | 12    | 100%       | 33%      | +67pp       |
| dinopowers:requesting-code-review         | 2026-04-20 | 12    | 100%       | 25%      | +75pp       |
| dinopowers:finishing-a-development-branch | 2026-04-20 | 13    | 100%       | 38%      | +62pp       |
| bug-hunt                                  | 2026-04-20 | 15    | 100%       | 53%      | +47pp       |
| data-driven-generation                    | 2026-04-21 | 15    | 100%       | 20%      | +80pp       |
| refactoring-scan                          | 2026-04-21 | 14    | 100%       | 36%      | +64pp       |
| pattern-search                            | 2026-04-21 | 14    | 100%       | 21%      | +79pp       |
| index                                     | 2026-04-21 | 10    | 100%       | 50%      | +50pp       |
| force-reindex                             | 2026-04-21 | 10    | 100%       | 80%      | +20pp\*\*\* |
| facade-discipline                         | 2026-04-21 | 12    | 100%       | 58%†     | +42pp†      |
| facade-discipline (iter-2)                | 2026-04-21 | +4    | 100%       | 75%†     | +25pp†      |
| facade-discipline (iter-3)                | 2026-04-21 | +3    | 100%       | 100%†    | +0pp†       |
| dinopowers-chaining-rule                  | 2026-04-21 | 8     | structural | n/a‡     | n/a‡        |

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
