# domains/maintenance/registry — the on-disk project registry: sticky fields, CAS flush, env replay

## Invariants

- **Only `name`, `autoUpdate` and `languageVersions` survive a pipeline
  `record()` — everything else is overwritten.** `CollectionRegistry#record`
  replaces the entry with whatever the caller passed and re-attaches exactly
  those three from the existing one. Every other CLI-managed field must be
  supplied by the caller or it is erased. `languageVersions` is sticky for a
  sharper reason than the other two: it CLAIMS a language layer was rebuilt
  corpus-wide, so only the run that rebuilt it may advance it
  (`#stampLanguageVersions`, called from `IndexingOps` because that is the only
  layer that knows the run mode). Every run calls `record()`, incremental ones
  included — carrying the stamp there would have auto-update silently clearing
  the reindex hint it exists to raise. `worktreeOf` / `worktreeName` ARE part of
  `RecordEntryInput` (`contracts/types/registry.ts`, an
  `Omit<CollectionEntry, "name" | "autoUpdate">`), but
  `BaseIndexingPipeline#recordRegistryEntry` (`domains/ingest/pipeline/base.ts`)
  never passes them, and nothing re-sets provenance after an index run — the
  only writer is `CollectionRegistry#setWorktreeProvenance`, called once at
  clone time. Why: reindexing a worktree clone wipes its provenance;
  `CollectionRegistry#findWorktree` then misses it,
  `tea-rags worktree remove <name>` throws `WorktreeNotFoundError`, and the
  plugin cleanup hook's registry-vs-filesystem sweep skips the entry — silently,
  with no error anywhere. Any new field set outside the pipeline must be added
  to the sticky preserve list here.

## Mechanics

- **Every mutator does a synchronous whole-file round trip, and the CAS backoff
  busy-waits.** `CollectionRegistry#record`, `#updatePath`, `#setName`,
  `#setAutoUpdate`, `#recordAutoUpdateRun`, `#remove` and
  `#setWorktreeProvenance` each call `flush()` immediately, and `flush()` is
  `flushWithCAS` (`CollectionRegistry#flush`): read all of `registry.json`,
  merge, write temp, rename (`flushWithCAS` in `registry-file.ts`). On a CAS
  miss the retry path is `sleepSync` — a `while (Date.now() < end)` spin, NOT a
  timer (`registry-file.ts`) — 10+20+40+80 ms over four backoffs before
  `RegistryConcurrencyError`. Why: the API looks like cheap in-memory setters,
  so it invites being called per file or per chunk; in the MCP server that
  blocks the event loop for ~150 ms per contended mutation and stalls every
  concurrent request. Batch first, write once.
- **A flush writes back only the fields THIS instance changed since it loaded.**
  `CollectionRegistry` keeps a `loadedSnapshot` of every entry taken at load and
  refreshed after each successful flush (`CollectionRegistry#ensureLoaded`,
  `CollectionRegistry#flush`), and `mergeRegistryDelta` (`registry-file.ts`)
  merges three-way per entry: result = the DISK entry with only the top-level
  fields whose in-memory value differs from the snapshot (`mergeChangedFields`),
  a field dropped from memory since load dropped, and an entry unchanged since
  load that another process deleted NOT resurrected. An entry absent from the
  snapshot (this process created it, or the file did not exist at load) is
  written whole through `mergeRegistryEntries`. The invariant the scheme rests
  on: after every flush the cache ADOPTS the merged entries that were written,
  so the snapshot equals the cache field-for-field for every held key (it holds
  `structuredClone` copies, never the same objects) and the next flush diffs
  only what this instance changes afterwards. Why: each process caches
  `registry.json` once and never re-reads it, so writing the whole cache back
  rolls every field another process wrote since load — the `indexedAt` / `git` /
  `chunksCount` a pipeline instance stamped, on the entry being mutated AND on
  every other cached one.
- **Deletes need a tombstone because the flush merges disk back in.**
  `mergeRegistryDelta` seeds the result from the on-disk file and only then
  applies the in-memory delta — merge-on-write, so a concurrent writer's entries
  are never clobbered. `CollectionRegistry#remove` therefore adds the name to
  `this.tombstones` before flushing, `mergeRegistryDelta` deletes tombstoned
  keys from the merged result, and `record` clears the tombstone on
  re-registration (`CollectionRegistry#record`). Why: a plain `map.delete()` is
  resurrected from disk on the very next flush. Any future removal-shaped
  operation that forgets the tombstone silently no-ops.

## Boundaries

- **`REGISTRY_ENV_GROUPS` is one leg of a three-file contract with `bootstrap`,
  with no compile-time link.** The alias families in `REGISTRY_ENV_GROUPS`
  (`env-groups.ts`) must mirror what `bootstrap/config/parse.ts` resolves
  through the reader `createEnvReader` hands it (`bootstrap/config/utils.ts`;
  its `readEnv` core is shared with the `envWithFallback` spelling the source
  comments still name), and `bootstrap/config/env-snapshot.ts` must emit each
  group's canonical key at its parsed effective value. `env-snapshot.ts` imports
  nothing from here; `parse.ts` restates the alias order literally
  (`env("EMBEDDING_BASE_URL", "OLLAMA_URL")`). The only guard is
  `tests/core/domains/maintenance/registry/env-groups.test.ts`, which pins the
  families against hardcoded literals rather than reading `parse.ts`. Why: miss
  a group and the failure is silent — `replayRegistryEnv` (`env-replay.ts`)
  writes a snapshot key unless some MEMBER OF ITS GROUP is already set, so a key
  in no group is checked only against itself: the stored canonical value lands
  and shadows an externally-passed deprecated spelling (`OLLAMA_URL`,
  `EMBEDDING_CONCURRENCY`), so an explicit operator override LOSES and the run
  goes to the wrong backend without an error.
- **`ADAPTIVE_DEFAULT_ENV_KEYS` (`env-groups.ts`) is a fourth coupling.** Those
  four keys are materialized into the snapshot only when the config layer's
  `userSet*` flags say the user set them explicitly. Why: pinning a
  GPU-calibrated or per-language-adaptive default freezes behavior the default
  is supposed to recompute per run.

## See also

- `.claude/rules/domain-boundaries.md` — why the registry lives here, not in
  `core/infra/`.
- `../worktree/CLAUDE.md` — the provisioner is the only writer of `worktreeOf` /
  `worktreeName`.
