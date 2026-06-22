# Chunker Process Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the chunker's parse workers as child **processes** (not
`worker_threads`) so concurrent `tree-sitter` parses are isolated, restoring
both parallelism and determinism — via a pluggable `WorkerTransport` injected
into the (renamed) dispatch pool.

**Architecture:** The generic `ThreadPool<Req,Res>`
(`pipeline/infra/thread-pool.ts`) becomes transport-agnostic
`WorkerDispatchPool<Req,Res>`: it keeps all distribution mechanics (free-worker
selection, round-robin, routingKey affinity, overflow queue, graceful shutdown)
and receives a `WorkerTransport` by DI. `ThreadTransport` wraps `worker_threads`
(current behavior); `ProcessTransport` wraps `child_process.fork` (the isolating
path). A symmetric worker-side `WorkerRuntime` lets the single
`chunker/infra/worker.ts` entry run under either transport, picked by
`isMainThread`. The chunker uses `ProcessTransport`; the enrichment executor
keeps `ThreadTransport` (zero behavior change).

**Tech Stack:** TypeScript (ESM, NodeNext), `node:worker_threads`,
`node:child_process`, vitest. Spec:
`docs/superpowers/specs/2026-06-21-chunker-process-pool-design.md`.

## Global Constraints

- **No `eslint-disable`, no lowering coverage thresholds, no linter-config
  edits.** Fix the code.
- **Business-logic tests are immutable.** Moving a test file-to-file and
  adapting imports/setup is allowed; adding new tests is allowed; rewriting the
  assertions/examples of a passing business-logic test is NOT.
- **Domain boundaries.** `domains/ingest` MUST NOT statically import
  `domains/language`. The worker loads the language module via a runtime dynamic
  `import(languageModulePath)` (injected string). Preserve this — no static
  import, no guard exemption.
- **Typed errors.** Programming-invariant violations (e.g. "pool not started")
  may use plain `Error`; everything else uses the typed hierarchy. The existing
  pool uses `PipelineNotStartedError` — preserve.
- **Naming rule.** Domain-qualified, unambiguous in isolation. The new pool is
  `WorkerDispatchPool` (not `WorkerPool` — taken by the legacy embedding
  executor).
- **Wire protocol stays JSON-serializable.** `WorkerRequest`/`WorkerResponse`
  already are; do not introduce non-cloneable fields.
- **Build green at every Task boundary.** Each Task ends with `npm run build` +
  the relevant tests passing. The chunker worker tests load **compiled**
  `build/.../worker.js`, so run `npm run build` before any test that exercises a
  real worker.
- **Commit conventions.** Conventional commits, scope `chunker` or `pipeline`
  (minor-bumping). End commit messages with the
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
  trailer. Do NOT push.
- **Branch:** `worktree-chunker-process-pool` (off merged main `befc06f8`).

---

## File Structure

| File                                                                                          | Responsibility                                                                                    |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/core/domains/ingest/pipeline/infra/worker-transport.ts` (NEW)                            | `WorkerTransport<Req,Res>` + `WorkerHandle<Req,Res>` interfaces + the shutdown-message constant.  |
| `src/core/domains/ingest/pipeline/infra/thread-transport.ts` (NEW)                            | `ThreadTransport` — wraps `new Worker(...)`; the current pool's worker_threads logic.             |
| `src/core/domains/ingest/pipeline/infra/process-transport.ts` (NEW)                           | `ProcessTransport` — wraps `fork(...)` + Node IPC + `{__init}` injection.                         |
| `src/core/domains/ingest/pipeline/infra/worker-runtime.ts` (NEW)                              | Worker-side `WorkerRuntime` interface + `ThreadWorkerRuntime` + `ProcessWorkerRuntime`.           |
| `src/core/domains/ingest/pipeline/infra/thread-pool.ts` → rename to `worker-dispatch-pool.ts` | `WorkerDispatchPool<Req,Res>` — distribution mechanics over an injected `WorkerTransport`.        |
| `src/core/domains/ingest/pipeline/chunker/infra/pool.ts` (MODIFY)                             | `ChunkerPool` wires `ProcessTransport`.                                                           |
| `src/core/domains/ingest/pipeline/chunker/infra/worker.ts` (MODIFY)                           | Use `WorkerRuntime` (`isMainThread`-dispatched) instead of raw `parentPort`/`workerData`.         |
| `src/core/domains/ingest/pipeline/enrichment/executor/worker-pool.ts` (MODIFY)                | `WorkerPoolEnrichmentExecutor` wires `ThreadTransport` (behavior identical).                      |
| `src/core/domains/ingest/pipeline/base.ts:54` (MODIFY)                                        | `DEFAULT_TUNING.chunkerPoolSize` 1 → computed `min(4, cpus-1)`.                                   |
| `src/bootstrap/config/schemas.ts:72` (MODIFY)                                                 | `chunkerPoolSize` default 1 → computed `min(4, cpus-1)`.                                          |
| tests under `tests/core/domains/ingest/pipeline/infra/` and `.../chunker/infra/`              | Generic-pool unit tests run on a `FakeWorkerTransport`; new ProcessTransport + determinism tests. |

---

## Task 1: WorkerTransport interfaces + ThreadTransport

Additive only — no existing file changes. Extract the current `new Worker(...)`
mechanics into a `ThreadTransport` behind a `WorkerTransport` interface. After
this Task the interface exists and is unit-tested, but nothing consumes it yet.

**Files:**

- Create: `src/core/domains/ingest/pipeline/infra/worker-transport.ts`
- Create: `src/core/domains/ingest/pipeline/infra/thread-transport.ts`
- Test: `tests/core/domains/ingest/pipeline/infra/thread-transport.test.ts`

**Interfaces:**

- Produces:
  - `SHUTDOWN_MESSAGE = { type: "shutdown" } as const` and
    `type ShutdownMessage = typeof SHUTDOWN_MESSAGE`
  - `interface WorkerHandle<Req, Res>` with `post(req: Req): void`,
    `onMessage(cb: (m: Res | { error: string }) => void): void`,
    `onError(cb: (e: Error) => void): void`, `onExit(cb: () => void): void`,
    `shutdown(): void`, `terminate(): Promise<void>`
  - `interface WorkerTransport<Req, Res>` with
    `spawn(init: unknown): WorkerHandle<Req, Res>`
  - `class ThreadTransport<Req, Res> implements WorkerTransport<Req, Res>` —
    constructed with `workerPath: string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/domains/ingest/pipeline/infra/thread-transport.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ThreadTransport } from "../../../../../../src/core/domains/ingest/pipeline/infra/thread-transport.js";

