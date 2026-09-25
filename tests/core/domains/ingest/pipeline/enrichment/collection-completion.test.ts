/**
 * `EnrichmentCoordinator.runCollectionCompletion` (bd tea-rags-mcp-l1ot.2).
 *
 * A reindex that takes an early return — nothing to chunk, or only deletions —
 * opens no enrichment run, so no provider finalize reaches the whole-collection
 * work a finalize ends with (codegraph's co-change rebuild). This seam is how
 * such a run still owes it: every provider that declares `completeCollection`
 * is asked once, with its own effective root and the physical collection.
 *
 * Invariants under test:
 *   - each declaring provider is called with `resolveRoot(absolutePath)` and the
 *     collection; a provider without the method is skipped;
 *   - a provider that throws is logged and never fails the call, and the next
 *     provider still runs.
 */

import { describe, expect, it, vi } from "vitest";

import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";

const qdrant = {} as never;

function makeProvider(key: string, overrides: Record<string, unknown> = {}) {
  return {
    key,
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: vi.fn((p: string) => `${p}/effective`),
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    ...overrides,
  } as never;
}

function makeExecutor() {
  return {
    runFileBatch: vi.fn().mockResolvedValue(new Map()),
    runFileSignalsStreaming: vi.fn().mockResolvedValue(new Map()),
    runChunkSignals: vi.fn().mockResolvedValue(new Map()),
    runFinalize: vi.fn().mockResolvedValue(new Map()),
    releaseRun: vi.fn().mockResolvedValue(undefined),
  } as never;
}

describe("EnrichmentCoordinator.runCollectionCompletion (bd tea-rags-mcp-l1ot.2)", () => {
  it("asks every declaring provider once, with its effective root and the collection", async () => {
    const completeCollection = vi.fn().mockResolvedValue(undefined);
    const coordinator = new EnrichmentCoordinator(
      qdrant,
      [makeProvider("git"), makeProvider("codegraph.symbols", { completeCollection })],
      undefined,
      makeExecutor(),
    );

    await coordinator.runCollectionCompletion("/repo", "code_x_v3" as never);

    expect(completeCollection).toHaveBeenCalledTimes(1);
    expect(completeCollection).toHaveBeenCalledWith("/repo/effective", { collectionName: "code_x_v3" });
  });

  it("logs a failing provider and still runs the next one", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const after = vi.fn().mockResolvedValue(undefined);
    const coordinator = new EnrichmentCoordinator(
      qdrant,
      [
        makeProvider("codegraph.symbols", { completeCollection: vi.fn().mockRejectedValue(new Error("daemon gone")) }),
        makeProvider("other", { completeCollection: after }),
      ],
      undefined,
      makeExecutor(),
    );

    try {
      await expect(coordinator.runCollectionCompletion("/repo", "code_x_v3" as never)).resolves.toBeUndefined();
      expect(after).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls.map(([line]) => String(line)).join("")).toContain("daemon gone");
    } finally {
      stderr.mockRestore();
    }
  });
});

/**
 * A run's own completion (bd tea-rags-mcp-vtuu4). The co-change build used to
 * run from the codegraph finalize, i.e. INSIDE the enrichment worker, on top of
 * the whole-project `ts.Program` that worker still held — and on a 17k-file
 * TypeScript repository it pushed the worker past `ENRICHMENT_WORKER_MEMORY_LIMIT_MB`
 * right after the file finalize, losing every codegraph signal of the run.
 *
 * It now runs on the MAIN thread, through the same `completeCollection` seam a
 * reindex that finalized nothing uses, once the run's completion sequence has
 * settled and the executor has released the run's worker state.
 *
 * Invariants under test:
 *   - every run that reaches its completion asks each of ITS providers'
 *     `completeCollection` exactly once, after the provider's finalize and after
 *     the executor released the run;
 *   - a provider the run did not open is not asked (a `--force-enrichments git`
 *     recompute never touches the graph provider).
 */
describe("EnrichmentCoordinator — a run's collection completion runs on the main thread (bd tea-rags-mcp-vtuu4)", () => {
  /** One stored chunk, so a recompute has something to walk and opens its run. */
  function qdrantStub(): Record<string, unknown> {
    return {
      scrollFiltered: vi
        .fn()
        .mockResolvedValue([{ id: "c1", payload: { relativePath: "src/a.ts", startLine: 1, endLine: 10 } }]),
      setPayload: vi.fn().mockResolvedValue(undefined),
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      countPoints: vi.fn().mockResolvedValue(0),
      getPoint: vi.fn().mockResolvedValue(null),
      upsertPoints: vi.fn().mockResolvedValue(undefined),
    };
  }

  function orderedExecutor(order: string[]) {
    return {
      runFileBatch: vi.fn().mockResolvedValue(new Map()),
      runFileSignalsStreaming: vi.fn().mockResolvedValue(new Map()),
      runChunkSignals: vi.fn().mockResolvedValue(new Map()),
      runChunkBatch: vi.fn().mockResolvedValue(new Map()),
      runFileSignalsRecovery: vi.fn().mockResolvedValue(new Map()),
      runFinalize: vi.fn(async (provider: { key: string }) => {
        order.push(`finalize:${provider.key}`);
        return new Map();
      }),
      releaseRun: vi.fn(async () => {
        order.push("release");
      }),
    } as never;
  }

  function graphProvider(order: string[]) {
    const completeCollection = vi.fn(async (root: string) => {
      order.push(`complete:${root}`);
    });
    return {
      provider: makeProvider("codegraph.symbols", {
        finalizeSignals: vi.fn().mockResolvedValue(new Map()),
        defersChunkEnrichment: true,
        completeCollection,
      }),
      completeCollection,
    };
  }

  it("a finalize-only run completes the collection once, after the finalize and the release", async () => {
    const order: string[] = [];
    const graph = graphProvider(order);
    const coordinator = new EnrichmentCoordinator(
      qdrantStub() as never,
      [graph.provider],
      undefined,
      orderedExecutor(order),
    );

    await coordinator.runFinalizeOnly("/repo", "code_x_v3" as never);

    expect(graph.completeCollection).toHaveBeenCalledTimes(1);
    expect(graph.completeCollection).toHaveBeenCalledWith("/repo/effective", { collectionName: "code_x_v3" });
    expect(order).toEqual(["finalize:codegraph.symbols", "release", "complete:/repo/effective"]);
  });

  it("a whole-corpus recompute of the graph provider completes the collection once", async () => {
    const order: string[] = [];
    const graph = graphProvider(order);
    const coordinator = new EnrichmentCoordinator(
      qdrantStub() as never,
      [graph.provider],
      undefined,
      orderedExecutor(order),
    );

    await coordinator.recomputeEnrichments("code_x_v3" as never, "/repo", ["codegraph"], ["typescript"]);

    expect(graph.completeCollection).toHaveBeenCalledTimes(1);
    expect(order.indexOf("complete:/repo/effective")).toBeGreaterThan(order.indexOf("finalize:codegraph.symbols"));
  });

  it("a recompute that did not open the graph provider does not ask it", async () => {
    const order: string[] = [];
    const graph = graphProvider(order);
    const coordinator = new EnrichmentCoordinator(
      qdrantStub() as never,
      [makeProvider("git"), graph.provider],
      undefined,
      orderedExecutor(order),
    );

    await coordinator.recomputeEnrichments("code_x_v3" as never, "/repo", ["git"], []);

    expect(graph.completeCollection).not.toHaveBeenCalled();
  });
});
