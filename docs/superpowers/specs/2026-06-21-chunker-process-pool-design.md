# Chunker Process Pool — Pluggable Worker Transport

**Date:** 2026-06-21 **Status:** Approved (design) **Related:** yl9tv
(single-parser-thread codegraph reuse), bd memory
`tree-sitter-not-thread-safe-process-global`

## Problem

`node-tree-sitter` is a native NAPI addon. Its `.node` binary is `dlopen`'d once
per process and its C++ file-scope statics are shared across **all**
`worker_threads` in that process (one address space). Independent `new Parser()`
instances do **not** isolate it. Concurrent `parse()` from any two threads
(worker-vs-worker or worker-vs-main) corrupts the parse tree — the same file
yields a variable AST, the Ruby walker emits a non-deterministic call count, and
under load the addon crashes with `Napi::Error`.

The chunker runs `ChunkerPool` over a `worker_threads` pool. At
`chunkerPoolSize > 1` this is exactly the corrupting configuration: N worker
threads parsing concurrently in one process. Symptoms observed in production:
codegraph `callsAttempted` / `resolveSuccessRate` jitter run-to-run, and latent
non-determinism in the chunks themselves (masked in tests by
`CHUNKER_POOL_SIZE=1`).

### Empirical confirmation (spike, 2026-06-21)

A standalone spike parsed a fixed Ruby source N times concurrently and compared
each parse's signature (node count + rolling type hash) against a single-thread
baseline:

| Model                             | Config                   | Result                                      |
| --------------------------------- | ------------------------ | ------------------------------------------- |
| `child_process` (separate dlopen) | SAME source, 2 workers   | 4000 parses, **0 deviations**, 1 signature  |
| `child_process` (separate dlopen) | A + B sources, 2 workers | 4000 parses, **0 deviations**, clean        |
| `node:worker_threads`             | concurrent parse         | **hang / crash** — never completes (3 runs) |

8000 concurrent parses across separate processes produced zero corruption and
full determinism. The thread model could not complete a concurrent parse at all.
**Verdict:** only separate processes (separate `dlopen`, separate native
statics) isolate `node-tree-sitter`. The original design intent — "worker =
process" — was correct; the regression into `worker_threads` is the root cause.

## Goal

Restore both **parallelism** (N parallel parse workers) and **determinism** for
the chunker — the single parse site that feeds both Qdrant chunks and codegraph
`FileExtraction` (yl9tv) — by running its workers as child **processes** instead
of threads.

## Approach: Pluggable transport in the dispatch pool

The generic pool (`pipeline/infra/thread-pool.ts`, today `ThreadPool<Req,Res>`)
is shared by **two** consumers:

1. `ChunkerPool` — stateless, round-robin, the tree-sitter parse site.
2. The enrichment executor (`enrichment/executor/worker-pool.ts`) — stateful,
   affinity-pinned per collection, holds a DuckDB connection + symbol table, and
   parses only residually (`extractOneFile` on the incremental `reindex_changes`
   path).

Rather than fork a second pool class, the pool becomes **transport-agnostic**:
it owns only the distribution mechanics (free-worker selection, round-robin,
routingKey affinity, overflow queue, graceful shutdown) and receives a
`WorkerTransport` by DI. Two transports — threads and processes — let each
consumer pick. The chunker opts into the process transport; the enrichment
executor keeps the thread transport (zero behavior change for its DuckDB +
affinity path).

The conversion is **two-sided**: the pool side spawns/ messages workers, and the
worker entry (`chunker/infra/worker.ts`) currently reads `workerData` /
`parentPort` directly — neither exists in a forked process. Both sides get a
transport abstraction.

### Alternatives considered

- **ProcessPool peer (chunker-only, separate class).** Smaller blast radius, but
  duplicates the queue/shutdown mechanics. Rejected in favor of the DRY
  pluggable transport.
- **WASM (`web-tree-sitter`).** Per-instance linear memory isolates even in
  threads, so processes would be unnecessary. Largest dependency/API change, not
  spiked. Deferred to a separate epic.

## §1. Naming

`ThreadPool` → **`WorkerDispatchPool`**. It dispatches requests to a pool of
workers over an injected transport, with optional affinity. The name
`WorkerPool` is already taken by the legacy in-process embedding retry/backoff
executor; `DispatchPool` reflects the distribution mechanics that are now the
class's sole responsibility. Touches the two importers (`ChunkerPool`,
enrichment executor) plus tests. Per `.claude/rules/naming.md`, the old name is
a misnomer once the class runs processes.

## §2. Pool side — `WorkerTransport`

New interface in `pipeline/infra/` — the minimal common denominator of
`worker_threads` and `child_process`:

```ts
interface WorkerTransport<Req, Res> {
  // thread:  new Worker(path, { workerData: init })
  // process: fork(path); handle.send({ __init: init })
  spawn(init: unknown): WorkerHandle<Req, Res>;
}

interface WorkerHandle<Req, Res> {
  post(request: Req): void; // postMessage | process.send
  onMessage(cb: (m: Res | { error: string }) => void): void; // worker.on('message') | child.on('message')
  onError(cb: (e: Error) => void): void;
  onExit(cb: () => void): void;
  shutdown(): void; // post {type:"shutdown"}, unref
  terminate(): Promise<void>; // force: worker.terminate() | child.kill()
}
```

