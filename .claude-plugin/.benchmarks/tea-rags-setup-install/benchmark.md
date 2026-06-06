# Benchmark — `tea-rags-setup:install`

Feature-driven eval added alongside the new **Step 9 (Register Project Alias)**
in the install wizard (`steps/step-9-register.md`, verify renumbered to Step
10). Tests instruction quality: does the skill text guide an agent to register
the project _before_ the first indexing, derive the alias by the documented
convention, respect the "don't index during setup" boundary, export `QDRANT_URL`
so the registry captures the right backend, and keep step order 8 → 9 → 10.

## Summary

| Config        | Pass rate        |
| ------------- | ---------------- |
| **With-rule** | **11/11 (100%)** |
| Without-rule  | 9/11 (82%)       |
| **Delta**     | **+18pp**        |

Method: one with-rule subagent (full skill text injected) and one without-rule
subagent (only the available MCP/CLI tools listed), each given all 11 cases,
describing tool-selection plans without executing. Phase 2 lightweight
tool-selection eval per `optimize-skill`.

## Eval cases (11)

5 findings (A1–A5) · 2 controls · 2 edges · 2 subagent-routing.

| #   | Name                         | Tests                                                   | With | Without  |
| --- | ---------------------------- | ------------------------------------------------------- | :--: | :------: |
| 1   | register-before-index        | next action after Step 8 = register, not index          | PASS |   PASS   |
| 2   | registration-is-not-indexing | Step 9 records alias only, no index                     | PASS |   PASS   |
| 3   | alias-derivation             | `/…/My_Cool-App` → `my_cool-app` (`_` preserved)        | PASS | **FAIL** |
| 4   | qdrant-url-export-external   | export `QDRANT_URL` before register                     | PASS |   PASS   |
| 5   | step-ordering                | 8 configure → 9 register → 10 verify                    | PASS |   PASS   |
| 6   | control-defer-indexing       | "index now" mid-setup → defer to post-restart           | PASS | **FAIL** |
| 7   | control-mcp-config-step8     | integrator + `claude mcp add`                           | PASS |   PASS   |
| 8   | edge-embedded-qdrant         | embedded → omit `QDRANT_URL`                            | PASS |   PASS   |
| 9   | edge-cli-not-on-path         | report + continue, don't block                          | PASS |  PASS\*  |
| 10  | subagent task-agent          | finalize: register `acme-api` before verify, no index   | PASS |   PASS   |
| 11  | subagent plan-executor       | resolve abs, alias `backend`, register→verify, no index | PASS |   PASS   |

\* borderline — baseline substituted the `register_project` MCP tool, which is
not yet reachable during setup (server not restarted); it did not block, so
graded PASS.

## Key discriminators (where the skill adds value)

1. **Alias convention (case 3).** The skill replaces only chars _outside_
   `[a-z0-9_-]`, preserving `_` → `my_cool-app`. The baseline over-normalized
   `_` → `-` (`my-cool-app`), which would register a different alias than the
   documented one.
2. **Don't-index boundary under pressure (case 6).** When the user says "index
   now" mid-setup, the baseline obeyed and called `index_codebase` during setup;
   the skill defers indexing to `/tea-rags:index` after restart. This is the
   boundary the new step was explicitly written to protect.
3. **CLI vs MCP tool during setup.** The baseline reached for
   `mcp__tea-rags__register_project` in several cases; during setup the MCP
   server is configured but not yet restarted, so the tool is unreachable. The
   skill correctly uses the standalone CLI `tea-rags projects register`.

## Why delta is modest (+18pp)

The end-state behavior ("register, then defer indexing") is intuitive and the
MCP/CLI tool names are self-describing, so the baseline already scores 82%. The
skill's value concentrates in the exact conventions the baseline cannot guess:
alias formatting, the firm don't-index boundary, and the CLI-not-MCP choice
during a pre-restart setup. These are precisely the regression risks worth
locking down — the eval is retained as a regression guard for future edits.

## Phase 3 (FIX)

**No changes applied.** All audit hypotheses A1–A5 passed the with-rule eval —
the skill text already guides correctly. Per the methodology, instructions that
pass are not "fixed"; touching them would risk regression without evidence of a
problem. With-rule is at the 100% target; no iteration needed.

## Artifacts

- `evals.json` — 11 cases + per-case results.
- `workspace/iteration-1/grades.txt` — raw grading.
- `workspace/skill-snapshot/install/` — frozen skill copy at eval time.
