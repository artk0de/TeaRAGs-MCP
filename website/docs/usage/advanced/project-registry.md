---
title: Project Registry
sidebar_position: 7
---

# Project Registry

TeaRAGs keeps a **per-machine registry** of indexed projects at
`$TEA_RAGS_DATA_DIR/registry.json` (default `~/.tea-rags/registry.json`). The
registry stores two layers in one file:

- **Collection metadata** — auto-populated at the end of every indexing run:
  resolved `collectionName`, indexed path, embedding model and dimensions,
  Qdrant URL, `indexedAt` timestamp, tea-rags version, chunk count.
- **Project name** — an optional, user-controlled short alias. Once registered,
  the name resolves to the project's path and collection so MCP tools and CLI
  commands can reference the project by name instead of by `path` or
  `collection`.

The registry is **the source of truth for project path resolution**. The
fallback chain is:

```
collection > project > path
```

Passing none of the three is an error — the MCP server does not guess from
`cwd` (it has its own working directory unrelated to the client's). The CLI
defaults `--path` to `process.cwd()`.

## File Format

`registry.json` is a single JSON document:

```json
{
  "version": 1,
  "collections": {
    "code_8f42a1b3": {
      "path": "/Users/alice/projects/shop-backend",
      "name": "shop-backend",
      "embeddingModel": "Xenova/all-MiniLM-L6-v2",
      "embeddingDimensions": 384,
      "qdrantUrl": "http://localhost:6333",
      "indexedAt": "2026-05-12T14:21:08.231Z",
      "teaRagsVersion": "0.42.1",
      "chunksCount": 12345
    }
  }
}
```

**Key rules:**

- The entry key is the collection name (`code_<md5>[0..8]`), not the project
  name — see [Collections](./collections).
- `name` is unique across all entries. Attempting to register the same name to
  two projects throws `ProjectNameNotUniqueError`.
- `name` matches the regex `^[a-z0-9][a-z0-9_-]{0,63}$` (lowercase letters,
  digits, `-`, `_`; max 64 chars). Safe to use as a CLI argument and path
  fragment.
- `name` is **sticky** across reindex — re-indexing a project preserves its
  registered name while overwriting all other fields.
- Atomic writes (write to `.tmp.<pid>`, rename) make the file safe for parallel
  tea-rags processes.

Loading a `registry.json` with `version != 1` throws
`RegistryFileCorruptedError`. A missing file is fine — the in-memory map starts
empty and gets written on first `register_project`.

## MCP Tools

### `register_project`

Associate a short alias with an absolute project path.

| Parameter | Type     | Required | Description                                                       |
| --------- | -------- | -------- | ----------------------------------------------------------------- |
| `path`    | `string` | yes      | Absolute path to project root                                     |
| `name`    | `string` | yes      | Short alias, regex `^[a-z0-9][a-z0-9_-]{0,63}$` (max 64 chars) |

**Returns:**

```json
{
  "collectionName": "code_8f42a1b3",
  "alreadyIndexed": true
}
```

- `collectionName` — collection the alias now points at (deterministic from
  `path`).
- `alreadyIndexed` — `true` if the underlying collection already contains
  chunks. `false` for fresh registrations on never-indexed paths.

**Example:**

```json
{
  "path": "/Users/alice/projects/shop-backend",
  "name": "shop-backend"
}
```

**Errors:**

- `ProjectNameInvalidError` — name empty, longer than 64 chars, or fails the
  regex.
- `PathDoesNotExistError` — `path` does not exist on disk.
- `ProjectNameNotUniqueError` — another entry already owns this name.

### `list_projects`

Read-only. Lists every registered project with full collection metadata. No
parameters.

**Returns:**

```json
{
  "projects": [
    {
      "collectionName": "code_8f42a1b3",
      "name": "shop-backend",
      "path": "/Users/alice/projects/shop-backend",
      "embeddingModel": "Xenova/all-MiniLM-L6-v2",
      "embeddingDimensions": 384,
      "qdrantUrl": "http://localhost:6333",
      "indexedAt": "2026-05-12T14:21:08.231Z",
      "teaRagsVersion": "0.42.1",
      "chunksCount": 12345
    }
  ]
}
```

Entries without a registered `name` show `name: null`.

### `unregister_project`

Remove an alias by name. **Idempotent** — returns `removed: false` when the
project was not registered. Does **not** delete the underlying Qdrant
collection or any indexed chunks.

| Parameter | Type     | Required | Description           |
| --------- | -------- | -------- | --------------------- |
| `name`    | `string` | yes      | Project name to remove |

**Returns:**

```json
{ "removed": true }
```

To delete chunks as well, follow with `clear_index` or `delete_collection` on
the collection name returned by `list_projects`.

## The `project` parameter on other tools

Once a project is registered, the alias can be passed as `project` to any
project-aware tool instead of `path` or `collection`. Resolution priority is
strict: `collection > project > path`. Passing several is allowed; the first
non-empty one wins.

```json
{ "project": "shop-backend", "query": "payment retry" }
```

Resolves through the registry to the project's collection and path, then runs
the query exactly as if `path` had been supplied.

If `project` does not exist in the registry the call throws
`ProjectNotRegisteredError`.

## CLI Commands

The same operations are available from the shell, useful in scripts and CI.

### `tea-rags register-project`

```bash
tea-rags register-project --path /Users/alice/projects/shop-backend --name shop-backend
```

Both `--path` and `--name` are required. On success prints
`Registered '<name>' -> <collectionName>` (and `(already indexed)` when the
collection already had chunks).

### `tea-rags list-projects`

```bash
tea-rags list-projects
# (no projects registered)         # when empty
# shop-backend  code_8f42a1b3  /Users/alice/projects/shop-backend
```

Add `--json` for a machine-readable dump of the full registry entries.

### `tea-rags unregister-project`

```bash
tea-rags unregister-project --name shop-backend
# Removed 'shop-backend'
```

Idempotent. Exits 0 with the message `'<name>' was not registered` when the
project is absent.

### `--project` flag on other commands

CLI commands that operate on a project accept `--project <name>` as a shortcut
that resolves `--path`, `--qdrant-url`, and `--model` from the registry entry.
Explicit flags always win — `--project` only fills in what was not passed.

```bash
tea-rags tune --project shop-backend
# resolves --path, --qdrant-url, --model from the registry entry
```

If the project name is not registered the command fails fast with
`Project '<name>' not registered. Available: <list of names>`.

## Storage Location

The registry path follows the same convention as the rest of the per-machine
data:

```
$TEA_RAGS_DATA_DIR/registry.json
```

When `TEA_RAGS_DATA_DIR` is not set it defaults to `~/.tea-rags/`. See
[Configuration Variables → Data Directories](/config/environment-variables#data-directories)
for the full layout (`snapshots/`, `logs/`, `qdrant/`, `registry.json`).

## See Also

- [Collections](./collections) — how `collectionName` is derived from `path`
- [MCP Tools Atlas](./mcp-tools) — every project-aware tool accepts `project`
- [Configuration Variables](/config/environment-variables) — `TEA_RAGS_DATA_DIR`
  and data directory layout
