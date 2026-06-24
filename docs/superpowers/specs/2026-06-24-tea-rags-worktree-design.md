# tea-rags worktree — Design Spec

Date: 2026-06-24 Status: Approved (brainstorming) Scope class: sub-epic
(substrate exists)

## 1. Motivation

When a developer (or agent) spins up a git worktree to work on a branch, the
indexed code in that worktree differs from `main` only by the branch diff plus
uncommitted edits. Re-indexing the whole worktree from scratch re-embeds
thousands of unchanged files — wasteful, slow, and dependent on a flapping
embedding backend.

`tea-rags worktree` seeds a new per-worktree collection by **cloning the entire
on-disk footprint** of the source project's index (Qdrant vectors + codegraph
DuckDB + file-hash snapshot + stats), registering it under a dedicated alias,
then running an **incremental reindex that only touches the diff**. The agent
then searches live worktree code at near-zero seeding cost.

The command family is modeled on `bd worktree` — full lifecycle management
(`create` / `list` / `remove` / `info`), so worktree indexes are _manageable_,
not orphaned side-effects.

## 2. Command Surface (mirrors `bd worktree`)

```text
tea-rags worktree create <name> [--from <project>] [--branch <b>] [--path <dir>] [--no-git] [--json]
tea-rags worktree list   [--json]
tea-rags worktree remove <name> [--force] [--keep-git] [--json]
tea-rags worktree info   [--json]
```

- `create` — create the git worktree (idempotent: attach if it already exists),
  clone the source footprint, register alias `<project>-worktree-<name>`, run a
  diff reindex.
- `list` — all worktree-derived collections (registry entries carrying a
  `worktreeOf` provenance marker).
- `remove` — tear down the worktree collection's full footprint + registry
  entry; optionally remove the git worktree (safety-checked, like `bd`).
- `info` — resolve cwd to its registry entry; if it is a worktree clone, show
  source / provenance / diff status.

### Sub-decision (approved)

`create` **creates the git worktree itself** (like `bd worktree create`), but is
idempotent — if the target path is already a worktree (created by the harness
EnterWorktree or `bd`), it skips git creation and only attaches the index.
`--no-git` forces attach-only against an existing directory.

## 3. Architecture & Layering

Dependency direction is strictly inward-to-outward; the new code lives in a new
domain, **not** in `infra/` (footprint is a _consumer_ of adapters/infra, not a
foundation depended upon by them — putting it in `infra/` would invert the
dependency graph).

```text
src/cli/worktree/{create,list,remove,info,index}.ts   ← thin: flag parsing → App
api/public/app.ts                                      ← createWorktree/listWorktrees/removeWorktree/worktreeInfo
domains/maintenance/                                   ← NEW bounded context: operating the instance & its on-disk indexes
  ├── footprint/    ← SHARED KERNEL: CollectionArtifact + impls + CollectionFootprintFactory
  │                   (clone → used by worktree; verify → used by doctor)
  ├── worktree/     ← WorktreeOps: footprint.clone + git worktree + registry provenance + reindex (saga)
  └── doctor/       ← (FOLLOW-UP, out of primary scope) relocate doctor, verify footprint integrity
adapters/qdrant | adapters/duckdb | infra/registry | ingest/sync/snapshot | infra/stats-cache
                                                       ← ARTIFACT OWNERS (each owns its own clone/remove)
```

