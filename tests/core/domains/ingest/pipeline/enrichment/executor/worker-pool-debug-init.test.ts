/**
 * The sending half of debug-flag inheritance (the reading half lives in
 * `pipeline/infra/worker-debug.test.ts`).
 *
 * Worker threads do not inherit the module-level debug flag, so the executor
 * has to put it in the pool's init payload — which `ThreadTransport` hands to
 * each thread as `workerData`. Pinned here at the seam rather than end-to-end
 * because the end-to-end path needs a compiled worker entry under `build/`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { setDebug } from "../../../../../../../src/core/infra/runtime.js";

const { poolSpy } = vi.hoisted(() => ({ poolSpy: vi.fn() }));

vi.mock("../../../../../../../src/core/domains/ingest/pipeline/infra/worker-dispatch-pool.js", () => ({
  WorkerDispatchPool: vi.fn(function (...args: unknown[]) {
    poolSpy(...args);
    return { dispatch: vi.fn(), releaseAffinity: vi.fn(), shutdown: vi.fn() };
  }),
}));

const { WorkerPoolEnrichmentExecutor } =
  await import("../../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/worker-pool.js");

/** The pool's third constructor argument is the per-thread init payload. */
const initPayloadOf = (call: unknown[]): unknown => call[2];

describe("WorkerPoolEnrichmentExecutor init payload", () => {
  afterEach(() => {
    setDebug(false);
    poolSpy.mockReset();
  });

  it("ships debug: true when the main thread has debug on", () => {
    setDebug(true);

    new WorkerPoolEnrichmentExecutor(2, "/tmp/worker.js");

    expect(initPayloadOf(poolSpy.mock.calls[0])).toEqual({ debug: true });
  });

  it("ships debug: false when the main thread has debug off", () => {
    setDebug(false);

    new WorkerPoolEnrichmentExecutor(2, "/tmp/worker.js");

    expect(initPayloadOf(poolSpy.mock.calls[0])).toEqual({ debug: false });
  });
});
