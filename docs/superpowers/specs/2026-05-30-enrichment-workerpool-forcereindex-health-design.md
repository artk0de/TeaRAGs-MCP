# Enrichment Worker-Pool Wiring + Force-Reindex Versioning + Health-Check Robustness

**Date:** 2026-05-30 **Beads:** epic `tea-rags-mcp-3k0m` — A
`tea-rags-mcp-dz7f`, B `tea-rags-mcp-jpsf`, C `tea-rags-mcp-z6uc`

## Problem

Three connected defects surfaced while exercising the enrichment thread pool on
a large project (`taxdome`, 114k chunks):

- **A — thread pool is dead weight.** `WorkerPoolEnrichmentExecutor` is wired as
  the production executor (`bootstrap/factory.ts:453`), but every dispatch path
  checks `!provider.workerDescriptor` and falls back to an in-thread
  `InlineEnrichmentExecutor`. Both enrichment providers are built **without** a
  `workerDescriptor`:
  - `domains/trajectory/git.ts:33` —
    `new GitEnrichmentProvider(config, squashOpts)`
  - `domains/trajectory/codegraph/symbols/index.ts:22` —
    `new CodegraphEnrichmentProvider({...deps})`

  The factory designed to attach it
  (`createGitEnrichmentProvider(config, descriptor?)`) is never called, and no
  `WorkerEnrichmentDescriptor` literal exists anywhere in `src/`. Result: git
  blame runs on the main thread during indexing, blocking the event loop.
  Codegraph partly escapes via its own DuckDB daemon pool, but still never uses
  the enrichment worker pool.

