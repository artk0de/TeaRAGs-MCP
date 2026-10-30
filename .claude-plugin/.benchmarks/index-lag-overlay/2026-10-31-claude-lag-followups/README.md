# Claude baseline: Codex "Lag follow-ups" rules R1/R2

Question: does Claude on the current shared core (`plugins/tea-rags/rules/core.md`,
package `.claude-plugin/tea-rags` 0.53.10 at `0d2b2a145`) already do what the
Codex-only rules in `codex-rules.txt` (`scripts/gen-harness-codex.ts`,
"Lag follow-ups") demand?

- R1: an incremental `index_codebase` is a prelude; the request is still served.
- R2: a graph answer with `changedFiles` > 0 and no `codegraph` floor → re-check
  changed-file callers via `find_symbol`, find missing ones by literal search,
  never a bare graph retry.

## Result: every case passes, so neither rule is ported

| Case  | Run | Verdict | Tool sequence |
| ----- | --- | ------- | ------------- |
| E14   | r1  | PASS | Grep (parallel) → get_callers → index_codebase → find_symbol(both callers) |
| E15   | r1  | PASS | index_codebase → find_symbol(relativePath) → find_symbol(5 methods) |
| E16   | r1  | PASS | Grep (parallel) → get_callers (3) → index_codebase → find_symbol(refund_builder.rb) → Grep → get_callers after index (4) |
| E14b  | r1, r2 | PASS, PASS | get_callers → index_codebase → find_symbol(caller) → Grep → find_symbol(sessions_controller.rb) |
| E15nl | r1, r2 | PASS, PASS | index_codebase → semantic_search(fused) → find_symbol(batch) |
| E16b  | r1  | PASS | get_callers (3) → Grep ×2 → 4 callers (did not index) |
| E16b  | r2  | PASS | Grep (parallel) → get_callers → index_codebase → Bash grep |

The gate is E14, E15 and E16, one run each. The `b`/`nl` rows are discriminators:
they remove the shortcut that could let a case pass without the rule under test.

- E14b/E16b drop the "every caller" / "complete list" wording. That wording
  triggers core's "all callers → get_callers + usages row" line, which would
  produce the Grep on its own. Without it, Claude still searched literally and
  read the changed-file callers. The trigger was the lag signal (`changedFiles`,
  `treeGraphUnavailable`).
- In E15nl the adapter is not one of the uncommitted files. In E15 r1, Claude
  Code's gitStatus context exposed its path, so the actor went straight to
  `find_symbol(relativePath)` and skipped `semantic_search`. With the path hidden,
  both runs used `semantic_search` after the index, matching the literal E15
  expectation.

Across 9 runs: 0 bare graph retries, 0 answers that passed off a partial graph
answer as complete, and the user's request was served after every
`index_codebase`.

## Method

This is an actor run, not a plan-only text scenario. It follows the 4mffb setup in
`../../search-cascade/2026-10-31-4mffb/repro/`:

- `claude -p --model opus` with `--plugin-dir .claude-plugin/tea-rags` (the
  SessionStart hook injects `rules/core.md`), `--strict-mcp-config`, and
  `--setting-sources project`.
- `tea-rags prime` is shimmed to the case digest.
- `repro/fixture_mcp.py` is the 4mffb server plus `index_codebase` /
  `get_index_status`. Once an index runs, it serves the `<tool>@indexed`
  responses.
- Each workspace is a real git repo, its own checkout, whose uncommitted edits
  are the changed files.

Fixtures are in `repro/cases.py`. Run `python3 repro/run.py E14,E15,E16 r1` for the
gate and `sh repro/batch.sh` for the discriminators. `repro/trace.py runs/<id>`
prints the tool sequence. Transcripts are in `runs/<case>-<run>/stream.jsonl`, and
fixture-side call audits are in `fixture-tool-audit.jsonl`.

E14 and E15 reuse the situations in `../cases.md` / `../evals.json` as written. The
user prompt is a natural request that leads to that situation, because an actor
run cannot start halfway through a tool answer. E16 is new: see `cases-e16.md`
and `evals-e16.json`.

## Limitations

- These are synthetic fixtures. They validate routing only, not the real index.
- The user `~/.claude/CLAUDE.md` may still load (as in 4mffb).
- E16b r1 did not run the incremental `index_codebase` on its own checkout. That
  is a deviation from core's freshness line, but it does not fail R2: the missing
  caller was found by literal search and reported.
- With Claude ×1 per gate case and no FAILs, no reruns were required. The
  discriminators add n=2 per variant.
