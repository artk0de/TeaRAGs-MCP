# Codex request — risk-assessment actionable report

Run by the Codex session, not by Claude. Arms × cases × 3 runs.

## Arms

| Arm      | Codex package                                                 |
| -------- | ------------------------------------------------------------- |
| baseline | `git archive 196a3ce4e harness/codex/tea-rags` (main, 0.54.4) |
| current  | `harness/codex/tea-rags` at `568c6a134` (0.55.0)              |

## Cases

Suite:
`.claude-plugin/.benchmarks/risk-assessment/evals/2026-11-02-actionable-report.json`
(regenerate with `repro/build_suite.py`). Cases R1, R2, R3, R4, C1 — each in its
OWN session (never several cases in one session; skill-authoring §3 #48).

Per case, reproduce what `repro/run.py` does for Claude:

1. Workspace = fresh dir; replay `fixture.git_history` as a real git repo with
   `build_suite.build_repo(cwd, history, fixture.git_remote)` (fixed
   authors/dates → same SHAs as the Claude runs); then write the remaining
   `fixture.files` (`.beads/` for R3).
2. MCP server `tea-rags` =
   `repro/fixture_mcp.py --fixture <fixture.json> --audit <audit.jsonl> --plugin-root <arm package>`,
   where fixture.json =
   `{cwd, alias, files, raw_tool_responses, metrics: fixture.label_maps}`.
   tea-rags results arrive in `structured_content`.
3. PATH shims FIRST in PATH (Codex runs `zsh -lc`; check the login profile does
   not reorder PATH — skill-authoring §3 #66): `tea-rags` (`prime` → digest with
   `fixture.prime_extra`, `resource` → `fixture.label_maps`), `bd` and `gh` (log
   every call; `bd create` prints `Created issue: widgets-1`).
4. Prompt: R3/R4 prepend `fixture.initial_context` as retained context, with the
   `__SKILL_TEXT:risk-assessment__` placeholder replaced by the ARM's own
   `skills/risk-assessment/SKILL.md` (Base directory line pointing at that arm's
   package). Never pass `expected`, `grading` or `fixture_notes`.
5. Neutral SessionStart digest: the stand must not inject the host repo's
   digest/alias (§3 #46).

## Grading

`repro/grade.py` reads Claude stream-json; for Codex, map the jsonl to the same
shape (ordered tool calls with name + input, a message id per assistant turn,
final answer text) or grade by each case's `grading.checks` text. Expected:
baseline FAILS R1–R4, PASSES C1; current PASSES all at 3/3.

Known current-arm fork from the Claude run (R1, R2, 2/2): the third computeTotal
pick skips `fix typo in rounding comment` — see README "Current-arm failure".
Record whether Codex reads `enrich.md` step 7 the same way.

Persist under `codex/<arm>/<case>/run<N>/` (gzip transcripts) and add a Codex
column to the README table.