Rationale for `domains/maintenance`: it is orthogonal to `explore` / `ingest` /
`trajectory` (those _are_ the search/index pipeline). `maintenance` operates _on
the installation_ — collection footprints and instance health. `doctor` and
`worktree` share a kernel: the **footprint model**. `worktree` clones it,
`doctor` verifies its integrity ("does every registered collection have all its
on-disk artifacts?"). Not incidental co-location — one shared kernel.

## 4. On-disk Footprint (what gets cloned)

| Artifact           | Path                                                   | Clone mechanism                                                    |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------ |
| Qdrant vectors     | `~/.tea-rags/qdrant/storage/collections/<col>_vN/`     | **snapshot → recover (online)** — see §6                           |
| Codegraph graph    | `~/.tea-rags/codegraph/<col>.duckdb`                   | `fs.copyFile` (wait for daemon idle / checkpoint; bounded backoff) |
| File-hash snapshot | `~/.tea-rags/snapshots/<col>/{meta,shard-00..03}.json` | copy shards + rewrite `meta.codebasePath` → worktree path          |
| Stats cache        | `~/.tea-rags/snapshots/<col>.stats.json`               | `fs.copyFile`                                                      |
| Quarantine         | `~/.tea-rags/snapshots/<col>.quarantine.json`          | `fs.copyFile`                                                      |
| Registry entry     | `~/.tea-rags/registry.json`                            | new record + alias + provenance marker (the commit point, §5)      |

Target collection name is derived deterministically from the worktree absolute
path: `code_<md5(worktreeAbsPath)[:8]>` — no collision with the source by
construction (different path → different hash).

## 5. Control Flow

### `create` — saga with compensating rollback

```text
create(name, opts):
  src    = resolveSource(opts.from ?? registry.findByPath(cwd))   // PRE: source is indexed
  target = deriveTarget(name, worktreeAbsPath)                    // PRE: target collection ∄
  ensureGitWorktree(name, opts)                                   // unless --no-git / already a worktree (idempotent)
  footprint = footprintFactory.build(src, target)
  done = []
  try:
    for a in footprint.artifacts:        // ordered
      await a.clone(ctx); done.push(a)
    registry.record(targetEntry{ worktreeOf: src.logical, worktreeName: name, ... })   // ← COMMIT POINT
  catch e:
    for a in reverse(done): await a.remove(ctx)   // compensating rollback
    throw
  await reindexPipeline.reindexChanges(target)    // diff; FAILURE = warning, NOT rollback
```

The registry record is the commit point. The diff reindex runs **after** commit:
a seeded index is already valid and searchable, so a reindex failure leaves a
usable (if slightly stale) clone the user can re-diff later — it must not
trigger rollback of a successful clone.

The copied file-hash snapshot reflects the source's last-indexed state. The
worktree's disk files therefore diff against that baseline to exactly the branch
changes + uncommitted edits — which is precisely the live-code delta to reindex.

### `remove`

```text
remove(name, opts):
  entry = registry.findWorktree(name)
  ASSERT entry.worktreeOf is set        // INVARIANT: never touch a real project
  footprint.remove(entry)               // reverse order: registry → stats → snapshot → duckdb → qdrant
  registry.remove(entry.collection)
  if not opts.keepGit: gitWorktreeRemove(entry.path, force=opts.force)   // bd-style safety checks
```

### `list` / `info` (pure queries — CQS)

- `list` → `registry.listWorktrees()` (entries with `worktreeOf`) → table /
  JSON. No side effects.
- `info` → `registry.findByPath(cwd)`; if it is a worktree clone, render
  provenance + chunk count + diff status. No side effects.

## 6. Footprint Kernel

`domains/maintenance/footprint/`. Resolves the colocation-vs-information-hiding
tension (Meyer) explicitly:

- **What artifacts compose a footprint, and in what order** → one place
  (`CollectionFootprintFactory`). Colocation + rollback ordering live here.
- **How each artifact's files are laid out / copied** → inside the owning module
  (Information Hiding). The kernel never reaches into shard filenames or DuckDB
  paths.

```ts
type ArtifactId = "qdrant" | "codegraph" | "snapshot" | "stats" | "quarantine";

interface CollectionArtifact {
  readonly id: ArtifactId;
  clone(ctx: FootprintContext): Promise<void>;
  remove(ctx: FootprintContext): Promise<void>;
}

interface FootprintContext {
  source: ResolvedCollection; // logicalName, physicalName, path, embeddingModel, dims, qdrantUrl, codegraphEnabled
  target: ResolvedCollection;
}
```

Each artifact is a **thin delegate** to the owner of its files:

| Artifact             | Delegates to             | New owner method                                                                                                                |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `QdrantArtifact`     | `QdrantManager`          | `createSnapshot(physical)` + `recoverFromSnapshot(target, loc)` + reuse existing alias-swap (`finalizeAlias` / `alias-cleanup`) |
| `CodegraphArtifact`  | `GraphDbClientPool`      | `cloneDatabase(src, dst)` (checkpoint / idle-wait → `fs.copyFile`)                                                              |
| `SnapshotArtifact`   | `ShardedSnapshotManager` | `cloneTo(src, dst, newCodebasePath)` (copy shards + rewrite meta)                                                               |
| `StatsArtifact`      | `StatsCache`             | `clone(src, dst)` (`remove` already exists as `invalidate`)                                                                     |
| `QuarantineArtifact` | quarantine store         | `clone(src, dst)` / `remove(dst)`                                                                                               |

Adding a future artifact (git-cache, onnx-calibration) = one
`CollectionArtifact` impl + one line in the factory (OCP, Single Choice
Principle).

### Qdrant clone mechanism (decided)

**snapshot → recover (online).** `QdrantManager.createSnapshot(srcPhysical)`
writes a snapshot via `@qdrant/js-client-rest`; `recoverFromSnapshot`
materializes it into `code_<wtHash>_v1`; the existing alias-swap machinery
points the logical alias `code_<wtHash>` at it.

Rejected alternatives:

- **cold `cp -r` storage dir + daemon restart** — cheapest in bytes, but the
  embedded Qdrant daemon is shared (refcounted) and does not hot-rescan its
  storage dir; a restart to pick up the copied collection would tear down
  parallel worktree sessions. Copying mmap'd segments mid-write is also
  inconsistent.
- **scroll + upsert over the network** — not file-level, slower; rejected by
  preference for the cheapest file-level path.

DuckDB / snapshot / stats are unconditionally `fs.copyFile` (or owner-`cloneTo`)
— only the Qdrant vector store needed a real decision.

## 7. Registry Provenance (the "manageable" mechanism)

`RegistryEntry` gains two **additive** fields (deep-silo file, but purely
additive — no shape break for existing readers):

```ts
worktreeOf?:   string;   // source collection logical name (provenance)
worktreeName?: string;   // the worktree name
```

`CollectionRegistry` gains `listWorktrees()` / `findWorktreesOf(src)` /
`findWorktree(name)` queries. These power `list` / `info` and the `remove`
guard.

## 8. Invariants (DBC)

- **create PRE**: source exists in registry and is indexed; target collection
  does not exist; target path is a git worktree of the source repo.
- **create POST**: either the registry holds the target entry with `worktreeOf`
  set and all footprint artifacts present, or (on any failure) nothing is left
  behind (saga rollback).
- **remove INVARIANT**: only entries with `worktreeOf` set are removable via
  this path — a real project cannot be destroyed by construction (guard lives in
  `WorktreeOps.remove`, not the CLI).
- **CQS**: `create` / `remove` are commands (side effects, minimal status
  return); `list` / `info` are pure queries.

## 9. Error Handling

- create: any artifact failure → compensating rollback in reverse order, then
  rethrow. DuckDB busy (daemon lock held) → bounded backoff on idle.
- recover/snapshot failure → abort + rollback.
- reindex (post-commit) failure → warning, clone retained.
- remove: provenance guard violation → abort before any deletion.

## 10. Testing Strategy

- **Unit (WorktreeOps)**: mock all 5 `CollectionArtifact`s → exercise the saga,
  the rollback ordering, and the post-commit-reindex-failure-is-warning policy
  without a real Qdrant.
- **Unit (owners)**: each owner's `clone` / `remove` against temp dirs
  (`ShardedSnapshotManager.cloneTo` rewrites meta; `StatsCache.clone`;
  `GraphDbClientPool.cloneDatabase` idle-wait).
- **Unit (registry)**: provenance fields round-trip; `remove` guard refuses a
  non-worktree entry.
- **Integration (MCP/CLI, post-build)**: `worktree create` a clone of tea-rags
  itself → search resolves against the clone → edit one file → diff reindex
  picks up exactly that file → `worktree remove` deletes every artifact and the
  registry entry.

## 11. Out of Scope / Follow-ups

- Relocating the existing `doctor` command into `domains/maintenance/doctor/`
  and having it verify footprint integrity (the domain is designed to accept it;
  deferred — YAGNI for the first cut).
- MCP-tool surface for worktree ops (CLI-only for now, per decision; the App
  methods make a later MCP exposure a thin add).
- Native-snapshot vs scroll copy strategy abstraction (only snapshot/recover is
  implemented; a `CopyStrategy` seam can be introduced later under OCP if a
  remote/external-Qdrant deployment needs scroll+upsert).
