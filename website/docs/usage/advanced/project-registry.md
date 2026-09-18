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

### `tea-rags project exist`

A **scriptable membership check** — answers "is this path or alias a registered
project?" via the exit code, with no human-formatted output by default. Note the
**singular** `project` (this query command) versus the plural `projects` command
group above.

```bash
tea-rags project exist --path /path/to/repo     # exit 0 = registered, 1 = not
tea-rags project exist --name shop-backend       # check by alias instead
tea-rags project exist --path /path/to/repo --print-name   # also print the alias on match
tea-rags project exist --path /path/to/repo --json         # {"exists":true,"name":"shop-backend"}
```

Exactly one of `--path` or `--name` is required. The command is built for hooks
and CI: the [auto-reindex hook](/agent-integration/index-freshness) uses
`tea-rags project exist --path <dir> --print-name` to resolve a commit directory
to its collection (and to skip directories that are not registered projects).

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

Pass `--purge` to also delete everything the collection owns on disk:

```bash
tea-rags projects unregister --name shop-backend --purge
# Removed 'shop-backend' from registry; deleted Qdrant collection 'code_8f42a1b3' (3832 chunks)
#   qdrant:    code_8f42a1b3_v1, code_8f42a1b3_v2
#   codegraph: code_8f42a1b3_v1, code_8f42a1b3_v2
#   cleared:   quarantine, snapshot, stats
#   kept:      project directory /src/shop-backend — the source tree is never touched
```

The name in the registry is an **alias**, and most of a project's state is
addressed by the versioned `code_<hash>_vN` name behind it. `--purge` resolves
both, so it removes:

| Artifact                                       | Where it lives                                |
| ---------------------------------------------- | --------------------------------------------- |
| Every Qdrant generation `code_<hash>_vN`       | Qdrant                                        |
| The alias itself                               | Qdrant                                        |
| Every codegraph database (plus `.wal` sidecar) | `~/.tea-rags/codegraph/<collection>_vN.duckdb` |
| The file-hash snapshot directory               | `~/.tea-rags/snapshots/<collection>/`         |
| The collection stats cache                     | `~/.tea-rags/snapshots/<collection>.stats.json` |
| The poison-pill quarantine file                | `~/.tea-rags/snapshots/<collection>.quarantine.json` |

A codegraph database whose Qdrant collection is already gone is reclaimed too —
those are the files that otherwise accumulate forever after an interrupted
force reindex.

Anything under `kept:` is left alone deliberately: the project directory, any
worktree clone derived from this project (each owns its own footprint, so remove
it with `tea-rags worktree remove <name>`), and the shared codegraph daemon,
which is never shut down because other projects may be using it.

Every step is best-effort. If one fails — server unreachable, a file held open —
the registry entry is **still removed**, the rest of the sweep still runs, and
the report names what survived so it can be retried:

