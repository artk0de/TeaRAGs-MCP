# 4mffb baseline: migration history, work-list completeness, class contract

Cases: `../evals/2026-10-31-migration-history-class-contract.json` (E1 table
state with no `db/schema.rb` and a rename hidden in `safety_assured`, E2 class
contract partly inherited from two project ancestors, E3 exhaustive "all models
including X" list of 6 files plus a TODO-comment decoy, C1 table-absence
control).

Plugin: tea-rags 0.53.10 at `8cdbfdec9` (baseline only; no plugin text was
changed).

## Result: every case passes on the CURRENT plugin, so none of the three rules was added

| Case                        | Codex r1 | Codex r2 | Codex r3 | Claude r1 |
| --------------------------- | -------- | -------- | -------- | --------- |
| E1-table-state-no-schema    | PASS     | PASS     | PASS     | PASS      |
| E2-class-contract-inherited | PASS     | PASS     | PASS     | PASS      |
| E3-exhaustive-work-list     | PASS     | PASS     | PASS     | PASS      |
| C1-table-absence-control    | PASS     | PASS     | PASS     | PASS      |

Graded by the lane agent against `grading` (outcome + required reads), from the
traces in `codex-baseline/summary.json` and `claude-baseline/summary.json`.

- E1: Codex ran `rg -l ledger_payouts db/schema.rb` (absent), then `rg -l` over
  `db/migrate/`, and read EVERY listed migration (7–8 per run, including the
  rename). It reported initiator\_\* columns, the two current indexes, the FK to
  accounts, and the incoming FK as incoming. None of the runs used
  `hybrid_search(scope:"migrations")`. Claude read all migrations through one
  shell loop and got the same answer.
- E2: Codex 3/3 opened the class outline, followed the `< BaseSyncJob` and
  `< ApplicationJob` headers through `find_symbol`, and cited each setting at
  its declaring class. Claude got the right answer but went through `Read` and
  `Grep` after the first `find_symbol` (a route deviation, not an outcome
  failure).
- E3: Codex 3/3 ran `rg -l Auditable app/` and read the hits through
  `find_symbol`. All 6 models were correct and the TODO decoy was excluded with
  its reason. Claude answered correctly from `Grep -A2` content.
- C1: in every run the literal search covered `db/schema.rb` and then
  `db/migrate/`, and the answer was "no" with evidence.

## Limitations

- Synthetic fixtures served by a fixture MCP (`repro/fixture_mcp.py`, extended
  with migration-scope rows and Ruby container headers). These runs validate
  routing only, not the real index.
- The GruntWorx Q36/Q22 failures happened deep inside a long multi-question
  session with a large corpus: 8 files, 5 read by name guess. A fresh
  single-question session on a small fixture does not reproduce them, so the
  failure looks like long-session/context pressure rather than a missing core
  rule. A reproduction needs retained-context replay of the original checkpoint,
  as `research/codex-q24-validated-2026-10-30` did.
- Codex runs: `gpt-6.1-sol`, medium effort, codex-cli 0.166.0, native
  app-server, isolated CODEX_HOME, trusted plugin hooks verified by preflight.
  Claude: `claude-opus-5-5`, `--plugin-dir` baseline package,
  `--setting-sources project`, fixture MCP through `--strict-mcp-config`. User
  `~/.claude/CLAUDE.md` may still load.
- No "after" arm: there was no text change to measure.
