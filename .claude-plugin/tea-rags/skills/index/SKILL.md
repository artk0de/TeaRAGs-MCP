---
name: index
description:
  Index or reindex a codebase. First time — full index, then offers to register
  the project alias. Already indexed — incremental reindex (only changed files).
argument-hint: [path to codebase]
---

# Index Codebase

Smart indexing — call MCP tool directly (no subagent):

- **Not indexed** → full index, then offer to register the project alias
- **Already indexed** → incremental reindex (only changed files)

## Instructions

1. Extract `path` from the user's message or argument. If not provided, use the
   current working directory.

2. Call `mcp__tea-rags__index_codebase` directly with:
   - `path`: extracted path

3. After indexing finishes, check whether the project is already registered:
   call `mcp__tea-rags__list_projects` and look for an entry whose `path`
   matches the indexed path AND whose `name` is non-empty (entries auto-created
   by recovery have `name=""`).

4. If no alias entry exists:
   - Derive a default alias from the path: the final non-empty segment of the
     path, lowercased, with non-alphanumeric characters replaced by `-`, and
     prefixed with `p-` if it would otherwise start with a digit. The regex
     `^[a-z0-9][a-z0-9_-]{0,63}$` MUST match. Example:
     `/Users/me/Dev/Tools/Tea-RAGs MCP` → `tea-rags-mcp`.
   - Present the alias and ask the user once: "Register this codebase as project
     `<alias>`? (recommended — lets MCP tools address it by name instead of
     path.)" Offer to override the alias.
   - On user confirmation, call `mcp__tea-rags__register_project` with `path`
     and the chosen `name`. Report the result. If
     `[INPUT_PROJECT_NAME_NOT_UNIQUE]` is thrown, suggest a numeric suffix
     (`<alias>-2`) and retry once.
   - On decline, skip registration silently — the user can run
     `tea-rags projects register --path <path> --name <alias>` later.

5. Report the **full indexing result** (all metrics and duration), followed by
   the registration outcome if step 4 ran.

## Do NOT

- Spawn a subagent (Agent tool) — direct MCP call is much faster for incremental
  reindex. Subagent overhead (~10-15s) dwarfs the actual reindex time (~1-3s).
- Call with `forceReindex: true` — use `/tea-rags:force-reindex` for that.
- Skip the registration prompt on first-time indexing — it's the moment when the
  user knows the project best. After this they have to re-run the prompt
  manually.
- Re-register when an entry already exists for the path (even if the name is
  empty). The user can rename via the CLI; the skill shouldn't churn the
  registry on every reindex.