- **C — health-check false negative aborts indexing.**
  `OllamaEmbeddings.checkHealth` (`adapters/embeddings/ollama.ts`) uses
  `fetchWithTimeout(url, HEALTH_PROBE_TIMEOUT_MS)`. When the event loop is
  blocked (by A's inline git enrichment), the probe's `fetch` cannot get a tick
  before `AbortSignal.timeout` fires, so `checkHealth` returns `false` and
  `index_codebase` aborts with `INFRA_OLLAMA_UNAVAILABLE` — even though `curl`
  to the same endpoint returns 200 in 0.09s.

- **B — force-reindex version source of truth is wrong.**
  `IndexingPipeline.setup` computes `newVersion = snapshot.aliasVersion + 1`
  (`operations/indexing.ts:198`), reading the version from a **snapshot file**,
  not from Qdrant reality. When the snapshot lags or is lost, force reindex
  generates a version number that collides with the live state (observed: orphan
  `code_27622aef_v1` with 13826 pts while the alias points at a full `v8` with
  114389 pts). Orphan cleanup (`cleanupOrphanedVersions`) exists and runs in
  `setup`, but only on the _next_ run (lazy) — an interrupted reindex leaves an
  orphan until then.

## Root-cause summary

| Defect | Root cause                                                                                      | Fix direction                                                           |
| ------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A      | providers built without `workerDescriptor`; worker-factory exports + composition wiring missing | wire descriptors at composition root + add async worker-factory exports |
| B      | `newVersion` derived from `snapshot.aliasVersion`, not Qdrant reality                           | derive version from Qdrant (alias target + max existing `_vN`)          |
| C      | health probe fatally aborts on a timeout it can suffer from event-loop starvation               | retry + grace before fatal abort                                        |

## Design

### A — Worker-pool wiring (full: git + codegraph)

The worker-pool infrastructure is complete and correct
(`enrichment/infra/worker.ts`, `executor/worker-pool.ts`, `ThreadPool`, dispatch
routing, `WorkerEnrichmentDescriptor` type). Only the wiring is missing.

1. **Async worker-factory exports.** The worker (`worker.ts:54`) expects a named
   export of shape `(config: unknown) => Promise<EnrichmentProvider>`. Add:
   - git module: a worker-factory that builds a `GitEnrichmentProvider` from a
     serializable `GitWorkerConfig`. `dispatch: "stateless"`.
   - codegraph module: a worker-factory that rebuilds the provider in-thread
     from a serializable `CodegraphWorkerConfig` — reopening the DuckDB daemon
     socket and constructing the `languageFactory` via injected module-path (per
     `.claude/rules/domains-language.md` §2: inject a PATH, dynamic-import
     in-thread, never an instance). `dispatch: "collection-affinity"`.

2. **Construct `WorkerEnrichmentDescriptor` at the composition root.** Only the
   composition layer (`api/internal/composition.ts` / `bootstrap/factory.ts`)
   knows the absolute compiled-JS module paths and the daemon socket. It builds
   the descriptor (`providerModulePath`, `providerFactoryExport`, `dispatch`,
   `serializableConfig`) for each provider.

3. **Thread the descriptor into the providers.** Pass it through the trajectory
   factories (`GitTrajectory` / `createSymbolsTrajectory`) into the provider
   constructors (the optional 3rd / 2nd positional arg already exists).

4. **Regression guard.** A test asserting that in the production composition
   both the git and codegraph providers expose a defined `workerDescriptor`, so
   a silent inline fallback can never regress unnoticed.

**Invariant preserved:** descriptor is data-only (no executor reference); the
provider still has no idea which thread its methods run on. Inline executor
stays as the test seam and the fallback for providers that legitimately omit a
descriptor.

### B — Version from Qdrant truth

Replace the snapshot-derived version with one computed from Qdrant:

```
newVersion = max(versionFromAliasTarget, maxExistingVersionedCollection) + 1
```

- `versionFromAliasTarget` — parse `_vN` from the collection the alias currently
  points to (0 if no alias / unversioned).
- `maxExistingVersionedCollection` — scan `listCollections()` for
  `^${collectionName}_v(\d+)$`, take the max (covers orphans from interrupted
  runs so the new version never collides with a leftover).

`snapshot.aliasVersion` stops being the version source (may remain as a cache,
but `setup` no longer reads it to decide the next version).
`cleanupOrphanedVersions` stays as-is (lazy cleanup on next run already handles
leftover orphans, and the Qdrant-derived version means a leftover can no longer
be re-collided-with).

One-time manual cleanup of the current orphan `code_27622aef_v1`.

### C — Resilient health check

In the path that aborts `index_codebase` on `INFRA_OLLAMA_UNAVAILABLE`: before
the fatal abort, retry the health probe N times with a short pause between
attempts. The pause yields the event loop so a probe starved by a busy tick can
succeed on retry. A genuinely-down Ollama still fails all N attempts and aborts
as before. Retry count and pause are config values with sensible defaults.

This is independent of A: fixing A removes most event-loop blocking, but the
probe must not fatally abort indexing on a signal it can itself be starved of.

## Execution order

A → C → B, each as a TDD subagent in the shared worktree:

1. **A** first — removes the event-loop-blocking root that C falsely trips on.
2. **C** — independent file (`ollama.ts` + abort path), small.
3. **B** — independent file (`operations/indexing.ts`), no overlap with A/C.

Files barely overlap (A: composition/trajectory/enrichment; B:
ingest/operations; C: adapters/embeddings), so a shared worktree avoids merge
friction.

## Testing

- **A:** unit test that the composed git/codegraph providers carry a
  `workerDescriptor`; worker-factory exports build a valid provider from
  serializable config; existing enrichment tests stay green (inline seam
  intact).
- **B:** unit test for `computeNewVersion` across cases — no alias (first
  index), alias at vN, orphan vM > alias version, migration. Existing indexing
  tests green.
- **C:** unit test that a probe which times out once then succeeds does NOT
  abort; a probe that fails all N attempts DOES abort with the typed error.

## Constraints

- Deep-silo files touched (`coordinator.ts`, `recovery.ts`, `ollama.ts`,
  `adapters/qdrant/errors.ts`) require a `Why:` line in their commits
  (`.claude/rules/silo-pairing.md`).
- Typed errors only (`.claude/rules/typed-errors.md`); no `throw new Error` for
  user-facing paths.
- No linter-config or coverage-threshold changes.
- Worker DI by module-path injection, no static cross-domain import, no eslint
  exemption (`.claude/rules/domains-language.md`).
