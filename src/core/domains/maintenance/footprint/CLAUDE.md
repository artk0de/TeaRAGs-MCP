# domains/maintenance/footprint — the five per-collection artifacts, cloned and removed as one saga

## Invariants

- **Which artifact keys on the alias and which on the versioned physical name is
  fixed and deliberate.** `ResolvedCollection` (`artifact.ts:3-11`) carries both
  `logicalName` and `physicalName` and gives no hint which to use. Qdrant points
  (`qdrant-artifact.ts:9-13`) and the codegraph DuckDB file
  (`codegraph-artifact.ts:10`) address `physicalName` (the versioned `_vN`); the
  file-hash snapshot (`snapshot-artifact.ts:12`), the stats cache
  (`stats-artifact.ts:9`) and the quarantine store (`quarantine-artifact.ts:12`)
  address `logicalName` (the stable alias) so they survive a version bump. A new
  artifact must pick a side consciously. Why: getting it wrong diverges silently
  rather than erroring — the measured case is the shadow-DuckDB defect (bd
  6goqa), told in full by `../../ingest/operations/CLAUDE.md`.

## Mechanics

- **The factory array IS the saga order, and `remove` runs against targets that
  may never have been cloned.** `CollectionFootprintFactory#build`
  (`factory.ts:31-38`, comment
  `// Order = clone order; rollback / remove walk it in reverse`) fixes the
  order; `WorktreeProvisioner#create` pushes each artifact into its `done` list
  BEFORE calling `clone` (`worktree/worktree-provisioner.ts:79-83`, `// C2`),
  deliberately, so the artifact that threw participates in its own rollback, and
  teardown does the same reversed sweep (`worktree-provisioner.ts:179`). Every
  `remove` addresses `ctx.target`, never `ctx.source`. Why: a new
  `CollectionArtifact.remove` (contract spelled out at `artifact.ts:20-28`) must
  tolerate a target that never existed, be idempotent, and swallow per-step
  failures internally — the orchestrator wraps every call in
  `.catch(() => undefined)` and treats a throw as a non-fatal skip, so one dead
  step inside your artifact abandons the rest of THAT artifact's cleanup with no
  trace. Adding an artifact is advertised as "one class plus one line in the
  factory"; that line signs you up for this failure-path contract.
- **Qdrant is the one artifact that is NOT a file copy, and the asymmetry is a
  decision.** `QdrantArtifact#clone` (`qdrant-artifact.ts:8-17`) goes
  `createSnapshot(source.physicalName)` → snapshot download URL →
  `recoverFromSnapshot(target.physicalName)` → `aliases.createAlias`, over HTTP,
  with `deleteSnapshot` in a `finally`. The other four clone by file/store copy.
  A cold `cp -r` of the collection directory was rejected: the embedded Qdrant
  daemon is refcounted and shared across sessions
  (`adapters/qdrant/embedded/daemon.ts`) and does not hot-rescan its storage
  dir, so picking up a copied collection needs a daemon restart that tears down
  every parallel worktree session — and copying mmap'd segments mid-write is
  inconsistent anyway. Scroll+upsert over the network was rejected as slower and
  not file-level. Why: the natural "simplify this, make Qdrant look like the
  other four" instinct costs a parallel session its daemon mid-run, and the
  `finally` is what stops a failed recover leaking a snapshot.

## See also

- `../worktree/CLAUDE.md` — the only orchestrator of this saga; owns the commit
  point and the teardown guard.
- `.claude/rules/migrations.md` — the per-collection stores these artifacts
  clone, and who upgrades each.
