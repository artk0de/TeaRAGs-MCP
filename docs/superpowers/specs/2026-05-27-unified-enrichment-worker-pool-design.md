# Unified Enrichment Worker Pool — Design

**Date:** 2026-05-27 **Status:** Approved (design) — implementation deferred to
a dedicated session **Related:**
`docs/superpowers/specs/2026-05-27-codegraph-chunk-defer-design.md`,
`docs/superpowers/plans/2026-05-27-streaming-file-enrichment.md`,
`.claude/rules/domains-language.md` (worker-DI module-path rule),
`.claude/rules/wiring.md`

## Problem

Streaming file enrichment (delivered in the streaming-enrichment branch) runs
**on the main thread**. The enrichment coordinator, both trajectory providers
(git, codegraph) and their `streamFileBatch` / `buildFileSignals` /
`buildChunkSignals` / `finalizeSignals` calls all execute in the MCP-server main
process. Heavy work — git `blame`/`log` churn-map construction, codegraph
tree-sitter extraction + symbol resolution — is CPU-bound JavaScript that
occupies the event loop.

### Evidence

Live taxdome reindex (`~/.tea-rags/logs/pipeline-2026-05-28T02-50-44.log`):

- Embedding graph shows multi-minute **"ямы"** (gaps): 204.7s, 162.9s, 81.3s;
  first `EMBED_CALL` only at +1245s.
- During each gap the main thread is dominated by git `STREAMING_APPLY` (file
  enrichment) and `STREAMING_CHUNK_ENRICHMENT_COMPLETE`, while the `ChunkerPool`
  worker threads keep producing chunks.
- Embedding HTTP to ollama starves → ollama times out → run dies at ~63k/111k
  chunks.
- Independently observed: process RSS grows 800MB → 1.5GB during a run.

Root cause: enrichment JS shares the event loop with the embedding HTTP client.
A real worker_threads pool already exists for **chunking** (`ChunkerPool`) and
keeps the parse step off the main thread — but **enrichment was never moved off
the main thread**.

## Goal

A **unified, trajectory-agnostic worker-pool mechanism at the ingest-engine
level**, used by ALL trajectory enrichment kinds (git + codegraph, both file and
chunk), so heavy enrichment runs off the main thread. The main thread keeps only
orchestration + cheap async I/O (applying overlays to Qdrant via `set_payload`).

Non-goals: parallelizing codegraph extraction _within_ a single collection
(stateful run — see Affinity below); rewriting provider business logic; changing
the streaming/defer design from the prior spec.

## Reference pattern — `ChunkerPool`

`src/core/domains/ingest/pipeline/chunker/infra/{pool.ts,worker.ts,worker-protocol.ts}`:

- N `worker_threads`, round-robin to the first free worker, overflow `queue`,
  one in-flight request per worker (`busy` flag), graceful `shutdown` (post
  `{type:"shutdown"}`, `terminate()` fallback after 2s).
- **Worker DI = module PATH, not instance.** A class instance cannot cross the
  `postMessage` structured-clone boundary. The pool computes a runtime STRING
  path to the compiled module (`LANGUAGE_MODULE_PATH`) and injects it through
  `workerData`; the worker `dynamic-import`s and constructs in-thread. This
  keeps `domains/ingest` free of any static `domains/language` import
  (leaf-domain eslint guard sees only literal specifiers).
- `WORKER_PATH` resolves to compiled `build/...worker.js` (`import.meta.url`
  with `/src/` → `/build/` remap), because worker_threads need compiled JS.

The unified enrichment pool **parallels this exact pattern**.

## Architecture — three layers + a per-trajectory descriptor

### 1. `EnrichmentExecutor` — the dispatch contract (DIP seam)

A behavior interface the coordinator and phases depend on **instead of calling
provider methods directly**. This is the key decoupling: the coordinator never
references `worker_threads`.

