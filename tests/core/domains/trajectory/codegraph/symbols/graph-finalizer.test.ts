/**
 * GraphBuildFinalizer (bd tea-rags-mcp-6vfrj / G2) — pass-2 streaming loop
 * (resolve → bulk upsert → checkpoint) plus the post-pass Tarjan SCC /
 * PageRank recompute, extracted verbatim from `CodegraphEnrichmentProvider`.
 *
 * The MAX_EDGES_PER_FILE pathological-file skip used to be exercised through
 * the provider facade by monkey-patching `provider.resolveExtraction` (see
 * `provider-spill-errors.test.ts`), but after the G2 split that private hook
 * is disconnected from the pass-2 loop — resolution now flows through the
 * injected `CallEdgeResolutionRunner` this finalizer holds directly. These
 * tests pin the behavior against the collaborator itself so the skip stays
 * covered regardless of how the facade wires things.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  BulkFileUpsertEntry,
  FileExtraction,
  GlobalSymbolTable,
  GraphDbClient,
  GraphEdges,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  GraphBuildFinalizer,
  type GraphStoreResolver,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/graph-finalizer.js";
import type { CallEdgeResolutionRunner } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { CodegraphMetricsError } from "../../../../../../src/core/domains/trajectory/errors.js";

function makeGraphDb(overrides: Partial<GraphDbClient> = {}): GraphDbClient {
  return {
    upsertFilesBulk: async () => undefined,
    checkpoint: async () => undefined,
    async *streamAdjacency() {
      /* no edges by default */
    },
    replaceCycles: async () => undefined,
    replacePageRanks: async () => undefined,
    ...overrides,
  } as unknown as GraphDbClient;
}

const EXTRACTION: FileExtraction = {
  relPath: "src/bundle.min.js",
  language: "javascript",
  imports: [],
  chunks: [],
  fileScope: [],
};

describe("GraphBuildFinalizer.resolveAndUpsert", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "graph-finalizer-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeSpill(lines: FileExtraction[]): string {
    const spillPath = join(tmp, "spill.ndjson");
    writeFileSync(spillPath, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length > 0 ? "\n" : ""));
    return spillPath;
  }

  it("skips a file whose resolved edge count exceeds MAX_EDGES_PER_FILE, continuing the loop without buffering it", async () => {
    let upsertCalls = 0;
    const graphDb = makeGraphDb({
      upsertFilesBulk: async (entries: readonly BulkFileUpsertEntry[]) => {
        upsertCalls += 1;
        expect(entries.length).toBeGreaterThan(0);
      },
    });
    // 11 000 file edges — over the 10 000 MAX_EDGES_PER_FILE cap. Mirrors the
    // minified-bundle shape the cap exists for (ugnest 96k-edge OOM).
    const resolutionRunner = {
      resolve: (): GraphEdges => ({
        fileEdges: Array.from({ length: 11000 }, (_, i) => ({ targetRelPath: `t${i}.ts`, importText: `t${i}` })),
        methodEdges: [],
      }),
    } as unknown as CallEdgeResolutionRunner;
    const runState = new CodegraphRunState();
    const resolveStore: GraphStoreResolver = async () => ({
      graphDb,
      symbolTable: {} as GlobalSymbolTable,
    });
    const finalizer = new GraphBuildFinalizer(resolveStore, resolutionRunner, runState);

    const spillPath = writeSpill([EXTRACTION]);
    await expect(finalizer.resolveAndUpsert(spillPath)).resolves.toBeUndefined();

    // The oversized file was SKIPPED, not failed: no bulk upsert landed for
    // it, and the run-global edge counters never saw its (synthetic) edges.
    expect(upsertCalls).toBe(0);
    expect(runState.stats.fileEdgeCount).toBe(0);
    expect(runState.stats.methodEdgeCount).toBe(0);
  });

  it("completes without upserting or checkpointing when the spill file has zero lines", async () => {
    let upsertCalls = 0;
    let checkpointCalls = 0;
    const graphDb = makeGraphDb({
      upsertFilesBulk: async () => {
        upsertCalls += 1;
      },
      checkpoint: async () => {
        checkpointCalls += 1;
      },
    });
    const resolutionRunner = {
      resolve: (): GraphEdges => ({ fileEdges: [], methodEdges: [] }),
    } as unknown as CallEdgeResolutionRunner;
    const runState = new CodegraphRunState();
    const finalizer = new GraphBuildFinalizer(
      async () => ({ graphDb, symbolTable: {} as GlobalSymbolTable }),
      resolutionRunner,
      runState,
    );

    const spillPath = writeSpill([]);
    await expect(finalizer.resolveAndUpsert(spillPath)).resolves.toBeUndefined();

    expect(upsertCalls).toBe(0);
    expect(checkpointCalls).toBe(0);
  });

  it("buffers and bulk-upserts a normal file's edges in a single batch transaction", async () => {
    const upsertedBatches: readonly BulkFileUpsertEntry[][] = [];
    const graphDb = makeGraphDb({
      upsertFilesBulk: async (entries: readonly BulkFileUpsertEntry[]) => {
        (upsertedBatches as BulkFileUpsertEntry[][]).push([...entries]);
      },
    });
    const resolutionRunner = {
      resolve: (): GraphEdges => ({
        fileEdges: [{ targetRelPath: "src/util.ts", importText: "./util" }],
        methodEdges: [],
      }),
    } as unknown as CallEdgeResolutionRunner;
    const runState = new CodegraphRunState();
    const finalizer = new GraphBuildFinalizer(
      async () => ({ graphDb, symbolTable: {} as GlobalSymbolTable }),
      resolutionRunner,
      runState,
    );

    const spillPath = writeSpill([{ ...EXTRACTION, relPath: "src/a.ts", language: "typescript" }]);
    await expect(finalizer.resolveAndUpsert(spillPath)).resolves.toBeUndefined();

    expect(upsertedBatches).toHaveLength(1);
    expect(upsertedBatches[0]?.[0]?.node.relPath).toBe("src/a.ts");
    expect(runState.stats.fileEdgeCount).toBe(1);
  });
});

