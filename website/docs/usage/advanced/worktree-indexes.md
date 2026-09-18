---
title: Worktree Indexes
sidebar_position: 8
---

# Worktree Indexes

When you create a `git worktree` to work on a branch, the new checkout has **no
TeaRAGs index** — searching it would mean re-indexing the whole codebase from
scratch, even though the branch differs from the source by only a handful of
files. The `tea-rags worktree` command family solves this: it **clones the
source project's on-disk index** into a new per-worktree collection at near-zero
seeding cost, registered under its own alias. You then index only the live diff.

A worktree collection is an **isolated, independent snapshot** of the source
index that lives alongside it. Reindex it as the branch diverges; remove it when
the branch is done — the source index is never touched.

There are two ways to get such a collection:

- **Automatically**, on the first `index-codebase` / `index_codebase` of the
  worktree path, when another working tree of the same repository is already
  indexed with the same settings — see
  [Automatic Seeding on First Index](#automatic-seeding-on-first-index).
- **Explicitly**, with `tea-rags worktree create`, which also registers an alias
  with worktree provenance and can create the git worktree itself — see
  [Commands](#commands).

:::note Distinct from project registration
A worktree clone is seeded from an **already-indexed** source project. To index
a brand-new, never-indexed project under an alias instead, use
[`index-codebase --name`](/usage/indexing-repositories#register-and-index-in-one-step).
:::

## The Footprint

Every TeaRAGs collection has an on-disk **footprint** — six artifacts under
`$TEA_RAGS_DATA_DIR` (default `~/.tea-rags/`). `worktree create` clones each one
except the indexing lock:

| Artifact          | Location                                              | Clone method                          |
| ----------------- | ---------------------------------------------------- | ------------------------------------- |
| Qdrant vectors    | `qdrant/storage/collections/<col>_vN/`               | snapshot → recover (online, safe)     |
| Codegraph         | `codegraph/<col>.duckdb`                              | file copy (after daemon checkpoint)   |
| File-hash snapshot| `snapshots/<col>/` (sharded)                         | copy shards + rewrite `codebasePath`  |
| Stats cache       | `snapshots/<col>.stats.json`                         | file copy                             |
| Quarantine        | `snapshots/<col>.quarantine.json`                    | file copy                             |
| Indexing lock     | `snapshots/<col>.indexing.lock`                      | never cloned — exists only while an index operation runs |

The indexing lock is how two processes on one machine avoid indexing the same
collection at once. Teardown removes it only when the run that wrote it is dead;
a live run's lock is left in place.

Qdrant uses **snapshot → recover** rather than a cold file copy: the embedded
Qdrant daemon is shared and refcounted, so copying its mmap'd segments while it
has them open would risk inconsistency. Snapshot → recover is the only safe
file-level path that doesn't require restarting the daemon (which would
interrupt parallel worktree sessions).

The clone is **atomic**: artifacts are cloned in order, and the registry entry
is written only after every clone succeeds. If any clone fails, the already-cloned
artifacts are removed in reverse order and the command aborts — no orphaned
state, no half-registered collection.

## Provenance

Worktree collections are marked in the registry with two extra fields so they
are discoverable and removable as a class:

- `worktreeOf` — the source collection's name (e.g. `code_proj`), marking this
  entry as a clone.
- `worktreeName` — the worktree name, used by `worktree remove <name>` to locate
  the entry.

These fields are **additive** — code that reads the registry continues to work
unchanged. `worktree list` filters on `worktreeOf`, and `worktree remove`
refuses any entry that lacks it (you cannot accidentally tear down a real
project through this command).

## Automatic Seeding on First Index

A plain first index of a git worktree reuses a sibling's index without
`worktree create`. When `tea-rags index-codebase` (CLI) or `index_codebase`
(MCP) targets a path that has **no collection yet**, TeaRAGs looks in the
project registry for other working trees of the **same repository** — paths
whose `.git` resolves to the same shared git directory. If one of them passes
every check below, its footprint is cloned onto the new collection and the run
continues as an ordinary incremental index: the working tree is diffed against
the cloned file-hash snapshot, and only added and modified files are embedded.

Candidates are tried newest index first — the same order in which a new
worktree borrows its embedding and tuning config from the registry. A refused
candidate hands over to the next one. When none qualifies, the run is an
ordinary first index.

### When it applies

Seeding is attempted only when all of these hold:

- the path has no collection yet (a first index);
- the run is not `--force` / `forceReindex` and not `--force-enrichments`;
- the run does not pass custom `extensions` or `ignorePatterns` — the sibling
  holds whatever its own runs selected;
- it was not turned off with `--no-worktree-seed` (CLI) or
  `seedFromWorktree: false` (MCP).

### Checks on the sibling

The first five compare what the sibling's index was built with against what
this run would stamp. They are the same stamps
[drift detection](/operations/drift-detection) compares, so a seeded collection
reports no drift that a fresh index would not.

| Check             | Compared                                                                                                   | Refusal reason       |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | -------------------- |
| Qdrant backend    | The sibling's registered backend (embedded, or external URL) against the one this run talks to             | `qdrant-backend`     |
| Embedding model   | Model name; then the stored weights canary against this run's provider                                     | `embedding-model`    |
| Payload keys      | Keys recorded in the sibling's stats cache against this build's payload signals                            | `payload-schema`     |
| Language versions | Per-language code versions of every language the sibling contains, plus the shared `*` axis                | `language-versions`  |
| Index settings    | Env settings that change indexed data: chunking, AST, hybrid, git windows, codegraph and its on/off        | `index-env`          |
| Completed index   | The collection exists, its last index completed, and it has a file-hash snapshot                           | `source-not-indexed` |
| Not busy          | No index run or background enrichment holds the sibling                                                    | `source-busy`        |
| Clone             | The footprint clone succeeded                                                                              | `clone-failed`       |

Runtime settings — endpoints, pool sizes, batch sizes, timeouts — do not take
part: they change how a run executes, not what it writes.

A sibling whose registry entry carries no env stamp at all (an entry written
before tea-rags recorded one) is refused with `index-env`: none of its index
settings can be compared, so the run indexes from scratch instead. Any index
run on that sibling records the stamp and makes it eligible again.

The sibling is claimed for the duration of the clone the same way an index run
claims its own collection (in-process set, the `<collection>.indexing.lock`
file, the Qdrant in-flight markers). A sibling that is being indexed, or whose
background enrichment has not settled, is skipped rather than waited on, and no
index run can start on it while its snapshot is taken.

### What is copied and what is recomputed

| Data                                       | In the seeded collection                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| Vectors and chunk payload, unchanged files | Copied verbatim from the sibling                                                      |
| Added and modified files                   | Chunked and embedded by this run                                                      |
| Files deleted in this worktree             | Removed                                                                               |
| Codegraph database                         | Copied, then repaired for changed files by the incremental run like any incremental   |
| Git signals (`git.*`)                      | Rebuilt for every point from this worktree's history, as background enrichment        |
| Stats cache                                | Copied, then recomputed when the run finishes                                         |
| Quarantine list                            | Copied; quarantined files are retried by the run                                      |
| Language version stamps                    | Recorded as a full index records them                                                 |

Vectors, chunk payload and the codegraph are functions of file content, which
the hash match proves identical. Git signals are not: they are read from the
history reachable from the worktree's own HEAD and depend on the time of
enrichment. The git rebuild runs after the index is searchable; the new
collection stays locked until it finishes, so a second index run on it in that
window is rejected as already in progress. With git enrichment disabled there
is nothing to rebuild.

If the run over a fresh seed fails, the seeded collection is dropped, so the
next attempt starts from a clean slate instead of an unstamped clone.

If the process dies instead — killed during the seeded run, or an MCP server
restarted while the git rebuild was still going — the collection remembers
what it still owes: the version stamps and the git rebuild. The next index run
on it (an ordinary incremental one) finishes both, again with the git rebuild
in the background. A git rebuild that fails is retried the same way.

### Seeded collections are ordinary projects

Automatic seeding writes no worktree provenance. The collection is registered
by the run like any first index — under the alias given with `--name`, or
unnamed — and is not listed by `worktree list`. `worktree remove` refuses it;
remove it with `tea-rags projects unregister --name <alias> --purge` or
`clear_index`.

### The `worktreeSeed` report

A first index reports what happened under `worktreeSeed`: in the
`index-codebase --json` output, as a "Worktree seed" block in the human CLI
status, and as a "Worktree seed:" block at the top of the `index_codebase` MCP
response. The field is absent from incremental, forced and recompute runs.

Seeded:

```json
"worktreeSeed": {
  "status": "seeded",
  "source": { "collectionName": "code_1a2b3c4d", "project": "my-project", "path": "/repo/main" },
  "filesCopied": 1893,
  "filesIndexed": 6,
  "filesRemoved": 1,
  "gitRefresh": "background",
  "rejected": []
}
```

| Field          | Meaning                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `source`       | The sibling the collection was cloned from                                                           |
| `filesCopied`  | Files of the sibling's snapshot kept verbatim (its files minus modified, deleted, newly ignored)     |
| `filesIndexed` | Files embedded by this run (added + modified)                                                        |
| `filesRemoved` | Files present in the sibling only (deleted or newly ignored here)                                    |
| `gitRefresh`   | `background` when git signals are rebuilt after the run; `not-applicable` when git enrichment is off |
| `rejected`     | Newer siblings refused before `source` was accepted, each with `reason` and `detail`                 |

Not seeded:

```json
"worktreeSeed": {
  "status": "skipped",
  "reason": "no-compatible-sibling",
  "rejected": [
    {
      "collectionName": "code_1a2b3c4d",
      "project": "my-project",
      "path": "/repo/main",
      "reason": "language-versions",
      "detail": "typescript.chunking 2 → 3"
    }
  ]
}
```

`reason` is one of `disabled` (opted out), `restricted-run` (custom extensions
or ignore patterns), `no-sibling` (no other working tree of the repository is
registered — the ordinary first index; the CLI and MCP text stay silent about
it) and `no-compatible-sibling` (every candidate was refused; `rejected` says
why).

### Opting out

```bash
tea-rags index-codebase --no-worktree-seed /path/to/worktree
```

```json
{ "path": "/path/to/worktree", "seedFromWorktree": false }
```

Both force an ordinary first index; on any other run they have no effect.

## Commands

All operations live under the `tea-rags worktree` command group. Running
`tea-rags worktree` with no subcommand is equivalent to `tea-rags worktree
list`.

### `tea-rags worktree create`

```bash
tea-rags worktree create <name> [--from <alias>] [--path <dir>] [--branch <b>] [--no-git] [--json]
```

Clones the source index into a new worktree collection and registers it **with
provenance**. By default it also creates the git worktree itself (`git worktree
add`); the clone does **not** reindex — that is a separate, user-gated step.

| Flag         | Default            | Description                                                        |
| ------------ | ------------------ | ----------------------------------------------------------------- |
| `<name>`     | — (required)       | Worktree name. Forms the alias `<source>-worktree-<name>`.        |
| `--from`     | cwd project        | Source project alias to clone from.                               |
| `--path`     | `./<name>`         | Where the git worktree lives on disk.                             |
| `--branch`   | —                  | Git branch to create in the worktree (`git worktree add -b`).     |
| `--no-git`   | git is created     | Skip git-worktree creation; attach the index to an existing dir.  |
| `--json`     | `false`            | Emit the result as JSON instead of human text.                    |

```bash
$ tea-rags worktree create feature-xyz --branch feature-xyz
Created worktree 'tea-rags-worktree-feature-xyz' -> code_a1b2c3d4 at ./feature-xyz
Next: index the live diff with  tea-rags index-codebase --project tea-rags-worktree-feature-xyz
```

The `Next:` hint uses `--project` (not `--name`): `create` already registered
the alias with worktree provenance, so the follow-up reindex must reference the
existing entry rather than register a second, provenance-less one.

With `--json`:

```json
{
  "collectionName": "code_a1b2c3d4",
  "alias": "tea-rags-worktree-feature-xyz",
  "worktreePath": "./feature-xyz",
  "nextStep": "tea-rags index-codebase --project tea-rags-worktree-feature-xyz"
}
```

On failure: `worktree create failed: <reason>` to stderr, exit 1 (the saga has
already rolled back any partial clone).

### `tea-rags worktree list`

```bash
tea-rags worktree list [--json]
```

Lists only worktree-derived collections (entries with `worktreeOf` set) —
real projects are excluded. Tab-separated columns: name, alias,
`<- source`, chunk count.

```bash
$ tea-rags worktree list
feature-xyz   tea-rags-worktree-feature-xyz   <- code_proj   3832 chunks
# No worktree indexes.        # when empty
```

`--json` emits the full entries (including `worktreeOf`, `chunksCount`).

### `tea-rags worktree remove`

```bash
tea-rags worktree remove <name> [--force] [--keep-git] [--json]
```

Tears down a worktree collection: removes the footprint artifacts (best-effort,
reverse order; a live run's indexing lock is left in place), drops the registry
entry, then removes the git worktree directory.

| Flag         | Default               | Description                                                   |
| ------------ | --------------------- | ------------------------------------------------------------ |
| `<name>`     | — (required)          | Worktree name (not the collection or alias).                 |
| `--force`    | `false`               | Remove even with uncommitted changes in the git worktree.    |
| `--keep-git` | git dir is removed    | Keep the git worktree directory; only remove the index.      |
| `--json`     | `false`               | Emit the result as JSON.                                      |

```bash
$ tea-rags worktree remove feature-xyz
Removed worktree 'feature-xyz'.
# 'feature-xyz' was not found.        # when the name is not a worktree clone
```

The provenance guard means a name that resolves to a real project (no
`worktreeOf`) is reported as "not found" rather than destroyed.

### `tea-rags worktree info`

```bash
tea-rags worktree info [--json]
```

Resolves the **current directory** to its registered collection and reports
whether it is a worktree clone.

```json
{ "isWorktree": true, "collectionName": "code_a1b2c3d4", "alias": "tea-rags-worktree-feature-xyz", "worktreeOf": "code_proj", "worktreeName": "feature-xyz", "chunksCount": 3832 }
```

When the directory is a real project (or unregistered), it returns
`{ "isWorktree": false }`.

## Workflow

```bash
# 1. Clone the index + create the git worktree
tea-rags worktree create feature-xyz --branch feature-xyz

# 2. Index the live diff (user-gated — re-embeds only branch changes)
tea-rags index-codebase --project tea-rags-worktree-feature-xyz

# 3. Search the worktree against its own clone — point any MCP search/explore
#    tool at the worktree alias (the agent passes
#    project: tea-rags-worktree-feature-xyz), resolving against the clone, not main.

# 4. Edit, commit — the auto-reindex hook keeps the clone fresh (see below)

# 5. Clean up when the branch is done
tea-rags worktree remove feature-xyz
```

Step 4's freshness is automatic when the TeaRAGs plugin is installed: the
[git-workflow auto-reindex hook](/agent-integration/index-freshness) detects
commits inside the worktree and incrementally reindexes the clone, so search
results track the live branch without manual reindex calls.

## Related

- [Index Freshness & Auto-Reindex](/agent-integration/index-freshness) — the hook
  that keeps worktree clones fresh after commits.
- [Project Registry](./project-registry) — how aliases and provenance are stored.
- [Recovery & Reindexing](/operations/recovery-reindexing) — incremental vs force
  reindex modes.
