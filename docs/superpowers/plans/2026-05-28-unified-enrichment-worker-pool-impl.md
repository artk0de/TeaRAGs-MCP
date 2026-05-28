# Unified Enrichment Worker Pool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. **Chaining rule:** invoke the
> `dinopowers:Y` wrapper for any `superpowers:Y` (test-driven-development,
> executing-plans, verification-before-completion) the cycle reaches.

**Goal:** Move git + codegraph trajectory enrichment off the main thread onto a
unified `worker_threads` pool at the ingest-engine level, so heavy enrichment no
longer starves the embedding event loop.

**Architecture:** A three-layer design from the spec
(`docs/superpowers/specs/2026-05-27-unified-enrichment-worker-pool-design.md`,
commit `20cdd661`): (1) a generic `WorkerPool<Req,Res>` extracted from
`ChunkerPool` with `routingKey` affinity; (2) an `EnrichmentExecutor` DIP seam
(`Inline` ↔ `WorkerPool`) the enrichment phases depend on instead of calling
`provider.*` directly; (3) a per-trajectory `WorkerEnrichmentDescriptor`
declaring `stateless` (git) vs `collection-affinity` (codegraph) dispatch.

**Tech Stack:** TypeScript (ESM, NodeNext), `node:worker_threads`, vitest, Zod
config schemas, existing `ChunkerPool` as the reference worker pool.

---

## Scope decomposition (READ FIRST)

This plan is split into **two phases** because planning surfaced a real design
gap (documented under "Design gap" below):

- **Phase 1 — Tasks 1-2 (THIS PLAN, fully detailed, executable now).** Extract
  the generic `WorkerPool` + add the `EnrichmentExecutor` seam with
  `InlineEnrichmentExecutor`. These are **behavior-preserving** (inline ==
  today) and independently valuable: they establish the abstraction + a reusable
  pool with **zero runtime behavior change** and full test coverage.
- **Phase 2 — Tasks 3-5 (DESIGN-OUTLINE ONLY, needs a spec amendment first).**
  The actual worker offload. Blocked on the **provider-in-worker
  reconstruction** design gap — the worker must rebuild each provider from
  _serializable_ inputs, but the real providers are constructed with
  **non-serializable deps** (codegraph: `languageFactory` instance + DuckDB pool
  handle). Phase 2 tasks are outlined with intent + interfaces + the open
  decision, but NOT written as complete code, because doing so without resolving
  the gap would fabricate code that cannot run. Resolve the gap (amend the spec)
  → then write the Phase 2 detailed plan.

Phase 1 delivers working, tested software on its own. Phase 2 builds on it once
the gap is designed.

---

## Discrepancies vs the spec (corrected against current source)

The spec named some structures that do not exist as written. Corrected facts
(verified by reading source):

1. **No `enrichment/trajectory/registry.ts`, no `createEnrichmentProviders`.**
   The provider list comes from `TrajectoryRegistry.getAllEnrichmentProviders()`
   (`src/core/domains/trajectory/registry.ts:116`), filtered in
   `factory.ts:440-442`. `EnrichmentCoordinator` is constructed in
   `IngestFacade.buildIngestPipeline`
   (`src/core/api/internal/facades/ingest-facade.ts:176`), NOT in `factory.ts`.
   Git/codegraph providers are built inside `new GitTrajectory(...)` /
   `createCodegraphTrajectories(...)` in `composition.ts:71-78`.
2. **No "daemon/server vs direct mode" flag** exists for the
   ingest/enrichment/chunker path. The executor toggle will therefore be driven
   by the new `enrichmentPoolSize` config knob: `enrichmentPoolSize === 0` ⇒
   `InlineEnrichmentExecutor`; `> 0` ⇒ `WorkerPoolEnrichmentExecutor`. Default
   `0` for Phase 1 (inline, no behavior change); Phase 2 flips the default.
3. **`ChunkLookupEntry`** is imported from `src/core/types.ts:280`, re-exported
   by `contracts/types/provider.ts:223`.
4. **The module-path injection DI pattern** (`providerModulePath`-style)
   currently exists ONLY for the chunker worker via
   `ChunkerConfig.languageModulePath`. No enrichment provider has it yet.
5. **The chunker worker entry is NOT in `vitest.config.ts` `coverage.exclude`**
   — new worker entries must be added explicitly, following the
   `daemon/entry.ts` precedent.

---

## File Structure

### Phase 1 (this plan)

