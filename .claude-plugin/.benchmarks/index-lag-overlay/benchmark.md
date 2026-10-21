# Index Lag / Working-Tree Overlay Bailout Benchmark

Date: 2026-10-21. Cases: `cases.md`. Grades: `evals.json`.

## Summary

Incident (taxdome TD-105125): the first tea-rags answers in the alias's own
checkout carried `changedFiles: 1833`, `floors: []`, `pendingFiles: 1577` and a
drift warning whose `Run:` line said `--force`. Inside
`dinopowers:brainstorming` the agent concluded "index lags 1833 files, read from
disk", then did every decisive navigation step with Bash `cat` / `sed` / `grep`
/ `git`. It did the same inside `dinopowers:test-driven-development`. The
correct moves were an incremental `index_codebase`, which needs no consent on
the own checkout, one consent question for `--force`, and continued tea-rags
calls: the overlay was warming, and `pendingFiles` fell 1609 → 1033 across the
four calls.

Root cause, measured: one rule gap plus a salience gap.

1. **Rule gap (A1).** `index-freshness` had no row for content lag on the own
   checkout when drift needs `--force`. The only visible action was gated on
   consent, and the phrase "an incremental run neither refuses nor fixes it"
   read as "incremental is useless". The wrapper freshness paragraphs covered
   uncommitted edits only, not a HEAD move or branch switch.
2. **Salience gap (A2–A4).** "Lag ≠ unusable", "a row without `treeState` is
   current" and "the Bash shell channel counts as a downgrade" lived only in the
   SessionStart injection, partly implied rather than stated. The wrapper the
   agent was executing linked to them and did not carry them. The wrapper-only
   arm reproduces the incident verbatim: in E1/E2 it reasons "`floors:[]` →
   nothing came from the tree → Read + rg".
3. **Delivery (A5).** The corpus needed 9 parts while `plugin.json` wired 8. The
   tail was dropped silently. At the time it held only the human-facing section,
   but any growth would have pushed agent rules out.

A competing instruction sharpened the failure: the auto-mode harness prompt
recommends "read files with cat … search with grep" through Bash.

## Results

| Arm                                               | Before      | After        |
| ------------------------------------------------- | ----------- | ------------ |
| No rule (tool list only)                          | 6/15 (40%)  | —            |
| Full rules read fresh                             | 13/15 (87%) | 15/15 (100%) |
| Wrapper-only (in-situ: rules injected, not focus) | 7/15 (47%)  | 15/15 (100%) |

Delta vs no-rule: +60pp. Delta on the in-situ arm: +53pp.

## Changes

| File                                                  | Change                                                                                                                                                                                                                    | Finding |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `tea-rags/rules/index-freshness.md`                   | New row: own checkout + `changedFiles` > 0 → incremental now, also under drift `--force` (ask separately; subagent reports). New section "Lag never licenses leaving tea-rags". Do NOT list names the Bash shell channel. | A1–A3   |
| `tea-rags/rules/search-cascade.md`                    | "Lag ≠ unusable (MANDATORY)" paragraph under the marker reading; two Prohibited Patterns (Bash shell over code; leaving tea-rags on lag); `pendingFiles` wording no longer reads as a blanket "never reindex"             | A2, A3  |
| `tea-rags/rules/references/subagent-injection.md`     | One bullet: lag ≠ unusable, a row without `treeState` is current, never reindex, report to the parent                                                                                                                     | A2      |
| `dinopowers/FRESHNESS.md`                             | "Lag ≠ unusable" bullet                                                                                                                                                                                                   | A4      |
| 9 `dinopowers/skills/*/SKILL.md`                      | Freshness paragraph covers HEAD move / branch switch plus an inline "Lag ≠ unusable" sentence                                                                                                                             | A1, A4  |
| 12 `tea-rags/skills/*/SKILL.md` (code-reading skills) | Inline "Lag ≠ unusable" paragraph near the addressing / prerequisites text                                                                                                                                                | A4      |
| `tea-rags/.claude-plugin/plugin.json`                 | Rule injection 8 → 9 slots (both SessionStart groups); the corpus fits again                                                                                                                                              | A5      |

Lines: index-freshness 80 → 101; search-cascade 531 → 544.

## Key design decisions

- **Duplication is deliberate.** The one-sentence rule is repeated in every
  wrapper and code-reading skill. The measured failure is salience: a link to
  FRESHNESS.md or index-freshness is not read at the decision point, and an
  inline sentence is. The owner of the full protocol stays `index-freshness`
  "Lag never licenses leaving tea-rags", and inline copies point at it.
- **The own checkout and a linked worktree split on "reindex now".** The own
  checkout runs an incremental, which is cheap and consent-free, because dense
  vectors of changed files lag otherwise. A linked worktree and a subagent never
  reindex; they re-call and report.
- **Explicit user override survives.** E13 guards against over-correction: when
  the user explicitly asks for a manual read, `Read` is correct.

## Out of scope (product, not instruction)

These came from the incident case study and need code changes, not rule text.

- Graph tools block about 120 s on the tree-graph build timeout before answering
  from index edges.
- Ruby `dynamic` dispatch resolves `String#present?` onto a project namesake
  with confidence 1.
- The `workingTree` marker could carry an explicit "overlay serving" hint.
- Auto-update was not configured for taxdome (`tea-rags auto-update status`
  reports `disabled`). That is why lag accumulated across a branch switch.
