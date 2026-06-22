# CLI `index-codebase` — Design

**Date:** 2026-06-22 **Status:** Approved **Scope:** sub-epic → small epic
(detached process + IPC raise complexity above a plain progress bar)

## Goal

Add a first-class CLI command:

```
tea-rags index-codebase --project <name> | --path <path> [--wait-enrichments]
```

with:

1. **Parallel progress bars** — one primary bar for embeddings + one bar per
   enrichment provider (`git`, `codegraph.symbols`).
2. **Final `index status`** printed at the end.
3. **`--wait-enrichments` flag** — default does NOT wait for enrichment; the
   flag makes the command stay until every enrichment provider finishes.

## Architectural constraints (discovered, not assumed)

- **Enrichment is woven in-process.** `BaseIndexingPipeline.startEnrichment`
  launches enrichment fire-and-forget inside the same `indexCodebase` call;
  file-phase begins during chunk storage
  (`chunkPipeline.setOnBatchUpserted → EnrichmentCoordinator.onChunksStored`),
  chunk-phase follows. `indexCodebase` returns with
  `enrichmentStatus: "background"` BEFORE enrichment completes. Under the MCP
  server (long-lived process) the background work survives. A short-lived CLI
  process would kill it on exit.
- **Enrichment markers are terminal-only.** `payload.enrichment` holds a `_run`
  pointer (`{ runId, startedAt, lastProgressAt, providers[] }` — a heartbeat
  timestamp, not a counter) plus per-provider terminal markers written only at
  level completion
  (`{ status, matchedFiles, missedFiles, unenrichedChunks, durationMs }`). There
  is NO persisted live numerator. A determinate per-provider progress bar and a
  real ETA both require an **in-process progress stream** — the markers cannot
  supply it.
- **Embeddings already report progress** via the existing `ProgressCallback`
  (`{ phase, current, total, percentage, message }`), threaded
  `IngestFacade → IndexingOps.run → IndexPipeline.indexCodebase`.
- **`EnrichmentCoordinator` is a single shared instance** (constructed once in
  `IngestFacade.buildIngestPipeline`, shared by index + reindex pipelines). A
  progress callback for it MUST therefore be **per-run**, not constructor-level.
- **CLI reaches core only through `core/api/public`** (`App`). The command
  reuses `App.indexCodebase` — the same path the MCP `index_codebase` tool uses
  — never a parallel indexing implementation.

## Decisions (locked during brainstorming)