| File                                                                    | New/Mod             | Responsibility                                                                                                                          |
| ----------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/domains/ingest/pipeline/infra/worker-pool.ts`                 | **New**             | Generic `WorkerPool<Req,Res>`: worker lifecycle, busy/queue round-robin, `routingKey` affinity, graceful shutdown. Trajectory-agnostic. |
| `src/core/domains/ingest/pipeline/infra/index.ts`                       | **New** (if absent) | Barrel for the new `pipeline/infra/` subdomain (per barrel-files.md).                                                                   |
| `src/core/domains/ingest/pipeline/chunker/infra/pool.ts`                | Mod                 | `ChunkerPool` delegates to `WorkerPool`, preserving `processFile`.                                                                      |
| `src/core/contracts/types/enrichment-executor.ts`                       | **New**             | `EnrichmentExecutor` interface (DIP seam).                                                                                              |
| `src/core/contracts/index.ts`                                           | Mod                 | Re-export `EnrichmentExecutor`.                                                                                                         |
| `src/core/domains/ingest/pipeline/enrichment/executor/inline.ts`        | **New**             | `InlineEnrichmentExecutor` — calls `provider.*` on the main thread (today's behavior).                                                  |
| `src/core/domains/ingest/pipeline/enrichment/executor/index.ts`         | **New**             | Barrel for the `executor/` subdomain.                                                                                                   |
| `src/core/domains/ingest/pipeline/enrichment/file-phase.ts`             | Mod                 | Call `executor.runFileBatch` instead of `provider.streamFileBatch`/`buildFileSignals`.                                                  |
| `src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts`            | Mod                 | Call `executor.runChunkBatch` instead of `provider.buildChunkSignals`.                                                                  |
| `src/core/domains/ingest/pipeline/enrichment/backfiller.ts`             | Mod                 | Call `executor.runFileBatch`/`runChunkBatch`.                                                                                           |
| `src/core/domains/ingest/pipeline/enrichment/recovery.ts`               | Mod                 | Call executor (deep-silo — `Why:` line required).                                                                                       |
| `src/core/domains/ingest/pipeline/enrichment/completion-runner.ts`      | Mod                 | Call `executor.runFinalize`.                                                                                                            |
| `src/core/domains/ingest/pipeline/enrichment/coordinator.ts`            | Mod                 | Construct/own the `EnrichmentExecutor`, thread it into the phases.                                                                      |
| `tests/core/domains/ingest/pipeline/infra/worker-pool.test.ts`          | **New**             | Affinity + round-robin + shutdown unit tests.                                                                                           |
| `tests/core/domains/ingest/pipeline/enrichment/executor/inline.test.ts` | **New**             | Inline executor delegation tests.                                                                                                       |

### Phase 2 (design-outline only — see end of doc)

`contracts/types/provider.ts` (descriptor), git/codegraph provider factories for
in-worker rebuild, `enrichment/infra/worker.ts` (worker entry),
`enrichment/executor/worker-pool.ts`, `bootstrap/config/{schemas,parse}.ts`
(knob), `bootstrap/factory.ts` (DI selection), `vitest.config.ts` (coverage
exclude).

---

## Task 1: Extract generic `WorkerPool<Req,Res>` from `ChunkerPool` (+ routingKey affinity)

**Files:**

- Create: `src/core/domains/ingest/pipeline/infra/worker-pool.ts`
- Create: `src/core/domains/ingest/pipeline/infra/index.ts` (barrel, only if
  `pipeline/infra/` has no barrel yet)
- Modify: `src/core/domains/ingest/pipeline/chunker/infra/pool.ts`
- Test: `tests/core/domains/ingest/pipeline/infra/worker-pool.test.ts`

**Context — the reference (`ChunkerPool`).** `pool.ts` today owns:
`PoolWorker { worker, busy, pending }`, a `queue`, round-robin to the first free
worker, `processFile` returning a Promise, and `shutdown` (post
`{type:"shutdown"}`, `terminate()` fallback after 2s). The message handler
resolves `{filePath, chunks}` and rejects when `response.error` is set. Task 1
lifts everything except the chunk-specific request/response into a generic
`WorkerPool<Req,Res>`, then makes `ChunkerPool` a thin wrapper.

**Affinity requirement.** `dispatch(request, routingKey?)`: when `routingKey` is
present, the pool pins it to one worker (`Map<routingKey, workerIndex>`) so
every same-key dispatch lands on the same worker — this is the codegraph
correctness invariant. When absent, round-robin to any free worker (today's
chunker behavior).

- [ ] **Step 1: Write the failing test**

Create `tests/core/domains/ingest/pipeline/infra/worker-pool.test.ts`. Use a
tiny real worker script fixture so we test the actual `worker_threads` mechanics
(the pool's value is thread orchestration, not mockable logic). Write the
fixture inline to a temp file in `beforeAll`.

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorkerPool } from "../../../../../../../src/core/domains/ingest/pipeline/infra/worker-pool.js";

// A trivial echo worker: returns { threadId, value } so the test can assert
// WHICH worker handled each request (to prove affinity routing).
const WORKER_SRC = `
import { parentPort, threadId } from "node:worker_threads";
parentPort.on("message", (msg) => {
  if (msg && msg.type === "shutdown") { parentPort.close(); return; }
  if (msg.value === "BOOM") { parentPort.postMessage({ error: "boom" }); return; }
  // small delay so concurrent dispatches actually overlap across workers
  setTimeout(() => parentPort.postMessage({ threadId, value: msg.value }), 5);
});
`;

interface EchoReq {
  value: string;
}
interface EchoRes {
  threadId: number;
  value: string;
}

describe("WorkerPool", () => {
  let dir: string;
  let workerPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wp-"));
    workerPath = join(dir, "echo-worker.mjs");
    writeFileSync(workerPath, WORKER_SRC);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("round-robins stateless requests across workers and returns results", async () => {
    const pool = new WorkerPool<EchoReq, EchoRes>(3, workerPath, {});
    const results = await Promise.all(
      ["a", "b", "c", "d", "e", "f"].map((v) => pool.dispatch({ value: v })),
    );
    expect(results.map((r) => r.value).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
    // 3 workers were used for 6 concurrent requests (proves fan-out)
    expect(new Set(results.map((r) => r.threadId)).size).toBeGreaterThan(1);
    await pool.shutdown();
  });

  it("pins a routingKey to ONE worker (affinity)", async () => {
    const pool = new WorkerPool<EchoReq, EchoRes>(3, workerPath, {});
    // Same key dispatched many times — all must land on the same threadId.
    const sameKey = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        pool.dispatch({ value: `k${i}` }, "collectionA"),
      ),
    );
    const threadIds = new Set(sameKey.map((r) => r.threadId));
    expect(threadIds.size).toBe(1);
    await pool.shutdown();
  });

  it("rejects when the worker reports an error", async () => {
    const pool = new WorkerPool<EchoReq, EchoRes>(1, workerPath, {});
    await expect(pool.dispatch({ value: "BOOM" })).rejects.toThrow(/boom/);
    await pool.shutdown();
  });

  it("rejects queued work on shutdown", async () => {
    const pool = new WorkerPool<EchoReq, EchoRes>(1, workerPath, {});
    const inflight = pool.dispatch({ value: "x" });
    const queued = pool.dispatch({ value: "y" }); // queues behind the single worker
    await pool.shutdown();
    await expect(queued).rejects.toThrow(/shutting down/);
    await inflight.catch(() => undefined);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/infra/worker-pool.test.ts`