describe("GraphBuildFinalizer.recomputeMetrics", () => {
  function makeFinalizer(graphDb: GraphDbClient): GraphBuildFinalizer {
    return new GraphBuildFinalizer(
      async () => ({ graphDb, symbolTable: {} as GlobalSymbolTable }),
      {} as unknown as CallEdgeResolutionRunner,
      new CodegraphRunState(),
    );
  }

  it("delegates to the daemon-routed computeAndPersistCyclesAndSignals when the graphDb handle exposes it, skipping the inline Tarjan/PageRank path", async () => {
    let delegateCalls = 0;
    let inlineCallsSeen = 0;
    const graphDb = makeGraphDb({
      computeAndPersistCyclesAndSignals: async () => {
        delegateCalls += 1;
      },
      replaceCycles: async () => {
        inlineCallsSeen += 1;
      },
    });
    const finalizer = makeFinalizer(graphDb);

    await expect(finalizer.recomputeMetrics()).resolves.toBeUndefined();

    expect(delegateCalls).toBe(1);
    expect(inlineCallsSeen).toBe(0);
  });

  it("re-wraps an already-typed CodegraphMetricsError surfacing from a lower stage as stage 'pagerank'", async () => {
    // recomputeMetrics's own catch special-cases an err that is ALREADY a
    // CodegraphMetricsError instance (as opposed to a plain Error from
    // DuckDB) and re-stamps it with the 'pagerank' stage — pinning that
    // observable re-wrap behavior regardless of which underlying call threw.
    const inner = new CodegraphMetricsError("tarjan", undefined);
    const graphDb = makeGraphDb({
      replaceCycles: async () => {
        throw inner;
      },
    });
    const finalizer = makeFinalizer(graphDb);

    try {
      await finalizer.recomputeMetrics();
      throw new Error("expected recomputeMetrics to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(CodegraphMetricsError);
      expect((err as Error).message).toContain("pagerank");
      expect((err as CodegraphMetricsError).cause).toBe(inner);
    }
  });

  it("wraps a plain DuckDB failure from the Tarjan stage as stage 'tarjan'", async () => {
    const graphDb = makeGraphDb({
      replaceCycles: async () => {
        throw new Error("duckdb write denied");
      },
    });
    const finalizer = makeFinalizer(graphDb);

    await expect(finalizer.recomputeMetrics()).rejects.toMatchObject({
      message: expect.stringContaining("tarjan") as unknown as string,
    });
  });
});
