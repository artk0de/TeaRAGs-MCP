/**
 * Spawn-on-demand (bd tea-rags-mcp-1v12o.2).
 *
 * Every slot the pool spawns is a V8 isolate with its own module registry, and
 * on a small run most of them never receive a dispatch: measured on ugnest (234
 * Python files) a pool of 4 carried 115-245 MB more than a pool of 1 for three
 * threads the corpus could not use. The pool therefore lets its owner say that
 * a slot's worker is created by its FIRST dispatch rather than at construction.
 *
 * Opt-in, not the default: the chunker pool dispatches to every slot within the
 * first handful of files, so warming it during pipeline setup overlaps the fork
 * with the scan. The enrichment pool is the one whose slots may stay idle for a
 * whole run.
 */
import { describe, expect, it } from "vitest";

import { WorkerDispatchPool } from "../../../../../../src/core/domains/ingest/pipeline/infra/worker-dispatch-pool.js";
import { FakeWorkerTransport } from "./__helpers__/fake-worker-transport.js";

interface Req {
  n: number;
}
interface Res {
  r: number;
}

const echo = (req: Req): Res => ({ r: req.n + 1 });

/** The enrichment pool's shape: liveness bound disabled, workers on demand. */
function lazyPool(size: number, transport: FakeWorkerTransport<Req, Res>): WorkerDispatchPool<Req, Res> {
  return new WorkerDispatchPool<Req, Res>(size, transport, {}, "EnrichmentPool", 0, true);
}

describe("WorkerDispatchPool spawn-on-demand", () => {
  it("spawns no worker at construction", () => {
    const transport = new FakeWorkerTransport<Req, Res>(echo);
    lazyPool(4, transport);

    expect(transport.handles).toHaveLength(0);
  });

  it("spawns eagerly by default so the chunker pool stays warm", async () => {
    const transport = new FakeWorkerTransport<Req, Res>(echo);
    const pool = new WorkerDispatchPool<Req, Res>(3, transport, {});

    expect(transport.handles).toHaveLength(3);
    await pool.shutdown();
  });

  it("spawns one worker for a run whose every dispatch pins to one slot", async () => {
    const transport = new FakeWorkerTransport<Req, Res>(echo);
    const pool = lazyPool(4, transport);

    for (let n = 0; n < 5; n++) {
      expect((await pool.dispatch({ n }, "code_pinned")).r).toBe(n + 1);
    }

    // Affinity sent every dispatch to slot 0; the other three cost nothing.
    expect(transport.handles).toHaveLength(1);
    await pool.shutdown();
  });

  it("spawns a second worker only when a second slot takes work", async () => {
    const transport = new FakeWorkerTransport<Req, Res>(echo);
    const pool = lazyPool(4, transport);

    const results = await Promise.all([pool.dispatch({ n: 1 }), pool.dispatch({ n: 2 })]);

    expect(results.map((x) => x.r)).toEqual([2, 3]);
    expect(transport.handles).toHaveLength(2);
    await pool.shutdown();
  });

  it("hands the init payload to a worker spawned on demand", async () => {
    const transport = new FakeWorkerTransport<Req, Res>(echo);
    const pool = new WorkerDispatchPool<Req, Res>(2, transport, { debug: true }, "EnrichmentPool", 0, true);

    await pool.dispatch({ n: 1 });

    expect(transport.handles[0].init).toEqual({ debug: true });
    await pool.shutdown();
  });

  it("shuts down cleanly when slots were never spawned", async () => {
    const transport = new FakeWorkerTransport<Req, Res>(echo);
    const pool = lazyPool(3, transport);
    await pool.dispatch({ n: 7 });

    await expect(pool.shutdown()).resolves.toBeUndefined();
    expect(transport.handles).toHaveLength(1);
  });

  it("never drops below one worker: a size-1 pool still serves work", async () => {
    const transport = new FakeWorkerTransport<Req, Res>(echo);
    const pool = lazyPool(1, transport);

    expect((await pool.dispatch({ n: 41 })).r).toBe(42);
    expect(transport.handles).toHaveLength(1);
    await pool.shutdown();
  });
});