```ts
// contracts/types/ (pure type, no Zod — domain-boundaries rule)
interface EnrichmentExecutor {
  runFileBatch(
    provider: EnrichmentProvider,
    root: string,
    paths: string[],
    options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>>;

  runChunkBatch(
    provider: EnrichmentProvider,
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    options?: ChunkSignalOptions,
  ): Promise<Map<string, Map<string, ChunkSignalOverlay>>>; // file → chunkId → overlay

  runFinalize(
    provider: EnrichmentProvider,
    root: string,
    options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>>;

  shutdown(): Promise<void>;
}
```

The return/argument shapes mirror `EnrichmentProvider` exactly
(`contracts/types/provider.ts`): `streamFileBatch`/`buildFileSignals`/
`finalizeSignals` → `Map<string, FileSignalOverlay>`; `buildChunkSignals` takes
`Map<string, ChunkLookupEntry[]>` and returns the **nested**
`Map<string, Map<string, ChunkSignalOverlay>>`. All of these are plain
structured-clone-safe data → cross the `postMessage` boundary unchanged.

Two implementations:

- **`InlineEnrichmentExecutor`** — calls `provider.streamFileBatch(...)` /
  `buildChunkSignals(...)` / `finalizeSignals(...)` directly on the main thread.
  This is _today's behavior_, extracted behind the interface. Used for: unit
  tests (no worker spawn → deterministic, fast), `direct` mode, small projects,
  and as the fallback when a provider declares no worker descriptor.
- **`WorkerPoolEnrichmentExecutor`** — reads `provider.workerDescriptor`,
  serializes the call into a request message, and dispatches it to the generic
  pool (routing by `routingKey` for affinity). The provider **instance** is
  never sent — only its descriptor (module path + method + serializable args).

**Independence from base implementation:** swapping Inline ↔ WorkerPool ↔ a
future ProcessPool/remote executor is a one-line DI change in the factory; no
coordinator/phase code changes.

### 2. Generic `WorkerPool<Req, Res>` — the unified mechanism

Extracted from `ChunkerPool` so chunking and enrichment share ONE mechanism (no
two divergent pools).

```ts
// ingest infra (e.g. src/core/domains/ingest/pipeline/infra/worker-pool.ts)
class WorkerPool<Req, Res> {
  constructor(
    poolSize: number,
    workerPath: string, // compiled build/...worker.js for THIS consumer
    workerData: unknown, // consumer-specific init (incl. module paths)
  );
  dispatch(request: Req, routingKey?: string): Promise<Res>;
  shutdown(): Promise<void>;
}
```

Generalizations over `ChunkerPool`:

- Generic `<Req, Res>` message types instead of fixed chunk request/response.
- **`routingKey` affinity:** when present, the pool pins that key to one worker
  for the key's lifetime (`Map<routingKey, workerIndex>`); subsequent dispatches
  with the same key always go to that worker. When absent, round-robin to any
  free worker (today's chunker behavior).
- Lifecycle (busy/queue/shutdown/error) is unchanged from `ChunkerPool`.

`ChunkerPool` becomes a thin consumer
(`new WorkerPool(size, chunkerWorkerPath, chunkerConfig)`), preserving its
public `processFile` surface. This is a behavior-preserving refactor — no
chunking change.

**Distribution logic lives in the pool; policy mapping lives in the executor.**
The pool owns the _mechanics_ of distribution — free-worker selection,
round-robin, the affinity map (`routingKey → workerIndex`, pin + reserve),
busy-tracking, overflow queue, shutdown — and stays trajectory-agnostic: it only
sees `(request, routingKey?)` and decides "key present → affinity, absent →
round-robin." The `WorkerPoolEnrichmentExecutor` owns the _policy_: it reads
`descriptor.dispatch` and translates it to a pool call — `"collection-affinity"`
→ `routingKey = collectionName`; `"stateless"` → no `routingKey`. The chunker
consumer calls the pool with no `routingKey` at all. This split is what keeps
the pool reusable and decoupled from enrichment and from any specific
trajectory.

### 3. `WorkerEnrichmentDescriptor` — per-trajectory worker behavior (Open/Closed seam)

Each trajectory **declares** how its enrichment runs on the pool. Adding a new
trajectory = implement the provider + declare a descriptor; the pool and
executor need **zero** changes.

```ts
// on EnrichmentProvider (contracts/types/provider.ts)
interface WorkerEnrichmentDescriptor {
  /** Absolute compiled-JS path; worker dynamic-imports it (DI rule). */
  providerModulePath: string;
  /** Named factory export the worker calls to build the provider in-thread. */
  providerFactoryExport: string;
  /** stateless → any free worker (git); collection-affinity → pinned (codegraph). */
  dispatch: "stateless" | "collection-affinity";
}

interface EnrichmentProvider {
  // ...existing: name, buildFileSignals, buildChunkSignals,
  //    streamFileBatch?, finalizeSignals?, defersChunkEnrichment?...
  readonly workerDescriptor?: WorkerEnrichmentDescriptor;
}
```

The provider **declares** its worker behavior (descriptor = data) but does NOT
**dispatch** it (executor = mechanism). Only `WorkerEnrichmentDescriptor` lives
on `EnrichmentProvider`; `EnrichmentExecutor` and `WorkerPool` are injected
infra and are deliberately kept OFF the provider. If the executor lived on the
provider, the provider would know whether it runs on the main thread or a worker
— breaking the Inline-for-tests path and the inline↔worker swappability. The
provider's methods are simply called (in-thread by Inline, in a worker by
WorkerPool) and it never distinguishes the two. In short: provider = declaration

