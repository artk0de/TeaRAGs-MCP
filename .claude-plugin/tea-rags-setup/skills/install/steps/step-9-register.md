# Step 9: Register Project Alias

Register the project under a short alias **before the first indexing** so that
MCP tools (and the `tea-rags prime` SessionStart hook) can address it by name and
resolve its Qdrant URL / embedding backend from the registry instead of relying
on path heuristics. Registration records the alias → path mapping only — it does
NOT index (indexing stays `/tea-rags:index` after restart).

## 9a: Resolve the project path

Use the skill's `[project path]` argument if given, otherwise the current working
directory. Resolve to an absolute, real path:

```bash
PROJECT_PATH="$(cd "${1:-$PWD}" && pwd -P)"
```

## 9b: Derive the alias

Default alias = the final non-empty segment of `PROJECT_PATH`, lowercased, with
every character outside `[a-z0-9_-]` replaced by `-`, collapsed dashes trimmed,
and prefixed with `p-` if it would otherwise start with a digit. The regex
`^[a-z0-9][a-z0-9_-]{0,63}$` MUST match. Example:
`/Users/me/Dev/Tools/Tea-RAGs MCP` → `tea-rags-mcp`.

This is **automatic** — do not prompt for the alias.

## 9c: Register

Export the backend chosen earlier so the registry captures the correct Qdrant
URL (the CLI reads it from its own environment):

- `QDRANT_URL` from progress (step 5) — **omit entirely when Qdrant is embedded**
  (no `QDRANT_URL` key in progress); the CLI then records the embedded daemon's
  URL via discovery.

```bash
QDRANT_URL="<value or unset if embedded>" \
  tea-rags projects register --path "$PROJECT_PATH" --name "<alias>"
```

Report the line it prints (`Registered '<alias>' -> code_xxxxxxxx`).

**On `ProjectNameNotUniqueError` / "name not unique"** (a different path already
holds the alias): retry once with a numeric suffix (`<alias>-2`). If that also
collides, report it and continue — registration is non-fatal for setup.

**If the `tea-rags` CLI is not yet on PATH** (fresh install, shell not re-sourced):
report it and continue — the user can run the same `tea-rags projects register`
command after restarting the terminal. Do not block setup completion.

## 9d: Mark progress

```bash
$SCRIPTS/progress.sh set steps.register '{"status":"completed","at":"<now>"}'
```
