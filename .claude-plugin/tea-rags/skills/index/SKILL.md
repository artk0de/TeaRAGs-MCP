---
name: index
description: >-
  Index/reindex codebase: new → alias + index (index-codebase --name); indexed →
  incremental; corrupt → force-reindex. NOT status checks (get_index_status).
argument-hint: [path to codebase]
---

# Index Codebase

Branches (plan names every one that can apply — path unknown, or registration
not yet checked via `list_projects`, = all of them; a digest alias is not a
registration check). Every plan ends with step 5 — report the full result (all
metrics + duration) — even when nothing ran:

- **Linked git worktree** of a registered repo → no register / index; say: "Not
  indexing: read tools (project + path=<worktree>) already answer for this
  tree."
- **Not registered (first index)** → ask once, then register alias + index in
  one SHELL command: `tea-rags index-codebase <path> --name <alias>` — the CLI,
  NOT the MCP tool (`index_codebase` has no `name` param). **Declined** →
  `index_codebase(path=<path>)`, no alias.
- **Already indexed** → incremental `index_codebase(project=<alias>)` (changed
  files only).
- **Corrupt index / payload-schema drift** → `/tea-rags:force-reindex`, never
  incremental.
- **Infra error** (`[QDRANT_UNAVAILABLE]`, `[OLLAMA_UNAVAILABLE]`, embedding /
  connection error from any call) → STOP: read the code + `Hint` (the fix, e.g.
  `docker-compose up` / `ollama serve`), ask the user (`AskUserQuestion`) to
  apply it, WAIT for the explicit answer. Never run the fix unasked, never index
  anyway. After the answer → LIVE `get_index_status` retry. Ollama down ≠
  `find_symbol` / `hybrid_search` BM25 down (`tea-rags://guide/degraded`).

## Instructions

0. **Broken / corrupt index** (user reports wrong, garbage, crooked data, "index
   broke") → stop here, route `/tea-rags:force-reindex` (full rebuild, asks
   confirmation). Incremental re-reads changed files only — corrupt unchanged
   content stays. Never `forceReindex: true` from this skill. Same route for
   schema / payload drift ("payload schema changed", "new fields require reindex
   to populate") with no `Run:` line naming the plain incremental: incremental
   never populates new fields in unchanged files — say so, route
   `/tea-rags:force-reindex` (it asks consent). Do NOT stall asking the user for
   the `Run:` line first: the message already decides it.

1. `path` from message / argument; absent → cwd. Linked git worktree
   (`git rev-parse --git-common-dir` ≠ `<path>/.git`) of registered repo → do
   NOT register or index — the plan has NO `index_codebase` step, not even a
   planned one, and this check runs BEFORE any next-call line; read tools
   already answer for that tree (`tea-rags://guide/freshness`, linked worktree).
   Say literally: "Not indexing: read tools (project + path=<worktree>) already
   answer for this tree." `--project <alias>` reindex refreshes main checkout
   only, never worktree edits. Index worktree as own project only if user
   insists (seeds separate project).

2. Registered? `mcp__tea-rags__list_projects` → entry with `path` = target AND
   non-empty `name` (recovery auto-created entries have `name=""`). Default rows
   are compact (alias, path, counts, `worktreeOf`) — enough for this check;
   `list_projects(project: "<alias>")` returns that one full record.

3. **Not registered → register + index, one command.** Default alias = final
   non-empty path segment, lowercased, non-alphanumeric → `-`, `p-` prefix if
   starts w/ digit. MUST match `^[a-z0-9][a-z0-9_-]{0,63}$`. Example:
   `/Users/me/Dev/Tools/Tea-RAGs MCP` → `tea-rags-mcp`.
   - Ask once: "Index and register this codebase as project `<alias>`?
     (recommended — lets MCP tools address it by name instead of path.)" Offer
     alias override.
   - Confirmed → shell `tea-rags index-codebase <path> --name <alias>` (CLI;
     never `index_codebase(name=…)`). `[INPUT_PROJECT_NAME_NOT_UNIQUE]` →
     suggest numeric suffix (`<alias>-2`), retry once.
   - Declined → `mcp__tea-rags__index_codebase` (`path`); user registers later
     w/ `tea-rags projects register --path <path> --name <alias>`.

4. **Registered → incremental reindex.** `mcp__tea-rags__index_codebase` w/
   `project: <alias>` (or `path`). No re-register.

5. Report **full result** (all metrics + duration), + alias when step 3 ran
   `--name`.

## Do NOT

- Spawn subagent — overhead (~10-15s) dwarfs incremental reindex (~1-3s); call
  MCP directly.
- `forceReindex: true` → `/tea-rags:force-reindex`.
- Skip alias prompt on first index — `--name` makes registering free.
- `mcp__tea-rags__register_project` on first index — `index-codebase --name`
  does both. `register_project` only re-points existing alias.
- Re-register existing path entry (even empty name). User renames via CLI.