Expected: FAIL — `Cannot find module '.../infra/worker-pool.js'`.

- [ ] **Step 3: Implement `WorkerPool<Req,Res>`**

Create `src/core/domains/ingest/pipeline/infra/worker-pool.ts`. This generalizes
`ChunkerPool`: generic `<Req,Res>`, `dispatch(request, routingKey?)`, affinity
map. The response contract matches the chunker's: the worker posts `Res`, or
`{ error: string }` to signal failure.

```ts
/**
 * WorkerPool<Req, Res> — generic worker_threads pool extracted from ChunkerPool.
 *
 * Owns the MECHANICS of distribution only (free-worker selection, round-robin,
 * routingKey affinity, busy-tracking, overflow queue, graceful shutdown) and
 * stays trajectory-agnostic: it sees (request, routingKey?) and nothing else.
 * Consumers (ChunkerPool, the enrichment executor) supply their own compiled
 * worker entry path + workerData, and — for stateful work — a routingKey.
 *
 * Worker DI rule (.claude/rules/domains-language.md): a class instance cannot
 * cross the postMessage structured-clone boundary, so workerData carries only
 * serializable init (including module-path strings the worker dynamic-imports).
 */
import { Worker } from "node:worker_threads";

import { PipelineNotStartedError } from "../../errors.js";
import { isDebug } from "./runtime.js";

interface Pending<Res> {
  resolve: (result: Res) => void;
  reject: (error: Error) => void;
}

interface PoolWorker<Res> {
  worker: Worker;
  busy: boolean;
  pending: Pending<Res> | null;
  index: number;
}

interface QueueItem<Req, Res> {
  request: Req;
  pending: Pending<Res>;
  /** Pinned worker index when the request carried a routingKey, else null. */
  affinityIndex: number | null;
}

/** Worker message shape: the result, or an error envelope. */
type WorkerMessage<Res> = Res | { error: string };

export class WorkerPool<Req, Res> {
  private readonly workers: PoolWorker<Res>[] = [];
  private queue: QueueItem<Req, Res>[] = [];
  /** routingKey → pinned worker index (affinity). */
  private readonly affinity = new Map<string, number>();
  private isShutdown = false;

  constructor(
    private readonly poolSize: number,
    private readonly workerPath: string,
    private readonly workerData: unknown,
  ) {
    this.initWorkers();
  }

  private initWorkers(): void {
    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(this.workerPath, {
        workerData: this.workerData,
      });
      const pw: PoolWorker<Res> = {
        worker,
        busy: false,
        pending: null,
        index: i,
      };

      worker.on("message", (message: WorkerMessage<Res>) => {
        const { pending } = pw;
        pw.busy = false;
        pw.pending = null;
        if (pending) {
          if (
            message &&
            typeof message === "object" &&
            "error" in message &&
            message.error
          ) {
            pending.reject(new Error(`Worker error: ${message.error}`));
          } else {
            pending.resolve(message as Res);
          }
        }
        this.processQueue();
      });

      worker.on("error", (error) => {
        const { pending } = pw;
        pw.busy = false;
        pw.pending = null;
        if (pending) pending.reject(error);
        this.processQueue();
      });

      this.workers.push(pw);
    }
    if (isDebug())
      console.error(
        `[WorkerPool] Initialized ${this.poolSize} workers for ${this.workerPath}`,
      );
  }

  /**
   * Dispatch a request. With routingKey, all same-key requests pin to ONE worker
   * (affinity — required for stateful trajectories like codegraph). Without it,
   * round-robin to any free worker (today's chunker behavior).
   */
  async dispatch(request: Req, routingKey?: string): Promise<Res> {
    if (this.isShutdown) throw new PipelineNotStartedError("WorkerPool");

    return new Promise<Res>((resolve, reject) => {
      const pending: Pending<Res> = { resolve, reject };

      if (routingKey !== undefined) {
        const pinned = this.resolveAffinity(routingKey);
        const pw = this.workers[pinned];
        if (!pw.busy) this.dispatchTo(pw, request, pending);
        else this.queue.push({ request, pending, affinityIndex: pinned });
        return;
      }

      const free = this.workers.find((w) => !w.busy);
      if (free) this.dispatchTo(free, request, pending);
      else this.queue.push({ request, pending, affinityIndex: null });
    });
  }

  /** Pin a routingKey to a worker on first sight; reuse thereafter. */
  private resolveAffinity(routingKey: string): number {
    const existing = this.affinity.get(routingKey);
    if (existing !== undefined) return existing;
    // Prefer a worker that holds no affinity yet, else the least-loaded by index.
    const pinnedIndices = new Set(this.affinity.values());
    const unpinned = this.workers.find((w) => !pinnedIndices.has(w.index));
    const chosen = unpinned
      ? unpinned.index
      : this.workers[this.affinity.size % this.poolSize].index;
    this.affinity.set(routingKey, chosen);
    return chosen;
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
    for (const { pending } of this.queue)
      pending.reject(new Error("WorkerPool shutting down"));
    this.queue = [];

    await Promise.all(
      this.workers.map(
        (pw) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              void pw.worker.terminate().then(() => resolve());
            }, 2000);
            pw.worker.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
            pw.worker.unref();
            pw.worker.postMessage({ type: "shutdown" });
          }),
      ),
    );
    this.workers.length = 0;
    if (isDebug()) console.error(`[WorkerPool] Shut down ${this.workerPath}`);
  }

  private dispatchTo(
    pw: PoolWorker<Res>,
    request: Req,
    pending: Pending<Res>,
  ): void {
    pw.busy = true;
    pw.pending = pending;
    pw.worker.postMessage(request);
  }

  private processQueue(): void {
    if (this.queue.length === 0) return;
    // First, try to honor an affinity-pinned item whose worker is now free.
    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];
      if (item.affinityIndex !== null) {
        const pw = this.workers[item.affinityIndex];
        if (pw && !pw.busy) {
          this.queue.splice(i, 1);
          this.dispatchTo(pw, item.request, item.pending);
          return;
        }
        continue; // pinned worker still busy — leave queued
      }
      // Stateless item: any free worker.
      const free = this.workers.find((w) => !w.busy);
      if (free) {
        this.queue.splice(i, 1);
        this.dispatchTo(free, item.request, item.pending);
        return;
      }
      return; // no free worker
    }
  }
}
```