- business logic; executor/pool = execution mechanism.

* **Absent `workerDescriptor`** → `WorkerPoolEnrichmentExecutor` runs that
  provider inline (graceful fallback → incremental migration).
* **git** → `dispatch: "stateless"`. File/chunk enrichment is per-file
  independent; any worker, parallel.
* **codegraph** → `dispatch: "collection-affinity"`,
  `routingKey = collectionName`. All of a collection's `streamFileBatch` +
  deferred `buildChunkSignals` + `finalizeSignals` route to ONE worker that
  holds the run sink / symbolTable / chunkSymbolByLine. State stays coherent;
  finalize reads the same accumulated state.

### 4. Enrichment worker entry

`pipeline/enrichment/infra/worker.ts` (compiled sibling `worker.js`):

- Receives request
  `{ providerModulePath, providerFactoryExport, method, root, paths?, chunkMap?, options }`.
- Lazily builds + **caches the provider in-thread**, keyed by
  `(providerModulePath, collectionName)` — via
  `(await import(providerModulePath))[providerFactoryExport](config)`. The
  cached instance is what makes affinity stateful: codegraph's run sink lives on
  it.
- Calls the named method; returns the overlay `Map` (plain, structured-clone
  safe — providers already return `Map<string, overlay>`).
- The in-thread provider owns its side resources: git spawns its own persistent
  `cat-file --batch`; codegraph connects to the DuckDB **daemon socket**
  (multi-client by design) for graph writes and holds its in-memory symbolTable
  on the cached instance.

### Domain boundaries preserved by module-path DI

`.claude/rules/domain-boundaries.md` forbids `domains/ingest` from importing
`domains/trajectory`. The enrichment worker lives in `ingest` but runs git /
codegraph providers (in `trajectory`). The module-path DI rule is exactly what
keeps the boundary intact: the worker receives `providerModulePath` as a runtime
STRING through `workerData` and `dynamic-import`s it — there is **no literal
import specifier** for the leaf-domain eslint guard to flag, and no static
`ingest → trajectory` edge. This mirrors how the chunker worker loads
`domains/language` by injected path. The provider-factory paths are computed at
the composition root (`api/` / `factory.ts`, which is allowed to see all layers)
and threaded down; `ingest` only ever holds the opaque string.

## Data flow (after offload)

```
Coordinator.onChunksStored(batch)
  → executor.runFileBatch(gitProvider, root, paths)      [worker: any]
  → executor.runFileBatch(codegraphProvider, root, paths)[worker: collection-pinned]
        worker: provider.streamFileBatch → extract + DuckDB-daemon write
        returns overlay map (codegraph file ∅ until finalize; git per-batch)
  → main thread: EnrichmentApplier.set_payload(overlays)  [cheap async HTTP]
  → executor.runChunkBatch(gitProvider, ...)             [worker: any]
        (codegraph chunk deferred — accumulated, run post-finalize)

CompletionRunner
  → executor.runFinalize(codegraphProvider, root)        [SAME pinned worker]
        worker: sink.finish() + readFileOverlays
  → executor.runChunkBatch(codegraphProvider, deferredChunkMap) [SAME pinned worker]
  → main thread applies overlays to Qdrant; affinity released
```