// A trivial worker that echoes { n } -> { doubled } and exits on shutdown.
const WORKER_SRC = `
import { parentPort, workerData } from "node:worker_threads";
parentPort.on("message", (m) => {
  if (m && m.type === "shutdown") { parentPort.close(); return; }
  parentPort.postMessage({ doubled: m.n * 2, base: workerData.base });
});
`;

describe("ThreadTransport", () => {
  const dir = mkdtempSync(join(tmpdir(), "tt-"));
  const workerPath = join(dir, "echo-worker.mjs");
  writeFileSync(workerPath, WORKER_SRC, "utf8");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("spawns a worker, injects init as workerData, round-trips a message, and shuts down", async () => {
    const transport = new ThreadTransport<
      { n: number },
      { doubled: number; base: number }
    >(workerPath);
    const handle = transport.spawn({ base: 10 });
    const got = await new Promise<{ doubled: number; base: number }>(
      (resolve, reject) => {
        handle.onMessage((m) =>
          resolve(m as { doubled: number; base: number }),
        );
        handle.onError(reject);
        handle.post({ n: 21 });
      },
    );
    expect(got.doubled).toBe(42);
    expect(got.base).toBe(10);
    const exited = new Promise<void>((resolve) => handle.onExit(resolve));
    handle.shutdown();
    await exited;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/infra/thread-transport.test.ts`
Expected: FAIL — cannot find module `thread-transport.js`.

- [ ] **Step 3: Write the interfaces**

```ts
// src/core/domains/ingest/pipeline/infra/worker-transport.ts
/**
 * Pluggable worker transport for WorkerDispatchPool. Abstracts the difference
 * between node:worker_threads and child_process.fork so the pool's distribution
 * mechanics stay transport-agnostic. tree-sitter's native parse is
 * process-globally thread-unsafe, so the chunker uses the process transport;
 * the enrichment executor keeps the thread transport.
 */

/** Graceful-shutdown control message posted to a worker before termination. */
export const SHUTDOWN_MESSAGE = { type: "shutdown" } as const;
export type ShutdownMessage = typeof SHUTDOWN_MESSAGE;

/** A live worker (thread or process) the pool dispatches to. */
export interface WorkerHandle<Req, Res> {
  /** Send one request to the worker. */
  post(request: Req): void;
  /** Register the single result/error-envelope listener. */
  onMessage(cb: (message: Res | { error: string }) => void): void;
  /** Register the transport-error listener. */
  onError(cb: (error: Error) => void): void;
  /** Register the exit listener (fires once the worker has terminated). */
  onExit(cb: () => void): void;
  /** Graceful shutdown: post SHUTDOWN_MESSAGE and unref so the worker can exit cleanly. */
  shutdown(): void;
  /** Forceful termination, used as a timeout fallback after shutdown(). */
  terminate(): Promise<void>;
}

/** Factory for worker handles. The pool owns poolSize/name; the transport owns the spawn mechanics. */
export interface WorkerTransport<Req, Res> {
  /** Spawn one worker, passing `init` as its serializable init payload (workerData | {__init} message). */
  spawn(init: unknown): WorkerHandle<Req, Res>;
}
```

- [ ] **Step 4: Write ThreadTransport**

```ts
// src/core/domains/ingest/pipeline/infra/thread-transport.ts
import { Worker } from "node:worker_threads";

import {
  SHUTDOWN_MESSAGE,
  type WorkerHandle,
  type WorkerTransport,
} from "./worker-transport.js";

/**
 * node:worker_threads transport — the pool's original spawn mechanics. `init`
 * is passed as `workerData`. Graceful shutdown posts SHUTDOWN_MESSAGE so the
 * worker can close its parentPort and let tree-sitter NAPI destructors run in
 * the correct thread (avoiding the libc++abi crash a bare terminate() causes).
 */
export class ThreadTransport<Req, Res> implements WorkerTransport<Req, Res> {
  constructor(private readonly workerPath: string) {}

  spawn(init: unknown): WorkerHandle<Req, Res> {
    const worker = new Worker(this.workerPath, { workerData: init });
    return {
      post: (request) => worker.postMessage(request),
      onMessage: (cb) => worker.on("message", cb),
      onError: (cb) => worker.on("error", cb),
      onExit: (cb) => worker.once("exit", () => cb()),
      shutdown: () => {
        worker.unref();
        worker.postMessage(SHUTDOWN_MESSAGE);
      },
      terminate: async () => {
        await worker.terminate();
      },
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:
`npm run build && npx vitest run tests/core/domains/ingest/pipeline/infra/thread-transport.test.ts`
Expected: PASS (2 assertions + clean exit).

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/pipeline/infra/worker-transport.ts \
        src/core/domains/ingest/pipeline/infra/thread-transport.ts \
        tests/core/domains/ingest/pipeline/infra/thread-transport.test.ts
git commit -m "feat(pipeline): WorkerTransport interface + ThreadTransport (additive)"
```

---

## Task 2: Rename ThreadPool → WorkerDispatchPool over WorkerTransport; rewire both importers

Atomic refactor. The pool stops touching `Worker` directly and takes a
`WorkerTransport` by DI. Both importers (`ChunkerPool`, enrichment executor) are
updated in THIS Task to construct a `ThreadTransport` — behavior is
byte-identical (still threads). High blast radius: `thread-pool.ts` has fanIn=2;
the rename + both call sites must land together or the build breaks.

**Files:**

- Rename + rewrite: `src/core/domains/ingest/pipeline/infra/thread-pool.ts` →
  `src/core/domains/ingest/pipeline/infra/worker-dispatch-pool.ts`
- Modify: `src/core/domains/ingest/pipeline/chunker/infra/pool.ts` (import +
  construct `ThreadTransport`)
- Modify:
  `src/core/domains/ingest/pipeline/enrichment/executor/worker-pool.ts:47,95`
  (import + construct `ThreadTransport`)
- Modify: any barrel that re-exports `ThreadPool` (check
  `pipeline/infra/index.ts`)
- Move + adapt: existing generic-pool unit tests under
  `tests/core/domains/ingest/pipeline/infra/` (locate the `ThreadPool` spec)
  onto a `FakeWorkerTransport`
- Create:
  `tests/core/domains/ingest/pipeline/infra/__helpers__/fake-worker-transport.ts`

**Interfaces:**

- Consumes: `WorkerTransport`, `WorkerHandle`, `SHUTDOWN_MESSAGE` (Task 1);
  `ThreadTransport` (Task 1).
- Produces:
  - `class WorkerDispatchPool<Req, Res>` — constructor
    `(poolSize: number, transport: WorkerTransport<Req, Res>, init: unknown, name = "WorkerDispatchPool")`.
    Public API UNCHANGED from `ThreadPool`:
    `dispatch(request, routingKey?): Promise<Res>`,
    `releaseAffinity(routingKey): void`, `shutdown(): Promise<void>`.
  - `FakeWorkerTransport<Req, Res>` test helper — synchronous in-memory handles
    whose responder is settable per test.

- [ ] **Step 1: Write the FakeWorkerTransport helper**

```ts
// tests/core/domains/ingest/pipeline/infra/__helpers__/fake-worker-transport.ts
import type {
  WorkerHandle,
  WorkerTransport,
} from "../../../../../../../src/core/domains/ingest/pipeline/infra/worker-transport.js";

/**
 * In-memory transport for pool unit tests — no real threads/processes. Each
 * spawned handle records posted requests and lets the test resolve them via the
 * injected `respond` fn (called on the next microtask to mimic async delivery).
 */
export class FakeWorkerTransport<Req, Res> implements WorkerTransport<
  Req,
  Res
> {
  readonly handles: FakeHandle<Req, Res>[] = [];
  constructor(
    private readonly respond: (
      req: Req,
      index: number,
    ) => Res | { error: string },
  ) {}

  spawn(init: unknown): WorkerHandle<Req, Res> {
    const handle = new FakeHandle<Req, Res>(
      this.handles.length,
      init,
      this.respond,
    );
    this.handles.push(handle);
    return handle;
  }
}

export class FakeHandle<Req, Res> implements WorkerHandle<Req, Res> {
  readonly posted: Req[] = [];
  private msgCb?: (m: Res | { error: string }) => void;
  private exitCb?: () => void;
  constructor(
    readonly index: number,
    readonly init: unknown,
    private readonly responder: (
      req: Req,
      index: number,
    ) => Res | { error: string },
  ) {}
  post(request: Req): void {
    this.posted.push(request);
    queueMicrotask(() => this.msgCb?.(this.responder(request, this.index)));
  }
  onMessage(cb: (m: Res | { error: string }) => void): void {
    this.msgCb = cb;
  }
  onError(): void {
    /* fakes never raise transport errors */
  }
  onExit(cb: () => void): void {
    this.exitCb = cb;
  }
  shutdown(): void {
    queueMicrotask(() => this.exitCb?.());
  }
  async terminate(): Promise<void> {
    this.exitCb?.();
  }
}
```

- [ ] **Step 2: Move the generic-pool spec onto the fake transport (write
      failing)**

Locate the existing `ThreadPool` unit test under
`tests/core/domains/ingest/pipeline/infra/` (e.g. `thread-pool.test.ts`). Rename
it to `worker-dispatch-pool.test.ts`, update the import to `WorkerDispatchPool`,
and construct the pool with `FakeWorkerTransport` instead of a real worker path.
Preserve every existing `it`/`describe` example (affinity pinning, round-robin,
overflow queue drain, shutdown-rejects-queued). Example shape for one preserved
case:

```ts
import { describe, expect, it } from "vitest";

import { WorkerDispatchPool } from "../../../../../../src/core/domains/ingest/pipeline/infra/worker-dispatch-pool.js";
import { FakeWorkerTransport } from "./__helpers__/fake-worker-transport.js";

describe("WorkerDispatchPool", () => {
  it("round-robins stateless dispatch and resolves each request", async () => {
    const transport = new FakeWorkerTransport<{ n: number }, { r: number }>(
      (req) => ({ r: req.n + 1 }),
    );
    const pool = new WorkerDispatchPool<{ n: number }, { r: number }>(
      2,
      transport,
      { base: 1 },
    );
    const results = await Promise.all([
      pool.dispatch({ n: 1 }),
      pool.dispatch({ n: 2 }),
    ]);
    expect(results.map((x) => x.r)).toEqual([2, 3]);
    expect(transport.handles).toHaveLength(2);
    expect(transport.handles[0].init).toEqual({ base: 1 });
    await pool.shutdown();
  });
});
```

Run:
`npx vitest run tests/core/domains/ingest/pipeline/infra/worker-dispatch-pool.test.ts`
Expected: FAIL — `worker-dispatch-pool.js` not found.

- [ ] **Step 3: Rename + rewrite the pool to consume the transport**

Rename the file
(`git mv src/core/domains/ingest/pipeline/infra/thread-pool.ts src/core/domains/ingest/pipeline/infra/worker-dispatch-pool.ts`).
Then: rename the class to `WorkerDispatchPool`; replace the
`PoolThread.worker: Worker` field with `handle: WorkerHandle<Req, Res>`; change
the constructor signature to
`(poolSize, transport: WorkerTransport<Req, Res>, init: unknown, name = "WorkerDispatchPool")`;
replace `initThreads`'s `new Worker(...)` with `this.transport.spawn(this.init)`
and register callbacks via `handle.onMessage/onError`; replace `dispatchTo`'s
`pt.worker.postMessage(request)` with `pt.handle.post(request)`; replace
`shutdown`'s
`worker.postMessage({type:"shutdown"})/unref/terminate/once("exit")` with
`handle.shutdown()/handle.onExit/handle.terminate()`. Keep the queue, affinity
(`resolveAffinity`, `findFreeStatelessThread`, `processQueue`), and
`PipelineNotStartedError` logic verbatim.

Key structural edits (apply to the renamed file):

```ts
import { PipelineNotStartedError } from "../../errors.js";
import { isDebug } from "./runtime.js";
import type { WorkerHandle, WorkerTransport } from "./worker-transport.js";

interface PoolThread<Req, Res> {
  handle: WorkerHandle<Req, Res>;
  busy: boolean;
  pending: Pending<Res> | null;
  index: number;
}

export class WorkerDispatchPool<Req, Res> {
  // ...fields unchanged (threads/queue/affinity/isShutdown)...
  constructor(
    private readonly poolSize: number,
    private readonly transport: WorkerTransport<Req, Res>,
    private readonly init: unknown,
    private readonly name = "WorkerDispatchPool",
  ) {
    this.initThreads();
  }

  private initThreads(): void {
    for (let i = 0; i < this.poolSize; i++) {
      const handle = this.transport.spawn(this.init);
      const pt: PoolThread<Req, Res> = {
        handle,
        busy: false,
        pending: null,
        index: i,
      };
      handle.onMessage((message) => {
        const { pending } = pt;
        pt.busy = false;
        pt.pending = null;
        if (pending) {
          if (
            message &&
            typeof message === "object" &&
            "error" in message &&
            (message as { error: string }).error
          ) {
            pending.reject(
              new Error(
                `Worker error: ${(message as { error: string }).error}`,
              ),
            );
          } else {
            pending.resolve(message as Res);
          }
        }
        this.processQueue();
      });
      handle.onError((error) => {
        const { pending } = pt;
        pt.busy = false;
        pt.pending = null;
        if (pending) pending.reject(error);
        this.processQueue();
      });
      this.threads.push(pt);
    }
  }

  private dispatchTo(
    pt: PoolThread<Req, Res>,
    request: Req,
    pending: Pending<Res>,
  ): void {
    pt.busy = true;
    pt.pending = pending;
    pt.handle.post(request);
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
    for (const { pending } of this.queue)
      pending.reject(new Error(`${this.name} shutting down`));
    this.queue = [];
    await Promise.all(
      this.threads.map(
        (pt) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(
              () => void pt.handle.terminate().then(resolve),
              2000,
            );
            pt.handle.onExit(() => {
              clearTimeout(timer);
              resolve();
            });
            pt.handle.shutdown();
          }),
      ),
    );
    this.threads.length = 0;
  }
}
```

(`dispatch`, `releaseAffinity`, `resolveAffinity`, `findFreeStatelessThread`,
`processQueue` keep their existing bodies — they reference
`busy`/`pending`/`index`, not `worker`, so no change.)

- [ ] **Step 4: Rewire ChunkerPool to ThreadTransport**

In `chunker/infra/pool.ts`: replace
`import { ThreadPool } from "../../infra/thread-pool.js";` with both
`import { WorkerDispatchPool } from "../../infra/worker-dispatch-pool.js";` and
`import { ThreadTransport } from "../../infra/thread-transport.js";`. Change the
field type and constructor:

```ts
private readonly pool: WorkerDispatchPool<WorkerRequest, WorkerResponse>;

constructor(poolSize: number, config: ChunkerConfig) {
  this.pool = new WorkerDispatchPool<WorkerRequest, WorkerResponse>(
    poolSize,
    new ThreadTransport<WorkerRequest, WorkerResponse>(WORKER_PATH),
    { ...config, languageModulePath: LANGUAGE_MODULE_PATH },
    "ChunkerPool",
  );
}
```

(Task 4 swaps `ThreadTransport` → `ProcessTransport` here. This Task keeps
threads so the change is behavior-neutral.)

- [ ] **Step 5: Rewire the enrichment executor to ThreadTransport**

In `enrichment/executor/worker-pool.ts`: replace
`import { ThreadPool } from "../../infra/thread-pool.js";` with
`WorkerDispatchPool` + `ThreadTransport` imports. Change the field +
constructor:

```ts
private readonly pool: WorkerDispatchPool<EnrichmentWorkerRequest, EnrichmentWorkerResponse>;

constructor(poolSize: number, workerPath: string) {
  this.pool = new WorkerDispatchPool<EnrichmentWorkerRequest, EnrichmentWorkerResponse>(
    poolSize,
    new ThreadTransport<EnrichmentWorkerRequest, EnrichmentWorkerResponse>(workerPath),
    {},
    "EnrichmentPool",
  );
}
```

- [ ] **Step 6: Fix barrels + verify no stale `ThreadPool` references**

Run: `npx tsc --noEmit` and grep:

```bash
git grep -n "ThreadPool\|thread-pool" -- src/ tests/
```

Expected: zero matches except inside `thread-transport.ts` comments (it
documents the worker_threads model). Update `pipeline/infra/index.ts` if it
re-exported `ThreadPool`.

- [ ] **Step 7: Run pool + importer tests**

Run:
`npm run build && npx vitest run tests/core/domains/ingest/pipeline/infra/worker-dispatch-pool.test.ts tests/core/domains/ingest/pipeline/chunker/infra/pool.test.ts tests/core/domains/ingest/pipeline/chunker/infra/pool-edge-cases.test.ts tests/core/domains/ingest/pipeline/chunker/infra/pool-single-flight.test.ts`
Expected: PASS (chunker still on threads — single-flight + extraction
unchanged).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(pipeline): ThreadPool -> WorkerDispatchPool over injected WorkerTransport

Wires both consumers (ChunkerPool, enrichment executor) to ThreadTransport;
behavior identical (still worker_threads). Pool business tests moved onto an
in-memory FakeWorkerTransport. Touches deep-silo thread-pool.ts (fanIn=2).
Why: isolate the pool's distribution mechanics from the transport so the
chunker can run on processes (tree-sitter is process-globally thread-unsafe)
without forking a second pool class; trade-off is one extra DI indirection."
```

---

## Task 3: Worker-side WorkerRuntime; refactor chunker worker entry

Introduce the symmetric worker-side adapter so one `worker.ts` entry runs under
either transport. The thread path stays byte-identical; the process path is
added but not yet wired into the chunker (Task 4 flips ChunkerPool's transport).

**Files:**

- Create: `src/core/domains/ingest/pipeline/infra/worker-runtime.ts`
- Modify: `src/core/domains/ingest/pipeline/chunker/infra/worker.ts`
- Test: `tests/core/domains/ingest/pipeline/infra/worker-runtime.test.ts`

**Interfaces:**

- Consumes: `SHUTDOWN_MESSAGE` (Task 1).
- Produces:
  - `interface WorkerRuntime<TInit, Req>` with `init(): Promise<TInit>`,
    `onRequest(cb: (req: Req) => void): void`, `respond(res: unknown): void`,
    `onShutdown(cb: () => void): void`
  - `class ThreadWorkerRuntime<TInit, Req>` — reads `workerData` / `parentPort`
  - `class ProcessWorkerRuntime<TInit, Req>` — reads first `{ __init }` IPC
    message / `process.send`
  - `function createWorkerRuntime<TInit, Req>(): WorkerRuntime<TInit, Req>` —
    picks impl by `isMainThread`
  - `const INIT_KEY = "__init"` — discriminates the init envelope from requests
    on the process side.

- [ ] **Step 1: Write the failing test (process runtime via a forked child)**

```ts
// tests/core/domains/ingest/pipeline/infra/worker-runtime.test.ts
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

// A worker that uses createWorkerRuntime under the PROCESS transport: it is
// forked, so isMainThread is true -> ProcessWorkerRuntime is selected.
const WORKER_SRC = `
import { createWorkerRuntime } from "${join(process.cwd(), "build/core/domains/ingest/pipeline/infra/worker-runtime.js")}";
const rt = createWorkerRuntime();
const init = await rt.init();
rt.onShutdown(() => process.exit(0));
rt.onRequest((req) => rt.respond({ sum: req.a + init.base }));
`;

describe("ProcessWorkerRuntime (via fork)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wr-"));
  const workerPath = join(dir, "rt-worker.mjs");
  writeFileSync(workerPath, WORKER_SRC, "utf8");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("receives init via {__init}, answers a request, exits on shutdown", async () => {
    const child = fork(workerPath, [], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child.send({ __init: { base: 100 } });
    const got = await new Promise<{ sum: number }>((resolve) => {
      child.on("message", (m) => resolve(m as { sum: number }));
      child.send({ a: 5 });
    });
    expect(got.sum).toBe(105);
    const exited = new Promise<number>((resolve) =>
      child.on("exit", (c) => resolve(c ?? -1)),
    );
    child.send({ type: "shutdown" });
    expect(await exited).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build` then
`npx vitest run tests/core/domains/ingest/pipeline/infra/worker-runtime.test.ts`
Expected: FAIL — `worker-runtime.js` not found / child exits non-zero.

- [ ] **Step 3: Write WorkerRuntime**

```ts
// src/core/domains/ingest/pipeline/infra/worker-runtime.ts
import { isMainThread, parentPort, workerData } from "node:worker_threads";

import { SHUTDOWN_MESSAGE } from "./worker-transport.js";

/** Key under which ProcessTransport delivers the init payload as the first IPC message. */
export const INIT_KEY = "__init";

/**
 * Worker-side counterpart of WorkerTransport. Lets one worker entry run under
 * either node:worker_threads (init via workerData, messaging via parentPort) or
 * child_process.fork (init via the first {__init} IPC message, messaging via
 * process.send). The entry picks the impl with createWorkerRuntime().
 */
export interface WorkerRuntime<TInit, Req> {
  /** Resolve the init payload (workerData | first {__init} message). */
  init(): Promise<TInit>;
  /** Register the request handler (shutdown + init envelopes are filtered out). */
  onRequest(cb: (request: Req) => void): void;
  /** Send one response to the parent. */
  respond(response: unknown): void;
  /** Register the graceful-shutdown handler. */
  onShutdown(cb: () => void): void;
}

function isShutdown(m: unknown): boolean {
  return (
    typeof m === "object" &&
    m !== null &&
    (m as { type?: string }).type === SHUTDOWN_MESSAGE.type
  );
}

function isInit(m: unknown): boolean {
  return (
    typeof m === "object" &&
    m !== null &&
    INIT_KEY in (m as Record<string, unknown>)
  );
}

class ThreadWorkerRuntime<TInit, Req> implements WorkerRuntime<TInit, Req> {
  async init(): Promise<TInit> {
    return workerData as TInit;
  }
  onRequest(cb: (request: Req) => void): void {
    parentPort?.on("message", (m) => {
      if (isShutdown(m)) return;
      cb(m as Req);
    });
  }
  respond(response: unknown): void {
    parentPort?.postMessage(response);
  }
  onShutdown(cb: () => void): void {
    parentPort?.on("message", (m) => {
      if (isShutdown(m)) {
        parentPort?.close();
        cb();
      }
    });
  }
}

class ProcessWorkerRuntime<TInit, Req> implements WorkerRuntime<TInit, Req> {
  async init(): Promise<TInit> {
    return new Promise<TInit>((resolve) => {
      const onInit = (m: unknown): void => {
        if (isInit(m)) {
          process.off("message", onInit);
          resolve((m as Record<string, TInit>)[INIT_KEY]);
        }
      };
      process.on("message", onInit);
    });
  }
  onRequest(cb: (request: Req) => void): void {
    process.on("message", (m) => {
      if (isShutdown(m) || isInit(m)) return;
      cb(m as Req);
    });
  }
  respond(response: unknown): void {
    process.send?.(response);
  }
  onShutdown(cb: () => void): void {
    process.on("message", (m) => {
      if (isShutdown(m)) cb();
    });
  }
}

/** Pick the runtime: a forked process is the main thread; a Worker is not. */
export function createWorkerRuntime<TInit, Req>(): WorkerRuntime<TInit, Req> {
  return isMainThread
    ? new ProcessWorkerRuntime<TInit, Req>()
    : new ThreadWorkerRuntime<TInit, Req>();
}
```

- [ ] **Step 4: Refactor the chunker worker entry to use the runtime**

Rewrite the `if (parentPort) { ... }` tail of `chunker/infra/worker.ts` to use
`createWorkerRuntime`. The engine-building (`buildChunker`) and the
walk/emitExtraction body are UNCHANGED — only the messaging wrapper changes:

```ts
import { createWorkerRuntime } from "../../infra/worker-runtime.js";

// (remove the `import { parentPort, workerData } from "node:worker_threads";` line)

const runtime = createWorkerRuntime<ChunkerConfig, WorkerRequest>();
const chunkerPromise = runtime.init().then((config) => buildChunker(config));
runtime.onShutdown(() => process.exit(0));
runtime.onRequest((request) => {
  void (async () => {
    try {
      const engine = await chunkerPromise;
      const { chunks, tree } = await engine.chunker.chunkWithTree(
        request.code,
        request.filePath,
        request.language,
      );
      let extraction: FileExtraction | undefined;
      if (request.emitExtraction && tree) {
        const provider = engine.languageFactory.create(request.language);
        const { walker, kernel } = provider;
        if (walker) {
          const symbolRanges = engine.collectSymbols(
            tree,
            walker.nameOf,
            kernel.scopeSeparator ?? ".",
            kernel.disambiguateOverloads ?? false,
            engine.composer,
          );
          extraction = walker.walk({
            tree,
            code: request.code,
            relPath: request.filePath,
            language: request.language,
            chunks: symbolRanges,
          });
        }
      }
      runtime.respond({
        filePath: request.filePath,
        chunks,
        ...(extraction ? { extraction } : {}),
      } satisfies WorkerResponse);
    } catch (error) {
      runtime.respond({
        filePath: request.filePath,
        chunks: [],
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkerResponse);
    }
  })();
});
```

The ThreadWorkerRuntime `onShutdown` closes `parentPort` (clean thread exit for
NAPI destructors); the `process.exit(0)` callback is for the process path. Both
are registered; only the matching transport's path fires.

- [ ] **Step 5: Run runtime + chunker worker tests**

Run:
`npm run build && npx vitest run tests/core/domains/ingest/pipeline/infra/worker-runtime.test.ts tests/core/domains/ingest/pipeline/chunker/infra/`
Expected: PASS — worker-runtime process test green; chunker thread-path tests
(`pool-single-flight`, `worker-emit-extraction`, `worker-protocol`) unchanged.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(pipeline): worker-side WorkerRuntime; chunker worker entry runs under either transport"
```

---

## Task 4: ProcessTransport; flip ChunkerPool to processes; determinism anchor

Add the isolating transport and switch the chunker onto it. This is the Task
that actually fixes the thread-unsafety. After it, the chunker parses in child
processes.

**Files:**

- Create: `src/core/domains/ingest/pipeline/infra/process-transport.ts`
- Modify: `src/core/domains/ingest/pipeline/chunker/infra/pool.ts`
  (`ThreadTransport` → `ProcessTransport`)
- Test: `tests/core/domains/ingest/pipeline/infra/process-transport.test.ts`
- Test:
  `tests/core/domains/ingest/pipeline/chunker/infra/pool-process-determinism.test.ts`

**Interfaces:**

- Consumes: `WorkerTransport`, `WorkerHandle`, `SHUTDOWN_MESSAGE` (Task 1);
  `INIT_KEY` (Task 3).
- Produces:
  `class ProcessTransport<Req, Res> implements WorkerTransport<Req, Res>` —
  constructed with `workerPath: string`.

- [ ] **Step 1: Write the failing ProcessTransport test**

```ts
// tests/core/domains/ingest/pipeline/infra/process-transport.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProcessTransport } from "../../../../../../src/core/domains/ingest/pipeline/infra/process-transport.js";

const WORKER_SRC = `
import { createWorkerRuntime } from "${join(process.cwd(), "build/core/domains/ingest/pipeline/infra/worker-runtime.js")}";
const rt = createWorkerRuntime();
const init = await rt.init();
rt.onShutdown(() => process.exit(0));
rt.onRequest((req) => rt.respond({ doubled: req.n * 2, base: init.base }));
`;

describe("ProcessTransport", () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-"));
  const workerPath = join(dir, "pt-worker.mjs");
  writeFileSync(workerPath, WORKER_SRC, "utf8");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("forks a child, injects init, round-trips, and exits on shutdown", async () => {
    const transport = new ProcessTransport<
      { n: number },
      { doubled: number; base: number }
    >(workerPath);
    const handle = transport.spawn({ base: 7 });
    const got = await new Promise<{ doubled: number; base: number }>(
      (resolve, reject) => {
        handle.onMessage((m) =>
          resolve(m as { doubled: number; base: number }),
        );
        handle.onError(reject);
        handle.post({ n: 4 });
      },
    );
    expect(got).toEqual({ doubled: 8, base: 7 });
    const exited = new Promise<void>((resolve) => handle.onExit(resolve));
    handle.shutdown();
    await exited;
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
`npm run build && npx vitest run tests/core/domains/ingest/pipeline/infra/process-transport.test.ts`
Expected: FAIL — `process-transport.js` not found.

- [ ] **Step 3: Write ProcessTransport**

```ts
// src/core/domains/ingest/pipeline/infra/process-transport.ts
import { fork } from "node:child_process";

import { INIT_KEY } from "./worker-runtime.js";
import {
  SHUTDOWN_MESSAGE,
  type WorkerHandle,
  type WorkerTransport,
} from "./worker-transport.js";

/**
 * child_process.fork transport. Each worker is a separate OS process with its
 * OWN dlopen of node-tree-sitter, so concurrent parses cannot share native
 * statics — the isolation node:worker_threads cannot provide. `init` is sent as
 * the first IPC message under INIT_KEY (fork has no workerData). Messaging is
 * Node IPC (JSON serialization); the wire protocol is already JSON-safe.
 */
export class ProcessTransport<Req, Res> implements WorkerTransport<Req, Res> {
  constructor(private readonly workerPath: string) {}

  spawn(init: unknown): WorkerHandle<Req, Res> {
    const child = fork(this.workerPath, [], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child.send({ [INIT_KEY]: init });
    return {
      post: (request) => child.send(request as object),
      onMessage: (cb) =>
        child.on("message", (m) => cb(m as Res | { error: string })),
      onError: (cb) => child.on("error", cb),
      onExit: (cb) => child.once("exit", () => cb()),
      shutdown: () => {
        child.unref();
        child.send(SHUTDOWN_MESSAGE);
      },
      terminate: async () => {
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
            child.kill("SIGKILL");
          });
        }
      },
    };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run:
`npm run build && npx vitest run tests/core/domains/ingest/pipeline/infra/process-transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Flip ChunkerPool to ProcessTransport**

In `chunker/infra/pool.ts`: change the import `ThreadTransport` →
`ProcessTransport` (from `../../infra/process-transport.js`) and the constructor
`new ThreadTransport(...)` →
`new ProcessTransport<WorkerRequest, WorkerResponse>(WORKER_PATH)`. Nothing else
changes — the pool, init payload, and protocol are unchanged.

- [ ] **Step 6: Write the determinism anchor test**

```ts
// tests/core/domains/ingest/pipeline/chunker/infra/pool-process-determinism.test.ts
import { describe, expect, it } from "vitest";

import { ChunkerPool } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/infra/pool.js";

// A non-trivial Ruby source with many classes/methods so the AST is large
// enough that a corrupt parse would diverge in chunk count or extraction.
const RUBY = Array.from(
  { length: 40 },
  (_, i) => `
class Widget${i} < Base
  def process_${i}(input, opts = {})
    input.map { |x| x.to_s.strip }.reject(&:empty?)
  end
end`,
).join("\n");

describe("ChunkerPool process determinism (size 4)", () => {
  it("produces byte-stable chunks+extraction across many concurrent runs", async () => {
    const pool = new ChunkerPool(4, {
      chunkSize: 1500,
      chunkOverlap: 0,
    } as never);
    try {
      const runs = await Promise.all(
        Array.from({ length: 24 }, () =>
          pool.processFile("w.rb", RUBY, "ruby", true),
        ),
      );
      const baseline = JSON.stringify({
        chunks: runs[0].chunks.map((c) => c.symbolId),
        ext: runs[0].extraction?.chunks.map((c) => c.symbolId),
      });
      for (const r of runs) {
        const sig = JSON.stringify({
          chunks: r.chunks.map((c) => c.symbolId),
          ext: r.extraction?.chunks.map((c) => c.symbolId),
        });
        expect(sig).toBe(baseline);
      }
    } finally {
      await pool.shutdown();
    }
  });
});
```

(If `ChunkerConfig` requires more fields than `chunkSize`/`chunkOverlap`, copy
the minimal shape used by `pool-single-flight.test.ts` rather than casting.)

- [ ] **Step 7: Run determinism + full chunker suite**

Run:
`npm run build && npx vitest run tests/core/domains/ingest/pipeline/chunker/`
Expected: PASS — determinism test green at pool size 4; single-flight +
extraction still green (now on processes).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(chunker): ProcessTransport; run chunker workers as child processes

Flips ChunkerPool onto child_process.fork so concurrent tree-sitter parses are
process-isolated (separate dlopen, separate native statics). Adds a pool-size-4
determinism anchor: 24 concurrent parses of one ruby file yield byte-stable
chunks+extraction. Enrichment executor stays on ThreadTransport."
```

---

## Task 5: Restore chunker pool-size default to min(4, cpus-1)

Task-4 of yl9tv dropped the chunker pool default to 1 as the thread-unsafety
stopgap. Processes make parallelism safe again — restore a parallel default.

**Files:**

- Modify: `src/bootstrap/config/schemas.ts:72`
- Modify: `src/core/domains/ingest/pipeline/base.ts:54`
- Create/extend: `src/core/domains/ingest/pipeline/infra/pool-defaults.ts` (the
  shared helper home)
- Test: the existing config-defaults test (locate under
  `tests/bootstrap/config/`)

**Interfaces:**

- Produces: `function defaultChunkerPoolSize(): number` returning
  `Math.max(1, Math.min(4, os.cpus().length - 1))`, used by both default sites
  so they cannot drift.

- [ ] **Step 1: Write the failing test**

```ts
// add to the existing config-defaults test file (or a new pool-defaults.test.ts)
import os from "node:os";

import { defaultChunkerPoolSize } from "../../../src/core/domains/ingest/pipeline/infra/pool-defaults.js";

it("defaults the chunker pool to min(4, cpus-1), at least 1", () => {
  const expected = Math.max(1, Math.min(4, os.cpus().length - 1));
  expect(defaultChunkerPoolSize()).toBe(expected);
  expect(defaultChunkerPoolSize()).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run <that-test-file>` Expected: FAIL — `pool-defaults.js` /
`defaultChunkerPoolSize` not found.

- [ ] **Step 3: Add the helper + apply to both default sites**

```ts
// src/core/domains/ingest/pipeline/infra/pool-defaults.ts
import os from "node:os";

/** Parallel chunker default now that workers are process-isolated (cap 4 to bound memory). */
export function defaultChunkerPoolSize(): number {
  return Math.max(1, Math.min(4, os.cpus().length - 1));
}
```

In `bootstrap/config/schemas.ts`: change `chunkerPoolSize: intWithDefault(1)` to
`chunkerPoolSize: intWithDefault(defaultChunkerPoolSize())` (evaluated at module
load — cpu count is stable per process). Import the helper. Update the adjacent
comment to note process isolation restored parallelism.

In `pipeline/base.ts:54`: change `chunkerPoolSize: 1` in `DEFAULT_TUNING` to
`chunkerPoolSize: defaultChunkerPoolSize()` and update the thread-unsafety
comment to reference process isolation.

- [ ] **Step 4: Run to verify it passes + full config + pipeline suites**

Run:
`npm run build && npx vitest run tests/bootstrap/ tests/core/domains/ingest/pipeline/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(config): restore chunker pool default to min(4, cpus-1) on process isolation

Task-4 forced chunkerPoolSize=1 as the worker_threads thread-unsafety stopgap.
Process isolation makes parallel parsing safe, so the default returns to
min(4, cpus-1). Operators can still override via INGEST_TUNE_CHUNKER_POOL_SIZE.

BREAKING CHANGE: default INGEST_TUNE_CHUNKER_POOL_SIZE changes from 1 to
min(4, cpus-1). Indexing now spawns up to 4 chunker child processes by default
(higher memory, faster parse). Set INGEST_TUNE_CHUNKER_POOL_SIZE=1 to restore
single-process behavior."
```

---

## Task 6: Live integration validation

No code. Validate on the running MCP server that the process pool indexes
correctly and deterministically. Requires the worktree build linked into the
global tea-rags (per `.claude/CLAUDE.md` npm-link workflow) and an MCP
reconnect.

**Steps:**

- [ ] **Step 1: Build + link the worktree, reconnect MCP**

Run (in the worktree): `npm run build && npm link`, then ask the user to
reconnect the tea-rags MCP server.

- [ ] **Step 2: force_reindex tea-rags ×2 — determinism**

Run `mcp__tea-rags__force_reindex project=tea-rags` twice (explicit user
confirmation each time). Capture `callsAttempted` / `resolveSuccessRate` from
each run's codegraph run-stats. Expected: `callsAttempted` identical across both
runs (was the jittering metric); enrichment phases healthy (git + codegraph
file/chunk).

- [ ] **Step 3: reindex_changes ×2 — no regression**

Run `mcp__tea-rags__index_codebase project=tea-rags` twice. Expected:
incremental path clean, no enrichment degradation, no
`WorkerPool force shutdown` errors.

- [ ] **Step 4: Record results**

Note the two `callsAttempted` numbers and confirm stability in the epic's beads
task before closing. If they still jitter, STOP — the residual is the enrichment
executor's `extractOneFile` (the documented follow-up), not the chunker; file it
rather than reopening this epic.

---

## Self-Review

**Spec coverage:** §1 naming → Task 2. §2
WorkerTransport/ThreadTransport/ProcessTransport → Tasks 1, 4. §3
WorkerRuntime + worker entry → Task 3. §4 wiring (ChunkerPool→Process,
enrichment→Thread, pool-size default) → Tasks 2, 4, 5. §5 errors/lifecycle
(shutdown nuance, no auto-respawn) → Tasks 1 (ThreadTransport shutdown), 4
(ProcessTransport shutdown); no-auto-respawn preserved by keeping the existing
reject-and-leave behavior. §6 testing (fake-transport unit, determinism anchor,
live integration) → Tasks 2, 4, 6. All spec sections mapped.

**Placeholder scan:** no TBD/TODO; every code step has real code; the "locate
the existing test file" instructions are path-confirmations (the executor reads
the worktree), not content placeholders.

**Type consistency:** `WorkerDispatchPool(poolSize, transport, init, name)`
constructor used identically in Task 2 (both importers) and referenced in 4.
`WorkerHandle` methods (`post/onMessage/onError/onExit/shutdown/terminate`)
defined Task 1, consumed unchanged in Tasks 1 (Thread), 2 (pool), 4 (Process).
`WorkerRuntime` (`init/onRequest/respond/onShutdown`) defined Task 3, consumed
in worker.ts (Task 3) + fixtures (Tasks 3, 4). `INIT_KEY` defined Task 3,
consumed Task 4. `defaultChunkerPoolSize()` defined Task 5 in
`pool-defaults.ts`, consumed by both default sites + its test. Consistent.

---

## Beads Sync (plan-beads-sync rule)

Create epic `chunker process pool — pluggable worker transport` with six 1:1
tasks (Task 1–6 titles above), dependency chain 1→2→3→4→5→6, labels
`architecture` + `performance` + `scaling`. Link the epic under the
codegraph/ingest roadmap epic if one exists. Mark each `in_progress` at start,
`close` after its commit + tests pass.