> **Note on `runtime.ts` import path.** `pipeline/infra/runtime.ts` is the
> canonical `isDebug` location (a deprecated re-export shim exists per the
> coverage list). Confirm the relative path resolves from
> `pipeline/infra/worker-pool.ts` — it is a sibling, so `./runtime.js`.

- [ ] **Step 4: Run the test to verify it passes**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/infra/worker-pool.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Refactor `ChunkerPool` to delegate to `WorkerPool`**

Modify `src/core/domains/ingest/pipeline/chunker/infra/pool.ts`. Keep the
`WORKER_PATH` / `LANGUAGE_MODULE_PATH` computation and the public `processFile`
/ `shutdown` surface; replace the hand-rolled worker array + queue with an
internal `WorkerPool<WorkerRequest, FileChunkResult>`. The worker posts
`{filePath, chunks}` or `{error}` — already compatible with `WorkerPool`'s
envelope.

```ts
// ...keep imports + POOL_DIR/CORE_DIR/WORKER_PATH/LANGUAGE_MODULE_PATH + FileChunkResult...
import { WorkerPool } from "../../infra/worker-pool.js";
import type { WorkerRequest } from "./worker-protocol.js";

export class ChunkerPool {
  private readonly pool: WorkerPool<WorkerRequest, FileChunkResult>;

  constructor(poolSize: number, config: ChunkerConfig) {
    this.pool = new WorkerPool<WorkerRequest, FileChunkResult>(
      poolSize,
      WORKER_PATH,
      {
        ...config,
        languageModulePath: LANGUAGE_MODULE_PATH,
      },
    );
  }

  async processFile(
    filePath: string,
    code: string,
    language: string,
  ): Promise<FileChunkResult> {
    return this.pool.dispatch({ filePath, code, language });
  }

  async shutdown(): Promise<void> {
    return this.pool.shutdown();
  }
}
```

> The chunker worker posts `{ filePath, chunks }` (a `FileChunkResult` shape)
> and `{ filePath, chunks: [], error }` on failure — `WorkerPool` resolves the
> former and rejects on the `error` field. Behavior preserved.

- [ ] **Step 6: Run the full chunker pool suite to verify no behavior change**

Run: `npx vitest run tests/core/domains/ingest/pipeline/chunker` Expected: PASS
— all existing `ChunkerPool` tests green (behavior-preserving).

- [ ] **Step 7: Add the `pipeline/infra/` barrel if missing**

Check whether `src/core/domains/ingest/pipeline/infra/index.ts` exists. If not,
create it re-exporting the public infra surface (per barrel-files.md):

```ts
export { WorkerPool } from "./worker-pool.js";
// ...plus any existing public infra exports if a barrel is being introduced...
```

If a barrel already exists, add the `WorkerPool` export line to it.

- [ ] **Step 8: Typecheck + lint + commit**

Run:
`npx tsc --noEmit && npx eslint src/core/domains/ingest/pipeline/infra/worker-pool.ts src/core/domains/ingest/pipeline/chunker/infra/pool.ts`
Expected: 0 errors.

```bash
git add src/core/domains/ingest/pipeline/infra/worker-pool.ts \
        src/core/domains/ingest/pipeline/infra/index.ts \
        src/core/domains/ingest/pipeline/chunker/infra/pool.ts \
        tests/core/domains/ingest/pipeline/infra/worker-pool.test.ts
git commit -m "refactor(ingest): extract generic WorkerPool from ChunkerPool with routingKey affinity"
```

---

## Task 2: `EnrichmentExecutor` seam + `InlineEnrichmentExecutor`

**Files:**

- Create: `src/core/contracts/types/enrichment-executor.ts`
- Modify: `src/core/contracts/index.ts` (re-export)
- Create: `src/core/domains/ingest/pipeline/enrichment/executor/inline.ts`
- Create: `src/core/domains/ingest/pipeline/enrichment/executor/index.ts`
  (barrel)
- Modify: `coordinator.ts`, `file-phase.ts`, `chunk-phase.ts`, `backfiller.ts`,
  `recovery.ts`, `completion-runner.ts`
- Test: `tests/core/domains/ingest/pipeline/enrichment/executor/inline.test.ts`

