---
name: index
description:
  "Index/reindex codebase. First time — register alias + index in one command
  (index-codebase --name). Indexed — incremental reindex. Corrupt index →
  force-reindex."
---

# Index Codebase

Branches (plan names every one that can apply — path unknown = all of them):

- **Linked git worktree** of a registered repo → do NOT register or index; read
  tools (`project` + `path=<worktree>`) already answer for that tree.
- **Not registered (first index)** → ask once, then register alias + index in
  one command: `tea-rags index-codebase <path> --name <alias>`. **Declined** →
  `index_codebase(path=<path>)`, no alias.
- **Already indexed** → incremental `index_codebase(project=<alias>)` (changed
  files only).
- **Corrupt index / payload-schema drift** → `$force-reindex`, never
  incremental.

## Instructions

0. **Broken / corrupt index** (user reports wrong, garbage, crooked data, "index
   broke") → stop here, route `$force-reindex` (full rebuild, asks
   confirmation). Incremental re-reads changed files only — corrupt unchanged
   content stays. Never `forceReindex: true` from this skill. Same route for
   schema / payload drift ("payload schema changed", "new fields require reindex
   to populate") with no `Run:` line naming the plain incremental: incremental
   never populates new fields in unchanged files — say so, route
   `$force-reindex` (it asks consent). Do NOT stall asking the user for the
   `Run:` line first: the message already decides it.

1. `path` from message / argument; absent → cwd. Linked git worktree
   (`git rev-parse --git-common-dir` ≠ `<path>/.git`) of registered repo → do
   NOT register or index; read tools already answer for that tree
   (`tea-rags://guide/freshness`, linked worktree). Tell user.
   `--project <alias>` reindex refreshes main checkout only, never worktree
   edits. Index worktree as own project only if user insists (seeds separate
   project).

2. Registered? `list_projects` → entry with `path` = target AND non-empty `name`
   (recovery auto-created entries have `name=""`).

3. **Not registered → register + index, one command.** Default alias = final
   non-empty path segment, lowercased, non-alphanumeric → `-`, `p-` prefix if
   starts w/ digit. MUST match `^[a-z0-9][a-z0-9_-]{0,63}$`. Example:
   `/Users/me/Dev/Tools/Tea-RAGs MCP` → `tea-rags-mcp`.
   - Ask once: "Index and register this codebase as project `<alias>`?
     (recommended — lets MCP tools address it by name instead of path.)" Offer
     alias override.
   - Confirmed → `tea-rags index-codebase <path> --name <alias>`.
     `[INPUT_PROJECT_NAME_NOT_UNIQUE]` → suggest numeric suffix (`<alias>-2`),
     retry once.
   - Declined → `index_codebase` (`path`); user registers later w/
     `tea-rags projects register --path <path> --name <alias>`.

4. **Registered → incremental reindex.** `index_codebase` w/ `project: <alias>`
   (or `path`). No re-register.

5. Report **full result** (all metrics + duration), + alias when step 3 ran
   `--name`.

## Do NOT

- Spawn subagent — overhead (~10-15s) dwarfs incremental reindex (~1-3s); call
  MCP directly.
- `forceReindex: true` → `$force-reindex`.
- Skip alias prompt on first index — `--name` makes registering free.
- `register_project` on first index — `index-codebase --name` does both.
  `register_project` only re-points existing alias.
- Re-register existing path entry (even empty name). User renames via CLI.
