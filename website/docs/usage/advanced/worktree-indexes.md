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

:::note Distinct from project registration
A worktree clone is seeded from an **already-indexed** source project. To index
a brand-new, never-indexed project under an alias instead, use
[`index-codebase --name`](/usage/indexing-repositories#register-and-index-in-one-step).
:::

## The Footprint

Every TeaRAGs collection has an on-disk **footprint** — five artifacts under
`$TEA_RAGS_DATA_DIR` (default `~/.tea-rags/`). `worktree create` clones each one:

| Artifact          | Location                                              | Clone method                          |
| ----------------- | ---------------------------------------------------- | ------------------------------------- |
| Qdrant vectors    | `qdrant/storage/collections/<col>_vN/`               | snapshot → recover (online, safe)     |
| Codegraph         | `codegraph/<col>.duckdb`                              | file copy (after daemon checkpoint)   |
| File-hash snapshot| `snapshots/<col>/` (sharded)                         | copy shards + rewrite `codebasePath`  |
| Stats cache       | `snapshots/<col>.stats.json`                         | file copy                             |
| Quarantine        | `snapshots/<col>.quarantine.json`                    | file copy                             |

Qdrant uses **snapshot → recover** rather than a cold file copy: the embedded
Qdrant daemon is shared and refcounted, so copying its mmap'd segments while it
has them open would risk inconsistency. Snapshot → recover is the only safe
file-level path that doesn't require restarting the daemon (which would
interrupt parallel worktree sessions).

The clone is **atomic**: artifacts are cloned in order, and the registry entry
is written only after all five succeed. If any clone fails, the already-cloned
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

Tears down a worktree collection: removes all five footprint artifacts
(best-effort, reverse order), drops the registry entry, then removes the git
worktree directory.

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
