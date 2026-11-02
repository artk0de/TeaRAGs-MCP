# Codex request — architecture-diagnostics `## Next steps` (2026-11-02)

For the Codex session. Claude ×1 per case per arm is done (see `README.md`); the
repo eval gate also needs Codex ×3 per case per arm. Codex evals are run by
Codex, never by Claude.

- Suite:
  `.claude-plugin/.benchmarks/architecture-diagnostics/evals/2026-11-02-next-steps.json`
  (cases A1, A2, A3, C1; `fixture` is actor-visible, `expected` / `grading` /
  `fixture_notes` are not).
- Arms:
  - baseline — tea-rags 0.54.4, `main` @ `196a3ce4e`
    (`git archive 196a3ce4e harness/codex` for the Codex package).
  - current — tea-rags 0.55.0, `worktree-risk-report-actionable` @ `568c6a134`
    (`harness/codex` of that commit).
- Runs: ×3 per case per arm, isolated `CODEX_HOME`, plugin hooks trusted and
  verified by preflight, fixture MCP from `repro/fixture_mcp.py` (serves
  `get_architecture_report`, `.restructure`, `.restructurePlan`,
  `find_co_changed` from `fixture.tool_responses`).
- Fixture specifics the Codex runner must reproduce (see `repro/claude_run.py`):
  - `/work/auth-demo` → the isolated workspace; `__FIXTURE_ROOT__` likewise.
  - A2/A3 `initial_context`: replay as retained context; substitute
    `__SKILL:architecture-diagnostics__` with the ARM's
    `skills/architecture-diagnostics/SKILL.md` text and `__PLUGIN_ROOT__` with
    the arm's plugin root.
  - A2: create `fixture.workspace_dirs` (`.beads/`) and shim `bd` on PATH so it
    logs argv to `bd-calls.log` (a `create` line = check `no-shim-create`
    fails). `--help` / `-h` must print usage and never fake a create — the first
    Claude baseline A2 run was invalidated by exactly that.
- Grade with `repro/grade.py` semantics (deterministic kinds) plus the
  `answer_criterion` checks; Codex needs `Skill(...)` mapped to its skill-load
  equivalent for `require_invoke` / `forbid_invoke`.
- Expected: baseline FAILS A1–A3, PASSES C1; current PASSES all four.
- Persist under `2026-11-02-next-steps/codex-<arm>/` with the same per-case
  layout (gzipped stream, `fixture-tool-audit.jsonl`, `status.json`) and append
  the Codex rows to `README.md` / `summary.json`.