Main thread keeps: orchestration + `set_payload` HTTP (async, not CPU). All
CPU + provider I/O is in workers → embedding HTTP no longer starved.

## Memory

Relocating extraction state (codegraph symbolTable, churn maps) into worker
heaps moves that allocation **out of the main process heap** and bounds it per
worker; affinity release / worker idle frees it. Combined with the existing
NDJSON spill this is expected to flatten the 800MB→1.5GB main-heap growth. This
is a secondary benefit — the headline fix is unblocking the event loop. Exact
memory behavior to be confirmed by live sampling after implementation; the
design does not depend on a specific number.

## Error handling

- Worker method throw → reject the dispatch promise → mapped to a typed
  `IngestError` subclass (per `.claude/rules/typed-errors.md`); the existing
  degraded-reconcile path (`markFileFinal` degraded) absorbs partial failures.
- Worker crash → mirror `ChunkerPool` (reject pending, no auto-respawn). An
  affinity worker crash loses that collection's in-flight codegraph run-state →
  that collection's codegraph enrichment fails → degraded reconcile; recoverable
  via re-index / the existing recovery scan. Documented, not silently retried.
- No `workerDescriptor` / pool unavailable (tests) → Inline executor; identical
  results, no spawn.

## Testing

- **Coordinator / phases:** unit-tested against `InlineEnrichmentExecutor` (DIP)
  — deterministic, no worker spawn. Existing tests keep working by injecting
  Inline.
- **Provider methods:** unit-tested directly (already are) — unchanged.
- **Generic `WorkerPool`:** behavior-preserving refactor verified by the
  existing `ChunkerPool` tests + a small affinity-routing unit test
  (`routingKey` → same worker).
- **`WorkerPoolEnrichmentExecutor` + enrichment worker entry:**
  integration-level (real worker, needs `build/`); excluded from line-coverage
  like the chunker pool / daemon glue (`**/infra/**/worker.ts` patterns already
  excluded).
- **Live validation:** taxdome incremental index — assert no embedding "ямы"
  (continuous `EMBED_CALL` cadence), bounded main-heap RSS, codegraph
  `resolveSuccessRate` unchanged from the per-collection-affinity guarantee.

## Migration path (incremental, each step independently testable)

1. **Extract `WorkerPool<Req,Res>`** from `ChunkerPool` (behavior-preserving;
   `ChunkerPool` delegates). Add `routingKey` affinity. Existing chunker tests
   green.
2. **Add `EnrichmentExecutor` + `InlineEnrichmentExecutor`**; wire
   coordinator/file-phase/chunk-phase/backfiller/recovery to call the executor
   instead of `provider.*` directly. No behavior change (inline == today). All
   enrichment tests green.
3. **Add `WorkerEnrichmentDescriptor`** to the provider contract; declare it on
   git (`stateless`) and codegraph (`collection-affinity`).
4. **Add the enrichment worker entry + `WorkerPoolEnrichmentExecutor`**; wire
   executor selection in `factory.ts` (config flag; default WorkerPool in
   daemon/server mode, Inline in tests/direct). Per `.claude/rules/wiring.md`:
   factory builds the executor → `IngestFacade` → `EnrichmentCoordinator`.
5. **Live-validate on taxdome**; tune `enrichmentPoolSize`.

## Wiring summary

| Adding        | Touch                                                                                   |
| ------------- | --------------------------------------------------------------------------------------- |
| Generic pool  | `pipeline/infra/worker-pool.ts` (+ `ChunkerPool` delegates)                             |
| Executor seam | `contracts/types/` (interface) + `pipeline/enrichment/executor/{inline,worker-pool}.ts` |
| Worker entry  | `pipeline/enrichment/infra/worker.ts`                                                   |
| Descriptor    | `contracts/types/provider.ts` + git/codegraph provider declarations                     |
| DI selection  | `bootstrap/factory.ts` → `IngestFacade` → `EnrichmentCoordinator`                       |

