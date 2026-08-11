# domains/maintenance/registry — the on-disk project registry: sticky fields, CAS flush, env replay

## Invariants

- **Only `name` and `autoUpdate` survive a pipeline `record()` — everything else
  is overwritten.** `CollectionRegistry#record` (`collection-registry.ts:43-65`)
  replaces the entry with whatever the caller passed and re-attaches exactly two
  fields from the existing one: `name` (`:57`) and `autoUpdate` (`:60`). Every
  other CLI-managed field must be supplied by the caller or it is erased.
  `worktreeOf` / `worktreeName` ARE part of `RecordEntryInput`
  (`contracts/types/registry.ts:119`, an
  `Omit<CollectionEntry, "name" | "autoUpdate">`), but
  `BaseIndexingPipeline#recordRegistryEntry` (`domains/ingest/pipeline/base.ts`)
  never passes them, and nothing re-sets provenance after an index run — the
  only writer is `CollectionRegistry#setWorktreeProvenance` (`:197-203`), called
  once at clone time. Why: reindexing a worktree clone wipes its provenance;
  `findWorktree` (`:189-195`) then misses it, `tea-rags worktree remove <name>`
  throws `WorktreeNotFoundError`, and the plugin cleanup hook's
  registry-vs-filesystem sweep skips the entry — silently, with no error
  anywhere. Any new field set outside the pipeline must be added to the sticky
  preserve list here.

## Mechanics

- **Every mutator does a synchronous whole-file round trip, and the CAS backoff
  busy-waits.** `record` (`:64`), `updatePath` (`:114`), `setName` (`:138`),
  `setAutoUpdate` (`:158`), `recordAutoUpdateRun` (`:172`), `remove` (`:180`)
  and `setWorktreeProvenance` (`:202`) each call `flush()` immediately, and
  `flush()` is `flushWithCAS` (`:38-41`): read all of `registry.json`, merge,
  write temp, rename (`registry-file.ts:164-187`). On a CAS miss the retry path
  is `sleepSync` — a `while (Date.now() < end)` spin, NOT a timer
  (`registry-file.ts:131-139`) — 10+20+40+80 ms over four backoffs before
  `RegistryConcurrencyError`. Why: the API looks like cheap in-memory setters,
  so it invites being called per file or per chunk; in the MCP server that
  blocks the event loop for ~150 ms per contended mutation and stalls every
  concurrent request. Batch first, write once.
- **Deletes need a tombstone because the flush merges disk back in.**
  `mergeRegistryDelta` (`registry-file.ts:112-129`) seeds the result from the
  on-disk file and only then applies the in-memory delta — merge-on-write, so a
  concurrent writer's entries are never clobbered. `CollectionRegistry#remove`
  (`:175-183`) therefore adds the name to `this.tombstones` before flushing,
  `mergeRegistryDelta` deletes tombstoned keys from the merged result
  (`registry-file.ts:125-127`), and `record` clears the tombstone on
  re-registration (`:63`). Why: a plain `map.delete()` is resurrected from disk
  on the very next flush. Any future removal-shaped operation that forgets the
  tombstone silently no-ops.

## Boundaries

- **`REGISTRY_ENV_GROUPS` is one leg of a three-file contract with `bootstrap`,
  with no compile-time link.** The alias families in `env-groups.ts:35-109` must
  mirror what `bootstrap/config/parse.ts` resolves through the reader
  `createEnvReader` hands it (`bootstrap/config/utils.ts:38`; its `readEnv` core
  is shared with the `envWithFallback` spelling the source comments still name),
  and `bootstrap/config/env-snapshot.ts` must emit each group's canonical key at
  its parsed effective value. `env-snapshot.ts` imports nothing from here;
  `parse.ts` restates the alias order literally
  (`env("EMBEDDING_BASE_URL", "OLLAMA_URL")`). The only guard is
  `tests/core/domains/maintenance/registry/env-groups.test.ts`, which pins the
  families against hardcoded literals rather than reading `parse.ts`. Why: miss
  a group and the failure is silent — `replayRegistryEnv`
  (`env-replay.ts:33-47`) writes a snapshot key unless some MEMBER OF ITS GROUP
  is already set, so a key in no group is checked only against itself: the
  stored canonical value lands and shadows an externally-passed deprecated
  spelling (`OLLAMA_URL`, `EMBEDDING_CONCURRENCY`), so an explicit operator
  override LOSES and the run goes to the wrong backend without an error.
- **`ADAPTIVE_DEFAULT_ENV_KEYS` (`env-groups.ts:188-193`) is a fourth
  coupling.** Those four keys are materialized into the snapshot only when the
  config layer's `userSet*` flags say the user set them explicitly. Why: pinning
  a GPU-calibrated or per-language-adaptive default freezes behavior the default
  is supposed to recompute per run.

## See also

- `.claude/rules/domain-boundaries.md` — why the registry lives here, not in
  `core/infra/`.
- `../worktree/CLAUDE.md` — the provisioner is the only writer of `worktreeOf` /
  `worktreeName`.
