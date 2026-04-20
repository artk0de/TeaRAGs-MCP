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

| Skill                                     | Date       | Evals | With-skill | Baseline | Delta   |
| ----------------------------------------- | ---------- | ----- | ---------- | -------- | ------- |
| search-cascade                            | 2026-03-29 | 20    | 100%       | 22%      | +78pp   |
| explore                                   | 2026-03-30 | 8+8   | 100%       | 12.5%    | +87.5pp |
| research-merge                            | 2026-03-30 | 15    | 100%       | 70%      | +30pp   |
| risk-assessment                           | 2026-03-30 | 12    | 100%       | 10%      | +90pp   |
| coverage-expander                         | 2026-04-01 | 10    | 100%       | 100%     | 0pp\*   |
| install                                   | 2026-04-12 | 10    | 100%       | 100%     | 0pp\*\* |
| dinopowers:writing-skills                 | 2026-04-20 | 12    | 100%       | 25%      | +75pp   |
| dinopowers:brainstorming                  | 2026-04-20 | 13    | 100%       | 23%      | +77pp   |
| dinopowers:writing-plans                  | 2026-04-20 | 14    | 100%       | 29%      | +71pp   |
| dinopowers:executing-plans                | 2026-04-20 | 15    | 100%       | 53%      | +47pp   |
| dinopowers:systematic-debugging           | 2026-04-20 | 15    | 100%       | 27%      | +73pp   |
| dinopowers:test-driven-development        | 2026-04-20 | 15    | 100%       | 20%      | +80pp   |
| dinopowers:verification-before-completion | 2026-04-20 | 15    | 100%       | 13%      | +87pp   |
| dinopowers:receiving-code-review          | 2026-04-20 | 12    | 100%       | 33%      | +67pp   |
| dinopowers:requesting-code-review         | 2026-04-20 | 12    | 100%       | 25%      | +75pp   |
| dinopowers:finishing-a-development-branch | 2026-04-20 | 13    | 100%       | 38%      | +62pp   |
| bug-hunt                                  | 2026-04-20 | 15    | 100%       | 53%      | +47pp   |

\* Baseline was 100% because the skill was **hurting** behavior (10% with-rule).
After fix, skill no longer degrades natural tool selection.

\*\* Same pattern: skill had stale "22+" text (script requires 24+) and `npx`
instead of global binary. 0% with-rule before fix. Fixed version matches
baseline.