| #   | Decision                            | Choice                                                                                                       |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | Default vs flag semantics           | **default = do NOT wait**, `--wait-enrichments` = wait for all providers                                     |
| 2   | How non-wait keeps enrichment alive | **Detached background process** (child does real indexing+enrichment, `unref`'d; survives foreground exit)   |
| 3   | Enrichment progress source          | **In-process callback** (determinate bars + real ETA), emitted by the child, streamed to foreground over IPC |
| 4   | Bar renderer                        | **`cli-progress`** multibar (new dependency; `ora` is spinner-only)                                          |
| 5   | Exit code on enrichment failure     | provider `failed` → **exit non-zero** (only observable in `--wait` mode); `degraded` → warn + exit 0         |

## Process model

Two processes connected by an IPC channel.

### Foreground — `index-codebase` command

1. Parse args (`--project` / `--path` mutually-exclusive resolution, reusing
   `cli/registry-resolver.ts` + `cli/qdrant-url-resolver.ts` as `prime` does;
   plus `--wait-enrichments` and the hidden internal `--__worker`).
2. `fork` the same binary (`build/cli/index.js --__worker …`) with
   `{ detached: true, stdio: ['ignore','ignore','ignore','ipc'] }` and `unref`
   the child so it outlives the foreground.
3. Subscribe to IPC progress messages; drive the `cli-progress` multibar
   (embedding bar + lazily-created per-provider bars).
4. Mode branch:
   - **default**: when the embedding phase hits 100% (alias switched → index
     searchable) print `✓ index ready (searchable)`, the final `index status`,
     and a one-line enrichment ETA, then **disconnect IPC and exit 0**. The
     child finishes enrichment unattended. (Enrichment result is not observable
     in this mode — by definition we did not wait.)
   - **`--wait-enrichments`**: stay attached, render embedding + per-provider
     bars until the child emits `done`, print the final `index status`, and
     **propagate the child's exit code** (non-zero if any provider `failed`).

### Child — `--__worker`

1. Build `App` via bootstrap (`createAppContext` → `createApp`).
2. Run `App.indexCodebase(path, { …, awaitEnrichment: true }, cb)` with BOTH
   progress callbacks wired to `process.send` IPC messages.
3. Tolerate a closed channel: once the foreground disconnects (default mode),
   `process.send` becomes a no-op; the child keeps working.
4. Exit with a code reflecting the enrichment outcome.

## IPC protocol — `cli/index-progress/ipc-protocol.ts`

```ts
type WorkerMessage =
  | {
      type: "embedding";
      phase: string;
      percentage: number;
      current: number;
      total: number;
    }
  | {
      type: "enrichment";
      providerKey: string;
      level: "file" | "chunk";
      applied: number;
      total: number;
    }
  | { type: "status"; status: IndexStatus }
  | { type: "done"; result: { failed: string[]; degraded: string[] } }
  | { type: "error"; message: string };
```

## Core changes (additive — no-op when the callback is undefined; MCP path unchanged)

- **`core/types.ts`** — add `EnrichmentProgressEvent`
  (`{ providerKey; level: "file"|"chunk"; applied; total }`),
  `EnrichmentProgressCallback`, and `IndexOptions.awaitEnrichment?: boolean`.
- **Thread `enrichmentProgress?`** through `App.indexCodebase`
  (`api/public/app.ts`) → `IngestFacade.indexCodebase` → `IndexingOps.run` →
  `IndexPipeline.indexCodebase`. Optional param, mirrors `ProgressCallback`.
- **`IndexPipeline.startEnrichment`** returns the completion promise alongside
  the status getter; `indexCodebase` awaits it when `options.awaitEnrichment` is
  set (CLI child always sets it; MCP never sets it → today's background
  behaviour preserved).
- **`EnrichmentCoordinator.beginRun` / `startChunkEnrichment`** accept the
  per-run `EnrichmentProgressCallback`; the file/chunk phases (or the applier
  apply loop) emit `(providerKey, level, applied, total)` per batch. This is the
  single, strictly-additive incision into the churn-hot coordinator.

## Registry-first env resolution

The forked worker bootstraps its embedding / codegraph config from process env
(`parseAppConfig`). To avoid forcing the operator to re-export `EMBEDDING_*` by
hand, the command resolves config from the **project registry** (the same
register-first source `prime` reads) and injects it into the worker env:

- `--project <name>` → that entry's config.
- `--path` of a known project → that path's entry.
- a brand-new project (no entry) → the **most recently indexed** project's
  config (`max indexedAt`), so a fresh index "just works" against the backend
  last used.

Mapped env vars: `EMBEDDING_MODEL`, `EMBEDDING_BASE_URL`,
`EMBEDDING_FALLBACK_URL`, `CODEGRAPH_ENABLED` (from `CollectionEntry`). Ambient
`process.env` still wins (the command merges
`{ ...registryEnv, ...process.env }`) so explicit overrides are preserved —
registry only fills gaps. `QDRANT_URL` is left to the normal embedded resolution
(the registry's stored embedded port is dynamic and would be stale). Lives in
`cli/index-progress/registry-env.ts` (`pickRegistryEntry` +
`resolveRegistryEnv`).

## ETA

Pure function over the live enrichment stream:
`eta = remainingUnits / (appliedUnits / elapsedSinceEnrichmentStart)` aggregated
across all providers' remaining file + chunk units. Recomputed as events arrive.
Denominators come from the first event per `(provider, level)` (`total`).

## New / changed files

**New**

- `src/cli/commands/index-codebase.ts` — yargs command (arg parse, resolution,
  fork-or-run-worker dispatch on `--__worker`).
- `src/cli/index-progress/supervisor.ts` — foreground: fork detached child,
  consume IPC, drive renderer, mode logic, exit-code propagation.
- `src/cli/index-progress/worker.ts` — child entry: bootstrap App, run index
  with `awaitEnrichment` + IPC-emitting callbacks.
- `src/cli/index-progress/renderer.ts` — `cli-progress` multibar wrapper +
  non-TTY line fallback.
- `src/cli/index-progress/eta.ts` — pure ETA calculator.
- `src/cli/index-progress/registry-env.ts` — registry-first embedding/codegraph
  env resolution (`pickRegistryEntry` + `resolveRegistryEnv`).
- `src/cli/index-progress/status-format.ts` — format `IndexStatus` for stdout.
- `src/cli/index-progress/ipc-protocol.ts` — message types + type guards.

**Changed**

- `src/cli/create-cli.ts` — register `indexCodebaseCommand`.
- `package.json` — add `cli-progress` (dep) + `@types/cli-progress` (devDep).
- Core chain above (`types.ts`, `app.ts`, `ingest-facade.ts`, `indexing-ops.ts`,
  `operations/indexing.ts`, `pipeline/enrichment/coordinator.ts` + phases).

## Error handling

- Typed errors from the facade bubble to the child; the child emits
  `{ type: "error" }` and exits non-zero.
- A provider whose terminal marker is `failed` → foreground (in `--wait`) prints
  `✗ <provider>: <errorMessage>` and exits non-zero. `degraded` → warn, exit 0.
- Non-TTY / piped stdout → renderer falls back to periodic line logs on stderr;
  stdout stays clean (status only).

## Testing (TDD)

Pure units (no live Qdrant):

- `eta.ts` — throughput → remaining time, edge cases (zero elapsed, zero total).
- `renderer.ts` — event → bar-state; lazy per-provider bar creation; non-TTY
  fallback formatting.
- `status-format.ts` — `IndexStatus` → rendered block.
- `ipc-protocol.ts` — message type guards / round-trip.
- arg parsing — `--project` / `--path` resolution, `--wait-enrichments`.

Core:

- `IndexingOps.run` forwards `enrichmentProgress` and awaits completion when
  `awaitEnrichment` is set (mock App / pipeline).
- `EnrichmentCoordinator` emits per-batch
  `(providerKey, level, applied, total)`.

Integration:

- Real `fork` of the worker on a tiny fixture: assert IPC progress arrives,
  default mode exits before enrichment completion while the child finishes,
  `--wait` mode blocks until `done` and propagates exit code.

## Velocity estimate

Substrate exists (facade/ops/coordinator/`ProgressCallback` pattern). Detached
process + IPC + a new dependency add real surface. **P25 1.5 / P50 2.5 / P75 4
burst-days.**