**Goal:** the enrichment phases depend on an injected `EnrichmentExecutor`
instead of calling
`provider.streamFileBatch/buildFileSignals/buildChunkSignals/finalizeSignals`
directly. `InlineEnrichmentExecutor` calls those methods on the main thread — so
this task is **pure refactor, zero behavior change**, and all existing
enrichment tests stay green when Inline is injected (the default).

- [ ] **Step 1: Write the failing test for `InlineEnrichmentExecutor`**

Create `tests/core/domains/ingest/pipeline/enrichment/executor/inline.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import type { EnrichmentProvider } from "../../../../../../../../src/core/contracts/index.js";
import { InlineEnrichmentExecutor } from "../../../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/inline.js";

function fakeProvider(
  overrides: Partial<EnrichmentProvider> = {},
): EnrichmentProvider {
  return {
    key: "fake",
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p) => p,
    buildFileSignals: vi.fn(async () => new Map([["a.ts", { x: 1 }]])),
    buildChunkSignals: vi.fn(
      async () => new Map([["a.ts", new Map([["c1", { y: 2 }]])]]),
    ),
    streamFileBatch: vi.fn(async () => new Map([["a.ts", { s: 3 }]])),
    finalizeSignals: vi.fn(async () => new Map([["a.ts", { f: 4 }]])),
    ...overrides,
  } as EnrichmentProvider;
}

describe("InlineEnrichmentExecutor", () => {
  const exec = new InlineEnrichmentExecutor();

  it("runFileBatch prefers streamFileBatch when present", async () => {
    const p = fakeProvider();
    const out = await exec.runFileBatch(p, "/root", ["a.ts"], {
      collectionName: "c",
    });
    expect(out.get("a.ts")).toEqual({ s: 3 });
    expect(p.streamFileBatch).toHaveBeenCalledWith("/root", ["a.ts"], {
      collectionName: "c",
    });
    expect(p.buildFileSignals).not.toHaveBeenCalled();
  });

  it("runFileBatch falls back to buildFileSignals({paths}) when no streamFileBatch", async () => {
    const p = fakeProvider({ streamFileBatch: undefined });
    const out = await exec.runFileBatch(p, "/root", ["a.ts"], {
      collectionName: "c",
    });
    expect(out.get("a.ts")).toEqual({ x: 1 });
    expect(p.buildFileSignals).toHaveBeenCalledWith("/root", {
      collectionName: "c",
      paths: ["a.ts"],
    });
  });

  it("runChunkBatch delegates to buildChunkSignals", async () => {
    const p = fakeProvider();
    const map = new Map([
      ["a.ts", [{ chunkId: "c1", startLine: 1, endLine: 2 }]],
    ]);
    const out = await exec.runChunkBatch(p, "/root", map, { skipCache: true });
    expect(out.get("a.ts")?.get("c1")).toEqual({ y: 2 });
    expect(p.buildChunkSignals).toHaveBeenCalledWith("/root", map, {
      skipCache: true,
    });
  });

  it("runFinalize delegates to finalizeSignals, empty map when absent", async () => {
    expect(
      (await exec.runFinalize(fakeProvider(), "/root")).get("a.ts"),
    ).toEqual({ f: 4 });
    expect(
      (
        await exec.runFinalize(
          fakeProvider({ finalizeSignals: undefined }),
          "/root",
        )
      ).size,
    ).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/executor/inline.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Define the `EnrichmentExecutor` interface**

Create `src/core/contracts/types/enrichment-executor.ts`:

```ts
import type { ChunkLookupEntry } from "../../types.js";
import type {
  ChunkSignalOptions,
  ChunkSignalOverlay,
  EnrichmentProvider,
  FileSignalOptions,
  FileSignalOverlay,
} from "./provider.js";

/**
 * Dispatch seam between the enrichment phases and provider execution.
 * The phases depend on this interface, never on worker_threads. Implementations:
 *  - InlineEnrichmentExecutor — runs provider methods on the main thread (today).
 *  - WorkerPoolEnrichmentExecutor (Phase 2) — dispatches to a worker pool.
 * Signatures mirror EnrichmentProvider exactly so swapping is transparent.
 */
