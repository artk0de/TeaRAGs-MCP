---
name: index
description:
  Index or reindex a codebase. First time — register the alias and index in one
  command (index-codebase --name). Already indexed — incremental reindex (only
  changed files).
argument-hint: [path to codebase]
---

# Index Codebase

Smart indexing — check registration first, then index:

- **Not registered yet (first index)** → register the alias and index in one
  command: `tea-rags index-codebase <path> --name <alias>`
- **Already indexed** → incremental reindex via the MCP tool (only changed
  files)

## Instructions

1. Extract `path` from the user's message or argument. If not provided, use the
   current working directory.

2. Check whether the path is already registered: call
   `mcp__tea-rags__list_projects` and look for an entry whose `path` matches the
   target path AND whose `name` is non-empty (entries auto-created by recovery
   have `name=""`).

3. **Not registered yet (first index) — register + index in one command.**
   Derive a default alias from the path: the final non-empty segment,
   lowercased, with non-alphanumeric characters replaced by `-`, and prefixed
   with `p-` if it would otherwise start with a digit. The regex
   `^[a-z0-9][a-z0-9_-]{0,63}$` MUST match. Example:
   `/Users/me/Dev/Tools/Tea-RAGs MCP` → `tea-rags-mcp`.
   - Present the alias and ask once: "Index and register this codebase as
     project `<alias>`? (recommended — lets MCP tools address it by name instead
     of path.)" Offer to override the alias.
   - On confirmation, run the CLI — it registers the alias, then indexes, in one
     step: `tea-rags index-codebase <path> --name <alias>`. If
     `[INPUT_PROJECT_NAME_NOT_UNIQUE]` is returned, suggest a numeric suffix
     (`<alias>-2`) and retry once.
   - On decline, index without an alias via `mcp__tea-rags__index_codebase`
     (`path`); the user can register later with
     `tea-rags projects register --path <path> --name <alias>`.

4. **Already registered → incremental reindex.** Call
   `mcp__tea-rags__index_codebase` with `project: <alias>` (or `path`). Do NOT
   re-register — the alias already exists.

5. Report the **full result** (all metrics and duration), plus the alias that
   was registered when step 3 ran the `--name` path.

## Do NOT

- Spawn a subagent (Agent tool) — direct MCP call is much faster for incremental
  reindex. Subagent overhead (~10-15s) dwarfs the actual reindex time (~1-3s).
- Call with `forceReindex: true` — use `/tea-rags:force-reindex` for that.
- Skip the alias prompt on first-time indexing — it's the moment the user knows
  the project best, and `--name` makes registering free (one command). After
  this they'd have to register manually.
- Register after the fact with `mcp__tea-rags__register_project` on a first
  index — the `index-codebase --name` CLI does register+index in one step.
  Reserve `register_project` for re-pointing an existing alias, not first-time
  setup.
- Re-register when an entry already exists for the path (even if the name is
  empty). The user can rename via the CLI; the skill shouldn't churn the
  registry on every reindex.
