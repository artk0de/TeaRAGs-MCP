# Addressing Consistency Benchmark

Date: 2026-10-21. Bead: `tea-rags-mcp-1v7n3`. Cases: `cases.md`. Grades:
`evals.json`.

## Contract

- `project` names the index. Agents pass it on every call; the schema keeps it
  optional for now. With `project` alone, the tree is the alias's registered
  checkout in its current state: any branch, uncommitted edits included.
- `path` names the tree: the agent's working directory, whether a branch
  checkout or a linked worktree. It is passed together with `project`, and it is
  the only way to read a linked worktree, because the MCP server cannot know the
  agent's cwd.
- `index_codebase` takes `project` only. Its `path` registers a new root; from a
  linked worktree it seeds a separate project.

## Why

The layers contradicted each other. The schema marked `project` as
`[RECOMMENDED]` and the prime hint said "`project` preferred over path", while
search-cascade and the skills said "path is the default, never project alone".
The before-fix eval agent named the conflict outright and resolved it case by
case. In the taxdome sessions this showed up as calls that alternated between
`path` and `project`.

## Results

| Arm           | Pass         |
| ------------- | ------------ |
| Before (B1–4) | 5/12 (42%)   |
| After         | 12/12 (100%) |

## Changes

| Layer         | Change                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| MCP schema    | `projectField` / `WORKING_TREE_PATH_HINT` / collection text; `codegraph.ts` reuses them; `index_codebase` project/path text   |
| MCP resources | `registry.ts` param reference: project = index, path = tree, `index_codebase` exception                                       |
| prime         | hint: pass `project` on every call plus `path: <your working directory>`                                                      |
| workingTree   | marker carries `project`, the alias of the answering index (`WorkingTreeOverlay#measure`, output schema, text formatter)      |
| CLI           | `tea-rags project exist --repository` resolves an alias from any dir in the repository, worktrees and subdirectories included |
| SubagentStart | hook prepends "tea-rags project alias for this repository: `<alias>`"                                                         |
| Plugin rules  | search-cascade "Addressing the Codebase" rewritten; index-freshness, FRESHNESS and the subagent block aligned                 |
| Skills        | 14 SKILL.md (6 tea-rags, 8 dinopowers): `project=<alias>` + `path=<your working directory>`                                   |

Schema strings are shorter than first drafted. The existing budgets were kept:
20 words per param hint and 1536 bytes for the naming-lexicon input schema.

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet
- Result: 11/12 PASS (92%)
- Last recorded rate: 100% (12/12 after-fix, 2026-10-21; opus arm)
- FAIL list: C12 - subject searched with path alone and used the raw collection only as a fallback; expected collection first (project from marker). Cause: core.md addressing paragraph has no collection row; it lives only in guides/freshness.md:20, not read.
- Notes: Artifact mapped to core.md addressing paragraph + guides/freshness.md. Delta -8pp. Subject was sonnet (original used opus).
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace, real hooks (plan-only)
- Result: 10/12 PASS (83%) over graded cases (N/A excluded: 0)
- Claude T12 rate for comparison: 11/12 (92%)
- CODEX-ONLY: C9 (index_codebase told to omit path for unregistered repo; core 'project only' over-generalised - model behaviour), C10 (asks user for path instead of project-only addressing - model behaviour)
- Both-fail count: 0

## 2026-10-23 — Cursor run (Task 15)

- Subject: Cursor CLI 2026.10.22, model auto (free plan), plan-only, plugins from harness/cursor (tea-rags + dinopowers), sessionStart hook digest; no superpowers, no subagentStart injection.
- Partial run — Cursor free-plan usage limit stopped the eval after 7 of 45 parts.
- Result: 11/12 PASS (92%) over graded cases (N/A excluded: 0).
- Claude T12 for comparison: 11/12 (92%).
- Codex T14 for comparison: 10/12 (83%).
- FAIL: C10 (asks user for path instead of project-only addressing; vs-claude, Codex also failed).
- CURSOR-ONLY: none.
- Both-fail count (all): 0.

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet (plan-only simulation, blind)
- Result: 12/12 PASS (100%) over 12 scored cases (0 superseded)
- Task 12 rate: 11/12 (92%)
- Delta: +8pp
- FAIL list: none - notes: (C12 now collection-first; fixed)
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace (tea-rags 0.46.10 + dinopowers 0.24.3 + superpowers 7.0.1), real hooks (plan-only)
- Result: 11/12 PASS (92%) over 12 graded cases (N/A 0)
- Codex T14 for comparison: 10/12 (83%)
- Claude T22 for comparison: 12/12 (100%)
- FAIL list:
  - ` C10 ` — FAIL ( still; Claude T22 PASS ) asks caller for repo path instead of project-only addressing (model behaviour) 

## 2026-10-23 — evals-to-100 re-run round 2 (Task 22)

- Subject model: sonnet (plan-only simulation, blind; full cases.md scenarios given to the subject)
- Result: 12/12 PASS (100%) over 12 scored cases (superseded: 0)
- Baseline (round 1): 12/12 (100%)
- Delta: +0pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run round 2 (Task 22)
- Subject: Codex CLI 0.162.1, default model, plan-only; plugins tea-rags 0.46.11 / dinopowers 0.24.4.
- Result: 12/12 PASS (100%) (N/A excluded: 0).
- Round-1 Codex: 11/12 (91.7%). Delta: +8.3 pp.
- FAIL list: none.
