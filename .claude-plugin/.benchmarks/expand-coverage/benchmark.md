# expand-coverage — 2026-07-04

Conversion of the `coverage-expander` **agent** into an agent-only **skill**
(`user-invocable: false`), sped up via tea-rags corner-case discovery + a
local-main freshness gate, then caveman-compressed and re-validated on the same
corpus. Supersedes the `coverage-expander` benchmark (2026-04-01).

## Summary

The `coverage-expander` sub-agent carried its whole methodology inline (slow,
verbose, blind discovery). This work:

1. **Extracted the methodology into `.claude/skills/expand-coverage/SKILL.md`**
   (`user-invocable: false` — agent-only, invoked by the sub-agent, not users).
2. **Kept the sub-agent as the entry point** — `coverage-expander.md` is now a
   thin shell that invokes `Skill(expand-coverage)`. Context isolation (own
   token budget on a failing pre-commit hook) is preserved; the CLAUDE.md
   pre-commit delegation reference is unchanged.
3. **Added a freshness gate (Step 0)** — always target the local-main index and
   incrementally reindex when the just-committed `src/` is not yet indexed, so
   corner-case search sees current source instead of a stale index.
4. **Added tea-rags corner-case discovery (Step 3)** — read the exact uncovered
   statement/branch/function ranges from `coverage-final.json`, then
   `find_symbol` / `hybrid_search` / `find_similar` / `get_callers` to
   understand and pattern-match them. Replaces "read the whole file and guess
   scenarios".
5. **caveman-compressed** the skill (body `ultra`, description `full`), output
   contracts (bash command, jq, output template) preserved byte-exact.
6. **Background dispatch (MANDATORY)** — the CLAUDE.md delegation now passes
   `run_in_background: true`; the sub-agent + skill are background-safe (fully
   autonomous, no interactive questions, final report = handoff).

## Changes

| #   | Change                                                                    | Why                                                                                 | Eval     |
| --- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------- |
| 1   | Agent methodology → agent-only skill (`user-invocable: false`)            | Reusable, isolable; agent stays a thin entry point                                  | 8,9,13   |
| 2   | Step 0 freshness gate — reindex local main if stale before search         | New/changed committed files invisible to a stale index → silent miss                | 2,11,13  |
| 3   | Step 3 corner-case discovery from `coverage-final.json` hit maps          | Target the exact uncovered branches, not blind whole-file reads                     | 12,13    |
| 4   | `find_similar` + `get_callers` added to discovery                         | Neighbor test scenarios + real caller inputs that reach the branch                  | 12       |
| 5   | Dead/unreachable-branch honesty clause                                    | Forbid fabricated tests / `v8 ignore` / threshold-lowering on dead code             | 14       |
| 6   | `npx vitest run` → `npm run test:coverage -- --run ... json+json-summary` | Emit both summary (target pick) and final (uncovered lines) in one run              | 1,3,8,10 |
| 7   | caveman compression (body ultra, description full)                        | Fewer tokens = faster agent reasoning; contracts kept byte-exact                    | all      |
| 8   | Background dispatch (`run_in_background: true`) + autonomy clause         | Slow coverage runs must not block the session; background agent = no interactive Qs | 15       |

## Metrics

- **Lines**: 158 → 134 caveman (−15%). **Chars**: 6770 → 5303 (−22%).
- **Iterations**: 0 fixes needed — verbose skill hit 100% on first eval; caveman
  held 100%.

## Eval results

Corpus = the 10 `coverage-expander` cases verbatim (regression parity, "the same
corpus") + 4 new-capability cases (11–14: freshness, corner-case discovery,
subagent+freshness, dead-code trap).

