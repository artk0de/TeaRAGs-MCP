# Step 9: Register Project Alias

Register short alias **before first indexing** → MCP tools + `tea-rags prime`
SessionStart hook address project by name, resolve Qdrant URL / embedding
backend from registry (no path heuristics). Records alias → path only; does NOT
index (`/tea-rags:index` after restart).

## 9a: Resolve the project path

Skill's `[project path]` argument, else cwd. Absolute real path:

```bash
PROJECT_PATH="$(cd "${1:-$PWD}" && pwd -P)"
```

## 9b: Derive the alias

Alias = final non-empty segment of `PROJECT_PATH`, lowercased, chars outside
`[a-z0-9_-]` → `-`, dashes collapsed + trimmed, `p-` prefix if starts w/ digit.
MUST match `^[a-z0-9][a-z0-9_-]{0,63}$`. Example:
`/Users/me/Dev/Tools/Tea-RAGs MCP` → `tea-rags-mcp`.

**Automatic** — do not prompt for alias.

## 9c: Register

Export chosen backend so registry captures right Qdrant URL (CLI reads own env):

- `QDRANT_URL` from progress (step 5) — **omit entirely when embedded** (no
  `QDRANT_URL` key in progress); CLI records embedded daemon URL via discovery.

```bash
QDRANT_URL="<value or unset if embedded>" \
  tea-rags projects register --path "$PROJECT_PATH" --name "<alias>"
```

Report the line it prints (`Registered '<alias>' -> code_xxxxxxxx`).

**`ProjectNameNotUniqueError` / "name not unique"** (other path holds alias) →
retry once w/ numeric suffix (`<alias>-2`). Collides again → report, continue
(non-fatal).

**`tea-rags` CLI not on PATH** (fresh install, shell not re-sourced) → report,
continue; user runs same `tea-rags projects register` after terminal restart.
Never block setup.

## 9d: Mark progress

```bash
$SCRIPTS/progress.sh set steps.register '{"status":"completed","at":"<now>"}'
```
