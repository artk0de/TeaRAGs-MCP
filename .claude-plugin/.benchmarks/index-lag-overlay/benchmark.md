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

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet
- Result: 11/15 PASS (73%)
- Last recorded rate: 100% (15/15 full-rules after, 2026-10-21)
- FAIL list: E1 (no incremental index_codebase on own checkout, no AskUserQuestion for --force), E7 (same), E15 (stale banner: skipped incremental index_codebase), E13 (user said just read the file by hand; subject refused and used find_symbol instead of Read/user override)
- Notes: Artifact mapped to core.md + guides/freshness.md. Root cause: core.md line ~57 says only 'Subagent: never reindex'; the own-checkout incremental-without-consent rule (guides/freshness.md:58,83,135) did not reach the subject's plan. Delta -27pp.
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default Codex model, plan-only, plugins (tea-rags 0.46.8 + dinopowers 0.24.2 + superpowers 7.0.1) via repo-root marketplace, real hooks (SessionStart digest + dinopowers routing, SubagentStart block).
- Result: 15/15 PASS (100%) over graded cases (N/A excluded: 0).
- Claude T12 for comparison: 11/15 (73%).
- CODEX-ONLY: none.
- Both-fail count: 0.

## 2026-10-23 — Cursor run (Task 15)

- Subject: Cursor CLI 2026.10.22, model auto (free plan), plan-only, plugins from harness/cursor (tea-rags + dinopowers), sessionStart hook digest; no superpowers, no subagentStart injection.
- Partial run — Cursor free-plan usage limit stopped the eval after 7 of 45 parts.
- Result: 15/15 PASS (100%) over graded cases (N/A excluded: 0).
- Claude T12 for comparison: 11/15 (73%).
- Codex T14 for comparison: 15/15 (100%).
- CURSOR-ONLY: none.
- Both-fail count (all): 0.

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet
- Result: 14/15 PASS (93%) over scored cases (superseded: 0)
- Task 12 rate: 73%
- Delta: +20pp
- FAIL list: E1 (plans a direct Read of the ticket-named files instead of find_symbol/hybrid_search (failure mode: leaving tea-rags for disk reads under index lag))
- Notes: T12 fails E1/E7/E13/E15 fixed except E1 (new failure mode).
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plan-only, plugins (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1) via repo-root marketplace, real hooks (SessionStart digest + dinopowers routing, SubagentStart block), AGENTS.md = core.
- Result: 11/15 PASS (73%) over graded cases (N/A excluded: 0).
- Codex T14: 15/15 (100%). Claude T22: 14/15 (93%).
- Notes: Cause: plans honour the eval "no index tools" constraint rather than naming the incremental refresh; possible harness artifact.
- FAIL list:
  - `E1` — FAIL; new: No incremental index_codebase on own checkout (asks consent only for --force); find_symbol/hybrid ok. Claude T22 FAIL (different mode)
  - `E6` — FAIL; new: Own checkout MARKER-COLD: find_symbol only, no incremental index_codebase.
  - `E7` — FAIL; new: No incremental index_codebase before test-convention search (declares no indexing); no explicit tests-as-context chunk search named.
  - `E14` — FAIL; new: Own checkout: no incremental index_codebase ("do not reindex in hypothetical read-only flow"); find_symbol + hybrid re-check correct.