`WorkerDispatchPool` takes `transport: WorkerTransport` in its constructor and
replaces every direct `Worker` touch (`new Worker`, `.postMessage`, `.on`,
`.terminate`, `.unref`, `.once("exit")`) with `handle.*` calls. The queue,
affinity, and `processQueue` logic are **unchanged** — only the source of
workers differs. Two implementations: `ThreadTransport`, `ProcessTransport`
(`fork`, Node IPC, JSON serialization — the protocol is already
JSON-serializable, see §3).

### Shutdown nuance

The current graceful shutdown posts `{type:"shutdown"}` so the worker closes its
`parentPort` and lets tree-sitter NAPI destructors run in the correct thread
(otherwise `terminate()` triggers a `libc++abi` crash). This is
**thread-specific** — in a process, `exit()` reclaims everything and there is no
crash.

- `ThreadTransport.shutdown` keeps the current logic (post shutdown, 2s timeout
  → `terminate()`).
- `ProcessTransport.shutdown` is simpler: `disconnect()` + `exit(0)`, SIGKILL
  fallback on timeout.

## §3. Worker side — `WorkerRuntime`

`chunker/infra/worker.ts` reads `workerData` + `parentPort` directly. In a fork,
`parentPort === null` and messaging is `process.on('message')` / `process.send`.
A symmetric worker-side adapter:

```ts
interface WorkerRuntime<TInit, Req, Res> {
  init(): Promise<TInit>; // thread: workerData; process: await first {__init} IPC message
  onRequest(cb: (req: Req) => void): void; // parentPort.on('message') | process.on('message')
  respond(res: Res): void; // parentPort.postMessage | process.send
  onShutdown(cb: () => void): void;
}
```

The entrypoint picks the implementation by `isMainThread` from
`node:worker_threads` — `false` inside a worker thread, `true` inside a forked
process. **One** `worker.ts` entry; the engine (`buildChunker` + walker) is
unchanged. Only the messaging wrapper differs. `languageModulePath` injection is
preserved: thread via `workerData`, process via the first `{__init}` message.

The wire protocol (`worker-protocol.ts`) is already structurally cloneable and
JSON-serializable, so it crosses `fork` IPC unchanged:

- `WorkerRequest { filePath, code, language, emitExtraction? }`
- `WorkerResponse { filePath, chunks, extraction?, error? }`

## §4. Wiring

- `ChunkerPool` →
  `new WorkerDispatchPool(size, new ProcessTransport(WORKER_PATH))`,
  `init = { ...config, languageModulePath }` (shape unchanged).
- Enrichment executor → `new ThreadTransport(...)` **by default** — zero
  behavior change; DuckDB + affinity + symbol table stay in-process. Its
  residual `extractOneFile` parse on the incremental path no longer races the
  chunker (now a separate process). Eliminating that parse entirely is a
  follow-up.
- `INGEST_TUNE_CHUNKER_POOL_SIZE`: Task-4 dropped the default to `1` as the
  thread-unsafety stopgap. With processes the parallelism is safe again →
  restore the default to `min(4, cpus - 1)`. Memory cost: N node processes ×
  (tree-sitter + language module) — heavier than threads, accepted in exchange
  for parallel, deterministic parsing.

## §5. Errors / lifecycle / backpressure

- Queue and backpressure: unchanged (overflow queue in the pool).
- Child crash: `onExit` / `onError` → reject the in-flight pending (mirrors the
  current `worker.on("error")` path).
- **No auto-respawn.** The current pool does not restart a dead thread (it
  rejects and leaves the slot); this is preserved (YAGNI). Processes fail
  differently (OOM-kill, segfault), so auto-respawn is recorded as an explicit
  follow-up, not built now.

## §6. Testing

- **Unit:** `WorkerDispatchPool` against a fake `WorkerTransport` (in-memory
  handle) — affinity / queue / shutdown without real threads or processes.
  Existing pool business tests move onto the fake transport; they are **not**
  rewritten.
- **Determinism (spike formalized):** run the chunker on a process pool (size 4)
  over N iterations of one Ruby file → identical chunks + extraction (0
  deviations). TDD anchor: red on threads, green on processes.
- **Integration (live, mandatory):** `force_reindex tea-rags` ×2 (stable
  `callsAttempted`) + `reindex_changes` ×2 (no regression) — same dual-path
  validation as yl9tv Task 5b.

## Affected files

| File                                        | Change                                                           |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `pipeline/infra/thread-pool.ts`             | rename → `worker-dispatch-pool.ts`; take `WorkerTransport` by DI |
| `pipeline/infra/worker-transport.ts` (new)  | `WorkerTransport` / `WorkerHandle` interfaces                    |
| `pipeline/infra/thread-transport.ts` (new)  | `ThreadTransport` (current `new Worker` logic)                   |
| `pipeline/infra/process-transport.ts` (new) | `ProcessTransport` (`fork` + IPC)                                |
| `pipeline/infra/worker-runtime.ts` (new)    | `WorkerRuntime` + thread/process implementations                 |
| `chunker/infra/pool.ts`                     | wire `ProcessTransport`                                          |
| `chunker/infra/worker.ts`                   | use `WorkerRuntime` instead of raw `parentPort` / `workerData`   |
| `enrichment/executor/worker-pool.ts`        | wire `ThreadTransport` (default, no behavior change)             |
| config / env defaults                       | restore chunker pool size default to `min(4, cpus - 1)`          |
| tests (pool + chunker)                      | fake transport for unit; determinism + integration tests         |

## Follow-ups (not in this epic)

- Route the enrichment executor's residual `extractOneFile` parse through the
  chunker process pool (single parse mechanism everywhere).
- Auto-respawn of a crashed child process.
- WASM (`web-tree-sitter`) evaluation as a thread-safe alternative.
