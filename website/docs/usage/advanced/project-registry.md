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
- Writes are atomic (write to `.tmp.<pid>`, then rename) AND protected by a
  compare-and-swap (CAS) retry loop — 5 attempts with exponential backoff
  (10ms → 160ms). The CAS read-modify-write protects parallel tea-rags
  processes from clobbering each other's entries; exhausting the budget
  throws `RegistryConcurrencyError` (`INFRA_REGISTRY_CONCURRENCY`).
- The long-lived MCP server installs a directory-level `fs.watch` on
  `$TEA_RAGS_DATA_DIR` so external writes (an indexing run from a parallel
  CLI process, `tea-rags projects register` from a shell, `tea-rags doctor
  --recover-registry`) invalidate the in-memory cache without an MCP
  reconnect.

### Loading and migrations

`loadRegistryFile` reads `registry.json` through a small migration framework:

- A missing file is fine — the in-memory map starts empty and gets written
  on first `register_project`.
- For `version: 1` (current), the file is loaded as-is.
- For older `version` values, the file is passed through
  `KNOWN_MIGRATIONS[version]` if a transformer is registered. The reserved
  framework is in place; no migrations are registered yet because v1 is the
  initial schema.
- Any other case (JSON parse failure, malformed shape, unsupported version)
  is treated as **corruption**: the bad file is renamed to
  `registry.json.corrupt-<ISO>.bak` so it is recoverable by hand, and
  `RegistryFileCorruptedError` (`INFRA_REGISTRY_FILE_CORRUPTED`) is thrown.
  The next boot sees no file and starts with an empty map; in this state
  `tea-rags doctor --recover-registry` can repopulate stubs directly from
  Qdrant (see [Doctor and Recovery](#doctor-and-recovery)).

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

**Errors** (all mapped to HTTP 400 — `InputValidationError` subclasses):

- `ProjectNameInvalidError` (`INPUT_PROJECT_NAME_INVALID`) — name empty,
  longer than 64 chars, or fails the regex.
- `PathDoesNotExistError` (`INPUT_PATH_NOT_EXISTS`) — `path` does not exist
  on disk.
- `ProjectNameNotUniqueError` (`INPUT_PROJECT_NAME_NOT_UNIQUE`) — another
  entry already owns this name. The infra layer raises
  `RegistryNameConflictError` (`INFRA_REGISTRY_NAME_CONFLICT`) as a
  defensive backstop if a caller bypasses the api-layer pre-check.

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

| Parameter | Type     | Required | Description            |
| --------- | -------- | -------- | ---------------------- |
| `name`    | `string` | yes      | Project name to remove |

**Returns:**

```json
{ "removed": true }
```

The MCP `unregister_project` tool has **no** `purge` parameter — destructive
removal of the Qdrant collection is exposed only via the CLI
(`tea-rags projects unregister --name <alias> --purge`, see
[CLI Commands](#cli-commands)). From an MCP client, follow `unregister_project`
with `clear_index` or `delete_collection` to remove the chunks.

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
`ProjectNotRegisteredError` (`INPUT_PROJECT_NOT_REGISTERED`). If the entry
exists but its `path` is an empty string — the shape produced by
`tea-rags doctor --recover-registry` for a Qdrant collection that has no
matching directory yet — the call throws `ProjectPathMissingError`
(`INPUT_PROJECT_PATH_MISSING`), with a hint telling the user to run
`tea-rags projects register --path <dir> --name <alias>` to fill the path
back in.

:::note Long-lived MCP sessions
The MCP server watches `$TEA_RAGS_DATA_DIR` with `fs.watch` at the
directory level, so registry changes made by external CLI invocations
(`tea-rags projects register`, `tea-rags projects unregister`,
`tea-rags doctor --recover-registry`) become visible to in-flight tool
calls without an MCP reconnect. The directory-level watch survives the
atomic `.tmp.<pid>` -> rename cycle that a file-level watch would miss.
:::

## CLI Commands

The same operations are available from the shell, useful in scripts and CI.

All project-registry operations live under the `tea-rags projects` command
group. Running `tea-rags projects` with no subcommand is equivalent to
`tea-rags projects list`.

### `tea-rags projects register`

```bash
tea-rags projects register --path /Users/alice/projects/shop-backend --name shop-backend
```

Both `--path` and `--name` are required. On success prints
`Registered '<name>' -> <collectionName>` (and `(already indexed)` when the
collection already had chunks).

### `tea-rags projects list`

```bash
tea-rags projects list
# (no projects registered)         # when empty
# shop-backend  code_8f42a1b3  /Users/alice/projects/shop-backend
```

Add `--json` for a machine-readable dump of the full registry entries. `tea-rags
projects` (no subcommand) is an alias for `tea-rags projects list`.

### `tea-rags projects info`

```bash
tea-rags projects info --name shop-backend
# name:                shop-backend
# collectionName:      code_8f42a1b3
# path:                /Users/alice/projects/shop-backend
# qdrantUrl:           http://127.0.0.1:6333
# embeddingModel:      unclemusclez/jina-embeddings-v2-base-code:latest
# embeddingDimensions: 768
# chunksCount:         3832
# indexedAt:           2026-05-13T01:15:45.019Z
# teaRagsVersion:      1.24.0
```

Add `--json` for a machine-readable single-entry dump. Exits 1 with
`'<name>' was not registered` on stderr when the name is unknown.

**Realpath divergence and missing paths.** `projects info` calls
`realpathSync(entry.path)` and renders the result on a dedicated line when
the live filesystem disagrees with the stored value:

| Situation                                                    | Text-mode output                                                                                     | JSON output                                              |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Stored `path` resolves to itself                             | (no `realpath` line)                                                                                 | no `realpath` field                                      |
| Stored `path` resolves to a different absolute path (symlink retargeted, mount moved) | `realpath:` line with the resolved path plus a hint to re-register | `realpath` field set to the resolved path                |
| Stored `path` is gone from disk entirely                     | `realpath:            (missing on disk)`                                                             | no `realpath` field (sentinel is render-only)            |

When `indexedAt` is missing (e.g. a recovered registry stub from
`tea-rags doctor --recover-registry` where Qdrant had no indexing marker),
text mode renders `(never)`. The earlier behaviour of synthesising
`indexedAt = new Date()` during enrichment has been removed — an empty
field stays empty.

### `tea-rags projects unregister`

```bash
tea-rags projects unregister --name shop-backend
# Removed 'shop-backend' from registry. Note: Qdrant collection 'code_8f42a1b3' is still present.
# Run 'tea-rags projects unregister --name shop-backend --purge' to remove it.
```

Idempotent. Exits 0 with the message `'<name>' was not registered` when the
project is absent. By default it touches only the registry — the underlying
Qdrant collection (and its indexed chunks) is preserved, and the message
above tells the user how to remove it.

Pass `--purge` to also delete the Qdrant collection in one step:

```bash
tea-rags projects unregister --name shop-backend --purge
# Removed 'shop-backend' from registry; deleted Qdrant collection 'code_8f42a1b3' (3832 chunks)
```

If the Qdrant `deleteCollection` call fails (server unreachable, alias in
use), the registry entry is **still removed**, but the message reports the
delete failure so the user can retry with `delete_collection`:

```
Removed 'shop-backend' from registry; failed to delete Qdrant collection 'code_8f42a1b3': <reason>
```

For non-destructive inspection of Qdrant collections that no longer have a
registry entry, see [Doctor and Recovery](#doctor-and-recovery).

### `--project` flag on other commands

CLI commands that operate on a project accept `--project <name>` as a shortcut
that resolves `--path`, `--qdrant-url`, and `--model` from the registry entry.
Explicit flags always win — `--project` only fills in what was not passed.

```bash
tea-rags tune --project shop-backend
# resolves --path, --qdrant-url, --model from the registry entry
```

Resolution is performed by `applyProjectDefaults`, which throws typed
`InputValidationError` subclasses (it does not call `process.exit` itself —
the CLI command wraps the call and prints `message + Hint` to stderr):

- `ProjectNotRegisteredError` (`INPUT_PROJECT_NOT_REGISTERED`) — the alias
  is unknown. Stderr lists the available aliases (or `(none)`).
- `ProjectPathMissingError` (`INPUT_PROJECT_PATH_MISSING`) — the alias
  exists but its `path` is empty (recovered stub). The hint tells the user
  to run `tea-rags projects register --path <dir> --name <alias>`.

Empty-string `embeddingModel` / `qdrantUrl` values on a recovered stub are
coerced to `undefined` before nullish-coalesce, so downstream commands fall
through to their own defaults instead of being poisoned with `""`.

### Shell completion

`tea-rags` ships with tab-completion that suggests registered project aliases
for `--project <TAB>`, `tea-rags projects info --name <TAB>`, and
`tea-rags projects unregister --name <TAB>`. The `register` subcommand
deliberately does NOT complete `--name` — there the value is a new alias the
user is inventing.

| Shell | Install |
| ----- | ------- |
| **fish** | Auto-installed by `postinstall` when fish is detected on `PATH`. Re-runs on every package update. Manual cleanup: `rm ~/.config/fish/completions/tea-rags.fish` |
| **bash** | `tea-rags completion >> ~/.bashrc` (one-time) |
| **zsh** | `tea-rags completion >> ~/.zshrc` (one-time) |

For bash/zsh, `source` the rc file (or open a new shell) after installing.
Fish auto-discovers completions from `~/.config/fish/completions/` — no rc
edit needed.

After indexing and registering a project, `--project ` followed by TAB will
autocomplete with the alias names from `~/.tea-rags/registry.json`.

## Doctor and Recovery

The `tea-rags doctor` command is a read-only health summary plus an
opt-in recovery path that rebuilds the registry from live Qdrant state. It
is a CLI-only command — there is no MCP equivalent, by design (destructive
or repair operations should never be one MCP call away).

### `tea-rags doctor`

```bash
tea-rags doctor
# [OK]   Qdrant: http://127.0.0.1:6333
# [OK]   Embeddings (ollama): http://127.0.0.1:11434
# [OK]   Registry: 3 project(s)
# [WARN] Registry: 2 orphan collection(s) — run 'tea-rags doctor --recover-registry' or 'tea-rags projects orphans' to inspect
```

The summary lines are:

| Line          | Meaning                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Qdrant`      | URL the same bootstrap path as the MCP server resolves to (embedded daemon socket or `QDRANT_URL`). `[OK]` / `[FAIL]` reflects the `checkHealth` probe.                |
| `Embeddings`  | Provider name (`ollama`, `onnx`, `openai`, ...), base URL where applicable, and reachability via the provider's own `checkHealth`.                                     |
| `Registry`    | Count of registered projects. A second `[WARN]` line appears when Qdrant has collections without a registry entry — see "orphan collection" definition below.          |

Add `--json` for a machine-readable dump:

```json
{
  "qdrant":     { "url": "http://127.0.0.1:6333", "reachable": true },
  "embeddings": { "provider": "ollama", "url": "http://127.0.0.1:11434", "reachable": true },
  "registry":   { "projectCount": 3, "orphanCount": 2 }
}
```

The `[FAIL]` lines never crash doctor — the command is read-only and a
failed probe is a legitimate finding. Doctor never spawns the embedded
Qdrant daemon (connection refused is a real symptom worth reporting).

### `tea-rags doctor --recover-registry`

When the registry has been wiped, corrupted, or you've moved
`registry.json` between machines, this flag repopulates entries from live
Qdrant state. Doctor calls `ProjectRegistryOps.recoverFromQdrant`, which
walks `listCollections()` and inserts a registry entry for every Qdrant
collection that does not already have one.

```bash
tea-rags doctor --recover-registry
# [OK]   Qdrant: http://127.0.0.1:6333
# [OK]   Embeddings (ollama): http://127.0.0.1:11434
# [OK]   Registry: 5 project(s)
# [OK]   Recovered 2 entry/entries from Qdrant; paths are empty — re-register them with 'tea-rags projects register --path <dir> --name <alias>' to enable alias resolution.
```

**Recovered entries have `path: ""`.** Qdrant stores the collection name,
the chunk count, and the indexing metadata, but it does not store the
original filesystem path. Recovered stubs are fully usable for direct
`collection` operations (`semantic_search` with `collection: code_…`), but
attempting to use them as an `--project <alias>` shortcut throws
`ProjectPathMissingError` until the user re-registers with the real path.

The recovered set is also visible in the JSON output as a `recovery`
field, useful for scripts:

```json
{
  ...,
  "recovery": { "recovered": 2 }
}
```

### `tea-rags projects orphans`

Read-only listing of Qdrant collections that have no registry entry. This
is the inspection counterpart to `doctor --recover-registry`:

```bash
tea-rags projects orphans
# code_a1b2c3d4    4218
# code_55667788     931
```

Each line is `<collectionName>\t<chunkCount>`. Add `--json` for a
machine-readable list of `{ collectionName, chunksCount }` records.

**Alias-aware.** Qdrant's zero-downtime reindex builds versioned physical
collections (e.g. `code_8b243ffe_v2`) that are pointed to by an alias
(`code_8b243ffe`). The orphan listing subtracts the alias targets from
`listCollections()` so a live backing collection never appears as orphan
data the user might be tempted to delete. The same filter is applied to
the `orphanCount` reported by `tea-rags doctor` — the two views agree.

### `tea-rags projects unregister --purge`

Documented in detail under [CLI Commands → projects
unregister](#tea-rags-projects-unregister); included here for the
recovery checklist. Combined with `tea-rags projects orphans` it gives a
two-step "find then remove" workflow for collections that should not
exist any more.

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