| Run                        | With-rule    | No-rule baseline | Delta  |
| -------------------------- | ------------ | ---------------- | ------ |
| Verbose v1 (baseline eval) | 14/14 (100%) | 3/14 (21%)       | +79pp  |
| Caveman (verify eval)      | 14/14 (100%) | — (unchanged)    | —      |
| — original 10 subset       | 10/10 (100%) | 3/10 (30%)       | +70pp  |
| — new 4 subset (11–14)     | 4/4 (100%)   | 0/4 (0%)         | +100pp |

**caveman did not regress routing** — with-rule stayed 14/14 after compression.

## Per-eval detail

| Eval | Type           | With-rule | No-rule | What the no-rule agent did wrong                                                                        |
| ---- | -------------- | --------- | ------- | ------------------------------------------------------------------------------------------------------- |
| 1    | audit          | PASS      | FAIL    | `npx vitest`, read src, scanned html report                                                             |
| 2    | audit          | PASS      | FAIL    | `Read` src file directly (no find_symbol/hybrid_search)                                                 |
| 3    | audit          | PASS      | PASS    | single measurement command (control)                                                                    |
| 4    | audit          | PASS      | FAIL    | `Read` src instead of hybrid_search                                                                     |
| 5    | audit          | PASS      | FAIL    | `Read` 0% src file directly                                                                             |
| 6    | control        | PASS      | PASS    | tests-only honored (control)                                                                            |
| 7    | control        | PASS      | PASS    | early exit (control)                                                                                    |
| 8    | subagent       | PASS      | FAIL    | `npx vitest` + read src                                                                                 |
| 9    | subagent       | PASS      | FAIL    | `npx vitest` + read src                                                                                 |
| 10   | edge (RU)      | PASS      | FAIL    | `npx vitest` + read src                                                                                 |
| 11   | new-freshness  | PASS      | FAIL    | no freshness reindex — searched stale index / read src                                                  |
| 12   | new-cornercase | PASS      | FAIL    | no `coverage-final.json` branch map; read src, `npx <file>`                                             |
| 13   | subagent-new   | PASS      | FAIL    | no reindex, read src                                                                                    |
| 14   | edge-deadcode  | PASS      | FAIL    | **shortcut trap**: added `v8 ignore` / `as never` fake test                                             |
| 15†  | new-background | PASS      | FAIL‡   | **interactive trap**: would `AskUserQuestion` (mock vs fixture) instead of deciding from neighbor tests |

† eval-15 added after the background-agent requirement; validated on the final
caveman+background skill = PASS, controls eval-1/eval-7 held (no regression).
Not part of the 14-case verbose-vs-caveman parity count. ‡ eval-15 no-rule is
inferred (the prompt explicitly asks "Which should you use?" — a no-rule agent
asks back or reads src), not independently graded.

## Key design decisions

- **Skill lives at `.claude/skills/expand-coverage/`** (project layer, alongside
  `optimize-skill` / `debug-pipeline-log`), not in a published plugin — no
  plugin version bump.
- **`user-invocable: false`** (precedent: `tea-rags:extract-project-patterns`).
  Agent-only skills still appear in an agent's Skill-tool list, so the sub-agent
  can invoke it; user prompts never trigger it.
- **Agent name preserved** (`coverage-expander`) — the CLAUDE.md pre-commit
  delegation (`subagent_type: "coverage-expander"`) keeps working unchanged.
- **No-rule baseline is stricter than the 2026-04-01 coverage-expander baseline
  (100%)** — that run graded a differently-primed baseline; here the no-rule
  agent was free to use `npx`/`grep`/`Read` (realistic natural behavior) and was
  graded strictly against the corpus's `NOT npx` / `NOT Read` expectations. The
  new capabilities (freshness, corner-case discovery) are pure skill value: a
  no-rule agent never reindexes-first, never reads `coverage-final.json` for
  exact branches, and falls into the dead-code shortcut trap.

## Method note

Phase-2/4 evals graded INSTRUCTION QUALITY (tool-selection plans), not live tool
execution — one subagent per run, all 14 cases in one prompt, blind to
`expected`. Grading done by the parent against `evals.json`.