```
Removed 'shop-backend' from registry; failed to delete Qdrant collection 'code_8f42a1b3_v2': <reason>
  qdrant:    code_8f42a1b3_v1
  cleared:   quarantine, snapshot, stats
  failed:    qdrant code_8f42a1b3_v2 — <reason>
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
| `Registry`    | Count of registered projects. A `[WARN]` line follows per finding: entries whose directory is gone ([`projects prune`](#tea-rags-projects-prune)), and orphan collections (defined below). |

Add `--json` for a machine-readable dump:

```json
{
  "qdrant":     { "url": "http://127.0.0.1:6333", "reachable": true },
  "embeddings": { "provider": "ollama", "url": "http://127.0.0.1:11434", "reachable": true },
  "registry":   { "projectCount": 3, "orphanCount": 2, "staleCount": 1 }
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

### `tea-rags doctor --sweep-workers`

`tea-rags index-codebase` hands the actual indexing to a detached worker
process. When the foreground CLI is killed before it hands the worker off, the
worker normally notices and exits with its children. A worker that did not —
one from an older build, or one wedged past reacting — keeps holding the
collection, and every later run on it is refused with
`INGEST_INDEXING_IN_PROGRESS`. This flag finds and stops such workers.

```bash
tea-rags doctor --sweep-workers
# [KILL] pid 51136 orphaned — supervisor 51120 died before handing it off; stopped · /Users/me/project
# [WARN] pid 48211 stalled — no progress for 42m; re-run with --include-stalled to stop it · /Users/me/other
# [OK]   pid 47001 gone — stale record removed
# Swept 3 worker record(s): 1 stopped, 1 stale record(s) removed.
```

Each worker registers itself under `~/.tea-rags/workers/` while it runs. The
sweep stops a process only when it can prove the pid is still that worker —
its command line is an `index-codebase` worker that started when the record
says — and its CLI is gone. A pid now held by some other process only loses
its stale record; it is never signalled. Stopping sends `SIGTERM`, then
`SIGKILL`, to the worker's own process group, which holds its `git` and
chunker children and none of the shared daemons.

| Verdict    | Meaning                                                                | Action                              |
| ---------- | ---------------------------------------------------------------------- | ----------------------------------- |
| `attached` | Its CLI is still running.                                              | Kept                                |
| `detached` | Handed off to finish enrichment in the background, still progressing. | Kept                                |
| `orphaned` | Its CLI died before handing it off.                                    | Stopped                             |
| `stalled`  | Handed off, but no progress for 30 minutes.                            | Kept; stopped with `--include-stalled` |
| `unverified` | An `index-codebase` worker holds the pid, but `ps` gave a start time the sweep could not read, so it cannot prove this is the worker that registered. | Kept, record and process |
| `gone`     | No such worker any more.                                               | Record removed                      |

`--include-stalled` is opt-in because a long daemon-side phase (cycles and
PageRank on a large graph) reports no progress either. `--dry-run` reports
what would be stopped without stopping or removing anything, and `--json`
emits one entry per worker. Not available on Windows. `npm run build` runs the
same sweep, limited to orphaned workers of the checkout it rebuilds.

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

### `tea-rags projects prune`

The inverse of `orphans`: registry entries whose project directory is gone
from disk. They accumulate on their own — a removed worktree, a deleted test
fixture, a checkout moved to another machine — and each one may still own a
Qdrant collection and a codegraph database.

By default the command is a **dry run**. It prints one line per stale entry
(`<collectionName>\t<alias>\t<path>\t<chunks>\t<what happens to it>`) and
changes nothing:

```bash
tea-rags projects prune
# code_a1b2c3d4    (no alias)    /tmp/fixture-42          1234    would remove
# code_55667788    moved         /old/worktree              57    kept — re-register the alias at its new path, or run 'tea-rags projects unregister --name moved --purge'
# Dry run — nothing removed. Re-run 'tea-rags projects prune --purge' to remove 1 prunable entry and the Qdrant/codegraph footprint behind it.
```

**A NAMED stale entry is never removed.** `register` re-points an alias at its
new path the moment the alias is registered there, and the index behind it
survives the move — so removing it would be the destructive answer to a
recoverable situation. Only entries that never got an alias are swept: nothing
addresses them again. Each kept entry prints the route back:

| Kept entry        | Hint                                                                |
| ----------------- | ------------------------------------------------------------------- |
| Plain alias       | re-register it at the new path, or `projects unregister --purge` it |
| Worktree clone    | `tea-rags worktree remove <worktreeName> --force`                   |

The worktree clone gets its own route because `worktree remove` also drops the
git worktree admin entry in the source repo, which `unregister --purge` would
leave dangling.

`--purge` acts. For each prunable entry it tears down the **whole footprint
first** — every Qdrant generation, every codegraph DuckDB generation, the
snapshot, the stats cache, the quarantine file — and removes the registry entry
only when that came back clean:

```bash
tea-rags projects prune --purge
# code_a1b2c3d4    (no alias)    /tmp/fixture-42     1234    removed
# code_99887766    (no alias)    /tmp/fixture-43       88    kept — purge failed: qdrant code_99887766 — ECONNREFUSED
# code_55667788    moved         /old/worktree         57    kept — re-register the alias at its new path, or run 'tea-rags projects unregister --name moved --purge'
# Removed 1 · kept 2 (1 purge failed)
```

A failed purge leaves the registry entry in place, because the entry is what
names the collection for the retry. One entry's failure never aborts the rest
of the sweep, and the command exits 0 either way — a stale entry is a finding,
not an error. When every attempted purge failed, the summary says so, which is
the usual shape of "Qdrant is not running".

`--json` works in both modes and emits `{ stale, removed, kept }`. Every entry
carries `prunable`, the verdict on whether the sweep may take it, so a script
never has to re-derive the rule:

```json
{
  "stale": [
    {
      "collectionName": "code_a1b2c3d4",
      "name": null,
      "path": "/tmp/fixture-42",
      "chunksCount": 1234,
      "indexedAt": "2026-09-01T00:00:00.000Z",
      "prunable": true
    }
  ],
  "removed": [],
  "kept": []
}
```

A dry run decides nothing, so it reports nothing as removed or kept — the
`prunable` flag is the preview. Under `--purge`, `removed` holds what went and
`kept` holds what stayed (named entries plus anything whose purge failed).

`tea-rags doctor` counts stale entries and points here:

```text
[WARN] Registry: 2 stale (missing directory) → tea-rags projects prune
```

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