export interface EnrichmentExecutor {
  /** Per-batch file enrichment (streamFileBatch, or buildFileSignals({paths}) fallback). */
  runFileBatch(
    provider: EnrichmentProvider,
    root: string,
    paths: string[],
    options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>>;

  /** Chunk enrichment — nested file → chunkId → overlay, mirrors buildChunkSignals. */
  runChunkBatch(
    provider: EnrichmentProvider,
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    options?: ChunkSignalOptions,
  ): Promise<Map<string, Map<string, ChunkSignalOverlay>>>;

  /** Deferred whole-repo FILE finalize; empty map when provider has no finalizeSignals. */
  runFinalize(
    provider: EnrichmentProvider,
    root: string,
    options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>>;

  /** Release executor resources (worker pool shutdown); no-op for inline. */
  shutdown(): Promise<void>;
}
```

Add to `src/core/contracts/index.ts`:

```ts
export type { EnrichmentExecutor } from "./types/enrichment-executor.js";
```

- [ ] **Step 4: Implement `InlineEnrichmentExecutor`**

Create `src/core/domains/ingest/pipeline/enrichment/executor/inline.ts`. The
`runFileBatch` fallback exactly mirrors today's `file-phase.ts` logic
(`streamFileBatch ?? buildFileSignals({...o, paths})`).

```ts
import type {
  ChunkSignalOptions,
  ChunkSignalOverlay,
  EnrichmentExecutor,
  EnrichmentProvider,
  FileSignalOptions,
  FileSignalOverlay,
} from "../../../../../contracts/index.js";
import type { ChunkLookupEntry } from "../../../../../types.js";

/**
 * Main-thread executor: calls provider methods directly. This is the behavior
 * the enrichment phases had before the executor seam existed — extracting it
 * behind the interface is a pure refactor (no behavior change).
 */
export class InlineEnrichmentExecutor implements EnrichmentExecutor {
  async runFileBatch(
    provider: EnrichmentProvider,
    root: string,
    paths: string[],
    options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>> {
    if (provider.streamFileBatch)
      return provider.streamFileBatch(root, paths, options);
    return provider.buildFileSignals(root, { ...options, paths });
  }

  async runChunkBatch(
    provider: EnrichmentProvider,
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    options?: ChunkSignalOptions,
  ): Promise<Map<string, Map<string, ChunkSignalOverlay>>> {
    return provider.buildChunkSignals(root, chunkMap, options);
  }

  async runFinalize(
    provider: EnrichmentProvider,
    root: string,
    options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>> {
    if (!provider.finalizeSignals) return new Map();
    return provider.finalizeSignals(root, options);
  }

  async shutdown(): Promise<void> {
    /* no-op: nothing to release on the main thread */
  }
}
```

Create the barrel
`src/core/domains/ingest/pipeline/enrichment/executor/index.ts`:

```ts
export { InlineEnrichmentExecutor } from "./inline.js";
```

- [ ] **Step 5: Run the inline executor test to verify it passes**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/enrichment/executor/inline.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Thread the executor through the coordinator into the phases**

Modify `coordinator.ts` to own an `EnrichmentExecutor` (default
`InlineEnrichmentExecutor`, injectable for tests/Phase 2) and pass it to the
phases. The coordinator constructor currently is
`(qdrant, providers, recovery?)`; add an optional executor:

```ts
import type { EnrichmentExecutor } from "../../../../contracts/index.js";
import { InlineEnrichmentExecutor } from "./executor/index.js";

// in constructor params:
//   private readonly recovery?: EnrichmentRecovery,
//   executor?: EnrichmentExecutor,
// in body:
//   this.executor = executor ?? new InlineEnrichmentExecutor();
// and construct FilePhase/ChunkPhase/Backfiller/CompletionRunner with this.executor.
```

> Read the coordinator's phase construction (where `new FilePhase(...)`,
> `new ChunkPhase(...)`, `new EnrichmentBackfiller(...)`,
> `new CompletionRunner(...)` happen) and add `this.executor` to each. The
> phases gain an `executor` constructor param.

- [ ] **Step 7: Rewire `file-phase.ts` to use the executor**

Replace the two call sites in `onBatch`. Deferred-provider branch — replace
`ctx.provider.streamFileBatch(root, relPaths, {...})` with
`this.executor.runFileBatch(ctx.provider, root, relPaths, {...})` BUT preserve
the `if (!ctx.provider.streamFileBatch) continue;` guard (defer-providers with
no streamFileBatch still skip — the executor would otherwise fall back to
buildFileSignals, which is wrong for defer providers). Streaming-provider branch
— replace the `streamFn = streamFileBatch ?? (buildFileSignals fallback)` block
with a direct `this.executor.runFileBatch(ctx.provider, root, relPaths, {...})`
(the fallback now lives in the executor).

```ts
// deferred branch (keep the guard — defer providers without streamFileBatch skip):
if (ctx.provider.defersChunkEnrichment) {
  if (!ctx.provider.streamFileBatch) continue;
  const extractWork = this.executor
    .runFileBatch(ctx.provider, root, relPaths, {
      collectionName: this.coll || undefined,
      ignoreFilter: ctx.ignoreFilter ?? undefined,
    })
    .then(() => undefined)
    .catch(async (error: unknown) => {
      await this.recordPrefetchFailure(ctx, state, error);
    });
  state.fileWork.push(extractWork);
  collected.push(extractWork);
  continue;
}

// streaming branch (fallback now lives in the executor):
const work = this.executor
  .runFileBatch(ctx.provider, root, relPaths, {
    collectionName: this.coll || undefined,
    ignoreFilter: ctx.ignoreFilter ?? undefined,
  })
  .then(async (overlays) => {
    await this.applier.applyFileSignals(
      coll,
      ctx.key,
      overlays,
      root,
      items,
      ctx.provider.fileSignalTransform,
      this.runStartedAt,
    );
    state.streamingApplies++;
    pipelineLog.enrichmentPhase("STREAMING_APPLY", {
      provider: ctx.key,
      chunks: items.length,
    });
  })
  .catch(async (error: unknown) => {
    await this.recordPrefetchFailure(ctx, state, error);
  });
state.fileWork.push(work);
collected.push(work);
```

Add `executor: EnrichmentExecutor` to `FilePhase`'s constructor and store it as
`this.executor`.

- [ ] **Step 8: Rewire `chunk-phase.ts`, `backfiller.ts`, `recovery.ts`,
      `completion-runner.ts`**

For each, replace `ctx.provider.buildChunkSignals(...)` →
`this.executor.runChunkBatch(ctx.provider, ...)`,
`ctx.provider.buildFileSignals(...)` → `this.executor.runFileBatch(...)` (note:
backfiller/recovery use `buildFileSignals` with explicit `paths`, which the
executor's `runFileBatch` handles via its fallback — pass `paths` through
`options` is NOT how runFileBatch works; instead call
`runFileBatch(provider, root, missedPaths, { collectionName })` so the paths are
the 3rd arg), and `ctx.provider.finalizeSignals(...)` →
`this.executor.runFinalize(...)` in completion-runner step 2.

> **Subtlety for backfiller/recovery:** they call
> `buildFileSignals(root, { paths })` directly (whole-set semantics, no
> streaming). `runFileBatch` prefers `streamFileBatch` when present — for git
> that is equivalent (`streamFileBatch` delegates to
> `buildFileSignals({paths})`), for codegraph `streamFileBatch` has extraction
> side-effects that backfill/recovery may NOT want. **Decision for Phase 1:**
> keep backfiller/recovery calling `buildFileSignals` semantics by adding a
> dedicated `runFileSignals` method to the executor that always calls
> `buildFileSignals` (no streamFileBatch preference), OR pass through unchanged.
> To stay strictly behavior-preserving, add
> `runFileSignals(provider, root, paths, options)` to `EnrichmentExecutor` that
> calls `provider.buildFileSignals(root, {...options, paths})` and use THAT in
> backfiller/recovery. Update the interface + InlineEnrichmentExecutor + the
> inline test accordingly.

`chunk-phase.ts` — `runChunkSignals` and `runDeferredChunk` both call
`buildChunkSignals`; replace both with
`this.executor.runChunkBatch(ctx.provider, root, chunkMap, opts)`. Keep the
`Semaphore` + `opts` shaping exactly as-is (the executor receives the same
`opts`). Add `executor` to `ChunkPhase` constructor.

`completion-runner.ts` step 2 — replace
`ctx.provider.finalizeSignals(root, {...})` with
`this.executor.runFinalize(ctx.provider, root, {...})`; drop the
`if (!ctx.provider.finalizeSignals ...)` half-guard's method-existence check
(runFinalize returns empty map when absent) but KEEP the
`filePhase.hasPrefetchFailed(ctx.key)` guard. Add `executor` to
`CompletionRunnerDeps`.

- [ ] **Step 9: Run the full enrichment + ingest suite — verify NO behavior
      change**

Run: `npx vitest run tests/core/domains/ingest` Expected: PASS — all existing
enrichment/pipeline tests green with Inline injected by default. If any test
constructed a phase directly, update it to pass an `InlineEnrichmentExecutor`
(do NOT rewrite business-logic assertions — only the constructor wiring).

- [ ] **Step 10: Full suite + coverage gate**

Run: `npx vitest run --coverage` Expected: PASS, coverage ≥ thresholds (new code
is covered by Task 1 + Task 2 tests; if the gate trips, delegate to the
`coverage-expander` agent per `.claude/CLAUDE.md` — do NOT lower thresholds).

- [ ] **Step 11: Typecheck, lint, commit**

Run:
`npx tsc --noEmit && npx eslint src/core/domains/ingest/pipeline/enrichment src/core/contracts/types/enrichment-executor.ts`

```bash
git add src/core/contracts/types/enrichment-executor.ts src/core/contracts/index.ts \
        src/core/domains/ingest/pipeline/enrichment/executor/ \
        src/core/domains/ingest/pipeline/enrichment/{coordinator,file-phase,chunk-phase,backfiller,recovery,completion-runner}.ts \
        tests/core/domains/ingest/pipeline/enrichment/executor/inline.test.ts
git commit -m "refactor(ingest): introduce EnrichmentExecutor seam with InlineEnrichmentExecutor

Why: enrichment phases now depend on an injected EnrichmentExecutor instead of
calling provider.* directly, enabling a future worker-pool executor without
touching phase logic. Inline executor preserves today's main-thread behavior
exactly; recovery.ts (deep-silo) touched only to swap the call target, no
semantic change. Trade-off: one extra indirection per provider call, negligible."
```

> The commit message carries the `Why:` line required by
> `.claude/rules/silo-pairing.md` because this commit touches `recovery.ts`
> (deep-silo).

---

## Phase 1 self-review

- **Spec coverage (Phase 1 scope):** WorkerPool extraction + affinity (spec
  §"Generic WorkerPool") → Task 1. EnrichmentExecutor DIP seam + Inline (spec
  §"EnrichmentExecutor") → Task 2. Both behavior-preserving as the spec's
  migration steps 1-2 require. ✓
- **Placeholder scan:** no TBD/TODO; every code step has complete code. The one
  explicit DECISION (backfiller/recovery `runFileSignals` vs `runFileBatch`) is
  resolved inline (add `runFileSignals`). ✓
- **Type consistency:** `EnrichmentExecutor` signatures match
  `EnrichmentProvider` (`Map<string,FileSignalOverlay>`, nested
  `Map<string,Map<string,ChunkSignalOverlay>>`, `ChunkLookupEntry` from
  `types.ts`). `WorkerPool<Req,Res>.dispatch(request, routingKey?)` matches both
  consumers. ✓
- **Note:** Step 8 adds `runFileSignals` to the executor interface — when
  implementing, update `enrichment-executor.ts`, `inline.ts`, and
  `inline.test.ts` together so the interface, impl, and test stay consistent.

---

## Phase 2 (DESIGN-OUTLINE ONLY — needs a spec amendment before detailed planning)

> **Do NOT execute Phase 2 from this outline.** It is blocked on the design gap
> below. Resolve the gap (amend
> `2026-05-27-unified-enrichment-worker-pool-design.md`), then write a Phase 2
> detailed plan with complete code.

### Design gap: provider-in-worker reconstruction

The spec assumed the worker rebuilds a provider from `providerModulePath` +
`providerFactoryExport`. Reality (verified): providers are constructed with
**non-serializable deps**:

- **git** (`GitEnrichmentProvider`, built inside `GitTrajectory`): config is
  serializable (repo paths, flags). A factory
  `createGitEnrichmentProvider(config: GitProviderConfig)` callable in-thread is
  straightforward to add.
- **codegraph** (built by
  `createCodegraphTrajectories({ ...CodegraphDeps, languageFactory })`): deps
  include a **`languageFactory` instance** (non-serializable — must be rebuilt
  in-thread from a module-path, exactly like the chunker rebuilds
  `LanguageFactoryImpl`) AND a **DuckDB pool / daemon handle** (non-serializable
  — the worker must open its OWN `DaemonGraphDbClient` from the serializable
  daemon **socket path**). The run-state (`symbolTable`, `chunkSymbolByLine`,
  run sink) intentionally lives on the worker instance — that is the affinity
  payload.

**Open decision (resolve in the amendment):** the exact shape of a
`SerializableProviderSpec` that the worker turns into a live provider:
`{ providerModulePath, providerFactoryExport, serializableConfig, subModulePaths: { languageModulePath? }, daemonSocketPath? }`.
Each provider declares how to rebuild itself from this spec. This is the crux of
Phase 2 and must be designed before code.

### Task 3 (outline): `WorkerEnrichmentDescriptor` on `EnrichmentProvider`

Add `readonly workerDescriptor?: WorkerEnrichmentDescriptor` to
`EnrichmentProvider` (`contracts/types/provider.ts`), shape
`{ providerModulePath, providerFactoryExport, dispatch: "stateless" | "collection-affinity", serializableConfig, subModulePaths?, daemonSocketPath? }`
(final shape per the amendment). Declare it on the git provider (`stateless`)
and codegraph provider (`collection-affinity`). Pure declaration — no dispatch
logic on the provider. Tests: a provider exposing a descriptor round-trips
through `structuredClone` (proves serializability). **Touches the codegraph
provider (deep-silo, extreme churn) — isolate, `Why:` line, owner review.**

### Task 4 (outline): worker entry + `WorkerPoolEnrichmentExecutor` + config + DI

- New `src/core/domains/ingest/pipeline/enrichment/infra/worker.ts`: receives
  `{ spec, method, root, paths?|chunkMap?, options }`; lazily builds + caches
  the provider per `(providerModulePath, collectionName)` by
  `(await import(spec.providerModulePath))[spec.providerFactoryExport](rebuildArgs)`
  where `rebuildArgs` reconstructs non-serializable deps in-thread
  (languageFactory from `subModulePaths.languageModulePath`;
  `DaemonGraphDbClient` from `daemonSocketPath`); calls the method; returns the
  overlay `Map`. Typed request/response protocol in a sibling
  `enrichment/infra/worker-protocol.ts` (like the chunker's). Worker errors →
  typed `IngestError` subclass.
- New `enrichment/executor/worker-pool.ts` (`WorkerPoolEnrichmentExecutor`):
  wraps a `WorkerPool<EnrichmentReq, EnrichmentRes>`; reads
  `provider.workerDescriptor.dispatch` → `routingKey = collectionName`
  (affinity) or none (stateless); serializes the request; for providers without
  a descriptor, delegates to an internal `InlineEnrichmentExecutor` (graceful
  fallback).
- Config: add `enrichmentPoolSize` to `ingestTuneSchema` (`schemas.ts`,
  `intWithDefault(0)` for Phase 2 entry — 0 keeps inline) + `parse.ts`
  (`env("INGEST_TUNE_ENRICHMENT_POOL_SIZE", "ENRICHMENT_POOL_SIZE")`). Default
  to `max(1, floor(availableParallelism()/2))` once Phase 2 is validated (flip
  from 0).
- DI: in `factory.ts`, build the executor
  (`enrichmentPoolSize === 0 ? Inline : WorkerPool`) and thread it into
  `IngestFacade` → `EnrichmentCoordinator` (the coordinator already accepts an
  optional executor from Task 2). Compute provider-factory module paths at the
  composition root and put them in each descriptor (keeps `ingest` free of
  static `trajectory` imports).
- Coverage: add `src/core/domains/ingest/pipeline/enrichment/infra/worker.ts` to
  `vitest.config.ts` `coverage.exclude` (follow the `daemon/entry.ts`
  precedent + comment).

**Invariant to enforce in Task 4:** codegraph `runFileBatch` (stream) +
`runFinalize` + the deferred `runChunkBatch` for ONE collection MUST route to
the SAME pinned worker (affinity by `collectionName`) — the deferred chunk pass
and finalize read the run-state accumulated by the streaming file pass.
Splitting them re-fragments `symbolTable`/`chunkSymbolByLine` (the bug class
fixed in `a32b553a`, across threads). The `WorkerPool` affinity from Task 1
guarantees this as long as the executor always passes
`routingKey = collectionName` for codegraph.

### Task 5 (outline): live validation on taxdome

`index_codebase project=taxdome` (incremental, NOT force). Assert from
`~/.tea-rags/logs/pipeline-*.log`: continuous `EMBED_CALL` cadence (no
multi-minute "ямы"), bounded main-heap RSS (sample `process.memoryUsage().rss`),
codegraph `resolveSuccessRate` unchanged from the affinity guarantee (compare to
the post-`a32b553a` baseline ~0.34). Tune `enrichmentPoolSize`.

---

## Execution handoff

Phase 1 (Tasks 1-2) is ready to execute. Phase 2 (Tasks 3-5) needs the
design-gap amendment first. Recommended: execute Phase 1 via
subagent-driven-development (fresh subagent per task, review between), then run
a focused `brainstorming` pass on the provider-in-worker reconstruction gap
before writing the Phase 2 detailed plan.
