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
