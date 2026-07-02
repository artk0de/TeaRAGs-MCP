---
name: index
description:
  Index/reindex codebase. First time — register alias + index in one command
  (index-codebase --name). Already indexed — incremental reindex (only changed
  files).
argument-hint: [path to codebase]
---

# Index Codebase

Smart indexing — check registration first, then index:

- **Not registered yet (first index)** → register the alias and index in one
  command: `tea-rags index-codebase <path> --name <alias>`
- **Already indexed** → incremental reindex via the MCP tool (only changed
  files)

## Instructions

1. Extract `path` from user message or argument. If absent, use current working
   directory.

2. Check if path already registered: call `mcp__tea-rags__list_projects`, find
   entry whose `path` matches target AND whose `name` non-empty (recovery
   auto-created entries have `name=""`).

3. **Not registered yet (first index) — register + index in one command.**
   Derive default alias from path: final non-empty segment, lowercased,
   non-alphanumeric replaced by `-`, prefixed `p-` if it would start with a
   digit. Regex `^[a-z0-9][a-z0-9_-]{0,63}$` MUST match. Example:
   `/Users/me/Dev/Tools/Tea-RAGs MCP` → `tea-rags-mcp`.
   - Present alias, ask once: "Index and register this codebase as project
     `<alias>`? (recommended — lets MCP tools address it by name instead of
     path.)" Offer alias override.
   - On confirmation, run CLI — registers alias, then indexes, one step:
     `tea-rags index-codebase <path> --name <alias>`. If
     `[INPUT_PROJECT_NAME_NOT_UNIQUE]` returned, suggest numeric suffix
     (`<alias>-2`), retry once.
   - On decline, index without alias via `mcp__tea-rags__index_codebase`
     (`path`); user registers later with
     `tea-rags projects register --path <path> --name <alias>`.

4. **Already registered → incremental reindex.** Call
   `mcp__tea-rags__index_codebase` with `project: <alias>` (or `path`). Do NOT
   re-register — alias already exists.

5. Report **full result** (all metrics and duration), plus alias registered when
   step 3 ran the `--name` path.

## Do NOT

- Spawn a subagent (Agent tool) — direct MCP call much faster for incremental
  reindex. Subagent overhead (~10-15s) dwarfs actual reindex time (~1-3s).
- Call with `forceReindex: true` — use `/tea-rags:force-reindex` for that.
- Skip alias prompt on first-time indexing — that's the moment user knows the
  project best, and `--name` makes registering free (one command). After this
  they'd register manually.
- Register after the fact with `mcp__tea-rags__register_project` on a first
  index — `index-codebase --name` CLI does register+index in one step. Reserve
  `register_project` for re-pointing an existing alias, not first-time setup.
- Re-register when an entry already exists for the path (even if name empty).
  User can rename via CLI; skill shouldn't churn the registry on every reindex.
