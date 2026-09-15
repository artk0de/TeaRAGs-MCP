# domains/maintenance/footprint — the six per-collection artifacts, cloned and removed as one saga

## Invariants

- **Which artifact keys on the alias and which on the versioned physical name is
  fixed, deliberate, and now DECLARED.** `ResolvedCollection` (`artifact.ts`)
  carries both `logicalName` and `physicalName` and gives no hint which to use,
  so every artifact states its side in `readonly addressing`
  (`ArtifactAddressing`, `artifact.ts`). Qdrant points and the codegraph DuckDB
  file are `"physical"` (the versioned `_vN`, so one exists PER GENERATION); the
  file-hash snapshot, the stats cache, the quarantine store and the indexing
  lock are `"logical"` (the stable alias, one per collection, surviving a
  version bump). A new artifact picks its side in that field, not by convention.
  Why: getting it wrong diverges silently rather than erroring — the measured
  case is the shadow-DuckDB defect (bd 6goqa), told in full by
  `../../ingest/operations/CLAUDE.md` — and the field is what lets
  `CollectionFootprintPurger` sweep every generation without re-encoding the
  split as a list of artifact ids somewhere else.

## Mechanics

- **The factory array IS the saga order, and `remove` runs against targets that
  may never have been cloned.** `CollectionFootprintFactory#build` (comment
  `// Order = clone order; rollback / remove walk it in reverse`) fixes the
  order; `WorktreeProvisioner#create` pushes each artifact into its `done` list
  BEFORE calling `clone` (`// C2`), deliberately, so the artifact that threw
  participates in its own rollback, and teardown does the same reversed sweep
  (`WorktreeProvisioner#remove`). Every `remove` addresses `ctx.target`, never
  `ctx.source`. Why: a new `CollectionArtifact.remove` (contract spelled out in
  the `CollectionArtifact` docblock, `artifact.ts`) must tolerate a target that
  never existed, be idempotent, and swallow per-step failures internally — the
  orchestrator wraps every call in `.catch(() => undefined)` and treats a throw
  as a non-fatal skip, so one dead step inside your artifact abandons the rest
  of THAT artifact's cleanup with no trace. Adding an artifact is advertised as
  "one class plus one line in the factory"; that line signs you up for this
  failure-path contract.
- **Qdrant is the one artifact that is NOT a file copy, and the asymmetry is a
  decision.** `QdrantArtifact#clone` goes `createSnapshot(source.physicalName)`
  → snapshot download URL → `recoverFromSnapshot(target.physicalName)` →
  `aliases.createAlias`, over HTTP, with `deleteSnapshot` in a `finally`. The
  other four clone by file/store copy. A cold `cp -r` of the collection
  directory was rejected: the embedded Qdrant daemon is refcounted and shared
  across sessions (`adapters/qdrant/embedded/daemon.ts`) and does not hot-rescan
  its storage dir, so picking up a copied collection needs a daemon restart that
  tears down every parallel worktree session — and copying mmap'd segments
  mid-write is inconsistent anyway. Scroll+upsert over the network was rejected
  as slower and not file-level. Why: the natural "simplify this, make Qdrant
  look like the other four" instinct costs a parallel session its daemon
  mid-run, and the `finally` is what stops a failed recover leaking a snapshot.

- **Two orchestrators drive `remove`, and they disagree about scope on
  purpose.** `WorktreeProvisioner#remove` sweeps ONE generation — the clone's
  own `_v1` — because that is all a clone ever has. `CollectionFootprintPurger`
  (`purger.ts`, behind `projects unregister --purge`) sweeps EVERY generation of
  a long-lived project, enumerating them from Qdrant and from the codegraph
  directory and taking the UNION: a `.duckdb` whose Qdrant collection is already
  gone is invisible from the Qdrant side, and that is precisely the file that
  leaks. It also cannot construct a `GraphDbClientPool` — construction sweeps
  the shared `.spill` dir on behalf of every project (`spill-files.ts`, next to
  the pool) — so `FootprintDeps.pool` is the structural
  `CodegraphFootprintStore` (`contracts/types/footprint.ts`), satisfied by the
  pool in the app and by `adapters/duckdb/codegraph-db-files.ts` in the purge.
  Why: "reuse the pool, it already has these methods" is the obvious move and it
  silently sabotages another process.
- **`QdrantArtifact#remove` swallows the alias delete and NOT the collection
  delete.** A logical name that was never an alias 404s on `deleteAlias` as a
  matter of course, so that step is best-effort and must never block the one
  after it; `deleteCollection` is the actual job, and its rejection propagates
  so a caller can report the reason. The worktree teardown wraps every `remove`
  in its own `.catch(() => undefined)`, so it is unaffected — the purge is what
  needs "network down" instead of "the collection is somehow still there". Why:
  the artifact contract (`artifact.ts`) says an implementation MAY throw and
  SHOULD attempt every step internally; that is not the same as swallowing
  everything, and reading it that way costs the only diagnostic the purge has.
- **`IndexingLockArtifact#remove` is the one teardown that refuses, and it
  refuses only the lock.** It deletes `<logical>.indexing.lock` when the run
  holding it is dead and throws `IndexingLockHeldError` when that run is live
  (the liveness rules live in `CollectionIndexingLock`,
  `domains/ingest/infra/collection-indexing-lock.ts`); `clone` copies nothing.
  Neither orchestrator treats the refusal as a veto: the purge records it as a
  failure naming the holder, the worktree teardown swallows it, and both still
  delete every other artifact — Qdrant generations included — under the live
  run. Why: the lock is keyed by the LOGICAL name because a force reindex moves
  the alias mid-run, so it is swept once, not per generation; and blocking the
  whole teardown on a live run is a separate decision that has not been made.

## See also

- `../worktree/CLAUDE.md` — the clone/teardown orchestrator; owns the commit
  point and the teardown guard.
- `src/bootstrap/footprint-purge.ts` — the purge's composition root, separate
  from `createAppContext` so a delete does not boot embeddings and the daemon.
- `.claude/rules/migrations.md` — the per-collection stores these artifacts
  clone, and who upgrades each.