## Pool sizing & config (decided)

**One shared enrichment pool** of `enrichmentPoolSize` **worker_threads** (the
unit is threads — not processes, not cores). All trajectories dispatch to this
one pool; affinity (not separate pools) keeps codegraph coherent. The chunker
keeps its own `ChunkerPool` instance (same `WorkerPool` mechanism, different
worker entry) — the two pools share the mechanism, not the threads.

Worker allocation within the shared enrichment pool of size N:

- **codegraph → exactly 1 worker per active collection.** Because
  `streamFileBatch` (file), `finalizeSignals` (file), and the deferred
  `buildChunkSignals` (chunk) for one collection all read the SAME accumulated
  run-state (`symbolTable`, `chunkSymbolByLine`, run sink) held on one worker's
  in-thread provider instance, file + chunk + finalize MUST share that one
  affinity worker. There is no file-worker/chunk-worker split — splitting them
  would re-fragment the run-state (the daemon-symbolTable bug class fixed in
  commit `a32b553a`, but across threads). Codegraph parallelism therefore exists
  only **across collections** (concurrent multi-project indexing pins one worker
  each); a single reindex uses exactly 1 codegraph worker.
- **git → stateless, fans across the remaining workers.** git file/chunk
  enrichment is per-file independent, so it round-robins across free workers.
  During a codegraph-enabled run, git's effective parallelism is `N - 1`
  (codegraph reserves one).

So `N` is sized for git's stateless fan-out; codegraph just occupies one slot.

### Config

TWO new knobs in the existing `ingest.tune` namespace, alongside
`chunkerPoolSize` — an explicit MODE flag and a SEPARATE size knob (the mode is
NOT overloaded onto the size):

- `ingest.tune.enrichmentExecutor: "inline" | "worker"` — selects the
  `EnrichmentExecutor` implementation (name matches the type so the flag is
  self-describing). `"inline"` → `InlineEnrichmentExecutor` (main thread,
  today's behavior); `"worker"` → `WorkerPoolEnrichmentExecutor`. env:
  `INGEST_TUNE_ENRICHMENT_EXECUTOR` / `ENRICHMENT_EXECUTOR`. **Default:**
  `"inline"` until the worker path is live-validated, then flipped to
  `"worker"`.
- `ingest.tune.enrichmentPoolSize` — number of enrichment worker threads,
  consulted ONLY when `enrichmentExecutor === "worker"`. env:
  `INGEST_TUNE_ENRICHMENT_POOL_SIZE` / `ENRICHMENT_POOL_SIZE`. **Default:**
  `max(1, floor(availableParallelism() / 2))` (leaves cores for the embedding
  HTTP loop + chunker pool), floored at 1; flat fallback 4 (mirroring
  `chunkerPoolSize`) if cores can't be read.

Why a string flag, not `enrichmentPoolSize === 0`: overloading the size knob as
the on/off switch is opaque (a reader can't tell `0` means "inline"). A typed
`"inline" | "worker"` enum reads unambiguously and keeps the two concerns —
WHICH executor vs HOW MANY threads — independent.

Pool size is a **static start value** in this design. Runtime-adaptive sizing
(grow/shrink by embedding-loop pressure, queue depth, latency) is deferred to
follow-up `tea-rags-mcp-nqg9` (P4) — it must respect the codegraph affinity
invariant (never migrate a pinned collection mid-run).

The existing in-process concurrency knobs are NOT replaced by the pool — they
become **per-worker inner concurrency**:

- `gitChunkConcurrency` / `CHUNK_ENRICHMENT_CONCURRENCY` (currently the
  main-thread `Semaphore(10)` in `chunk-phase.ts` + the git provider's
  `Promise.all` blame concurrency) stay as the concurrency _inside_ a single
  worker (e.g. concurrent `git blame` subprocess calls within the git worker).
  Pool size governs cross-thread parallelism; these govern in-thread I/O
  concurrency. They are complementary, not redundant.
