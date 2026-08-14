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
    delete process.env.CODEGRAPH_CHECKPOINT_EVERY;
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
      prepareResolvePass: () => undefined,
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

  it("carries each resolver's cache diagnostics in the pass-2 progress line", async () => {
    // bd tea-rags-mcp-6aytq: whether the TypeScript whole-project Program was
    // built, and whether it is actually serving the corpus, was invisible in
    // production — the only evidence was wall clock, which cannot tell a
    // Program that was never built from one that is being missed.
    const resolutionRunner = {
      prepareResolvePass: () => undefined,
      resolverDiagnostics: () => ({ typescript: { wholeProgramFiles: 18042, entryBuilds: 0 } }),
      resolve: (): GraphEdges => ({ fileEdges: [], methodEdges: [] }),
    } as unknown as CallEdgeResolutionRunner;
    const resolveStore: GraphStoreResolver = async () => ({
      graphDb: makeGraphDb(),
      symbolTable: {} as GlobalSymbolTable,
    });
    const finalizer = new GraphBuildFinalizer(resolveStore, resolutionRunner, new CodegraphRunState());
    const lines: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]): void => {
      if (args[0] === "[GitEnrich] PHASE: CODEGRAPH_PASS2_PROGRESS") lines.push(String(args[1]));
    };

    try {
      // The progress line fires every 100 files.
      await finalizer.resolveAndUpsert(
        writeSpill(Array.from({ length: 100 }, (_, i) => ({ ...EXTRACTION, relPath: `src/f${i}.ts` }))),
      );
    } finally {
      console.error = realError;
    }

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      processed: 100,
      resolvers: { typescript: { wholeProgramFiles: 18042, entryBuilds: 0 } },
    });
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
      prepareResolvePass: () => undefined,
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
      prepareResolvePass: () => undefined,
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

  it("rebuilds the edge-file target index at the same cadence as CHECKPOINT (bd tea-rags-mcp-wgt19)", async () => {
    process.env.CODEGRAPH_CHECKPOINT_EVERY = "1";
    let checkpointCalls = 0;
    let rebuildCalls = 0;
    const graphDb = makeGraphDb({
      checkpoint: async () => {
        checkpointCalls += 1;
      },
      rebuildEdgeFileTargetIndex: async () => {
        rebuildCalls += 1;
      },
    });
    const resolutionRunner = {
      prepareResolvePass: () => undefined,
      resolve: (): GraphEdges => ({ fileEdges: [], methodEdges: [] }),
    } as unknown as CallEdgeResolutionRunner;
    const finalizer = new GraphBuildFinalizer(
      async () => ({ graphDb, symbolTable: {} as GlobalSymbolTable }),
      resolutionRunner,
      new CodegraphRunState(),
    );

    const spillPath = writeSpill([{ ...EXTRACTION, relPath: "src/a.ts", language: "typescript" }]);
    await finalizer.resolveAndUpsert(spillPath);

    // checkpoint() runs once before the rebuild and once after — the second
    // flushes the DROP/CREATE INDEX's own WAL entry so an in-process
    // READ_ONLY reader sees consistent state instead of racing the next
    // checkpoint (tests/.../provider-persisted-file-hashes.test.ts caught
    // the omission live: readPersistedFileHashes read stale data without it).
    expect(checkpointCalls).toBe(2);
    expect(rebuildCalls).toBe(1);
  });

  it("does not let a rebuildEdgeFileTargetIndex failure abort an otherwise-successful checkpoint", async () => {
    process.env.CODEGRAPH_CHECKPOINT_EVERY = "1";
    const graphDb = makeGraphDb({
      checkpoint: async () => undefined,
      rebuildEdgeFileTargetIndex: async () => {
        throw new Error("index rebuild boom");
      },
    });
    const resolutionRunner = {
      prepareResolvePass: () => undefined,
      resolve: (): GraphEdges => ({ fileEdges: [], methodEdges: [] }),
    } as unknown as CallEdgeResolutionRunner;
    const finalizer = new GraphBuildFinalizer(
      async () => ({ graphDb, symbolTable: {} as GlobalSymbolTable }),
      resolutionRunner,
      new CodegraphRunState(),
    );

    const spillPath = writeSpill([{ ...EXTRACTION, relPath: "src/a.ts", language: "typescript" }]);
    await expect(finalizer.resolveAndUpsert(spillPath)).resolves.toBeUndefined();
  });

  it("flushes before buffering a relPath that already has an entry pending in this batch (bd tea-rags-mcp-ksfq1)", async () => {
    // A relPath can legitimately appear twice in one spill — re-walking the
    // same file mid-run is supported (symbolTable.upsertFile replaces, not
    // appends; provider.test.ts "re-walking the same file... idempotent"
    // pins exactly this). But `cg_symbols_edges_file`'s PRIMARY KEY is
    // (source, target), and DuckDB does not reject a same-key double-INSERT
    // gracefully within one transaction: it aborts with a native
    // FatalException, killing the daemon process (live-reproduced against
    // taxdome). Two pending entries for one relPath must never land in the
    // SAME upsertFilesBulk call — flush the first out before buffering the
    // second, so each gets its own DELETE-then-INSERT transaction.
    const upsertedBatches: BulkFileUpsertEntry[][] = [];
    const graphDb = makeGraphDb({
      upsertFilesBulk: async (entries: readonly BulkFileUpsertEntry[]) => {
        upsertedBatches.push([...entries]);
      },
    });
    const resolutionRunner = {
      prepareResolvePass: () => undefined,
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

    // Same relPath twice, well within one BULK_FILES-sized window (default
    // 256) — nothing here forces an intervening flush except the fix itself.
    const spillPath = writeSpill([
      { ...EXTRACTION, relPath: "src/a.ts", language: "typescript" },
      { ...EXTRACTION, relPath: "src/a.ts", language: "typescript" },
    ]);
    await expect(finalizer.resolveAndUpsert(spillPath)).resolves.toBeUndefined();

    expect(upsertedBatches).toHaveLength(2);
    expect(upsertedBatches[0]).toHaveLength(1);
    expect(upsertedBatches[1]).toHaveLength(1);
    expect(upsertedBatches[0]?.[0]?.node.relPath).toBe("src/a.ts");
    expect(upsertedBatches[1]?.[0]?.node.relPath).toBe("src/a.ts");
  });

  it("prepares the resolve pass BEFORE the first spill line is resolved (bd tea-rags-mcp-6aytq)", async () => {
    // Pass-1 already counted the files pass-2 is about to resolve, so a bulk
    // run must hand that volume to the resolvers before the first acquire —
    // priming after the first file is what makes a TS run pay the warm-up
    // gate's 66 per-entry `ts.createProgram` builds (9-13 s on taxdome).
    const order: string[] = [];
    const resolutionRunner = {
      prepareResolvePass: () => {
        order.push("prepare");
      },
      resolve: (): GraphEdges => {
        order.push("resolve");
        return { fileEdges: [], methodEdges: [] };
      },
    } as unknown as CallEdgeResolutionRunner;
    const finalizer = new GraphBuildFinalizer(
      async () => ({ graphDb: makeGraphDb(), symbolTable: {} as GlobalSymbolTable }),
      resolutionRunner,
      new CodegraphRunState(),
    );

    const spillPath = writeSpill([
      { ...EXTRACTION, relPath: "src/a.ts", language: "typescript" },
      { ...EXTRACTION, relPath: "src/b.ts", language: "typescript" },
    ]);
    await finalizer.resolveAndUpsert(spillPath);

    expect(order).toEqual(["prepare", "resolve", "resolve"]);
  });

  it("includes the malformed line's own content (not just the file count) when a spill line fails JSON.parse", async () => {
    const graphDb = makeGraphDb();
    const resolutionRunner = {
      prepareResolvePass: () => undefined,
      resolve: (): GraphEdges => ({ fileEdges: [], methodEdges: [] }),
    } as unknown as CallEdgeResolutionRunner;
    const runState = new CodegraphRunState();
    const finalizer = new GraphBuildFinalizer(
      async () => ({ graphDb, symbolTable: {} as GlobalSymbolTable }),
      resolutionRunner,
      runState,
    );

    // One good line, then a corrupted line (mirrors a mid-stream spill
    // corruption, not just a malformed first line) — the count alone
    // ("after 1 files") gives no way to tell what the bad bytes actually
    // were; a live incident with two of these on record has had no way to
    // distinguish a truncated write from an interleaved write from garbage.
    const spillPath = join(tmp, "spill.ndjson");
    const goodLine = JSON.stringify({ ...EXTRACTION, relPath: "src/a.ts" });
    const badLine = '{"relPath": "src/b.ts", "broken"';
    writeFileSync(spillPath, `${goodLine}\n${badLine}\n`);

    let thrown: Error | undefined;
    try {
      await finalizer.resolveAndUpsert(spillPath);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).toContain("after 1 files");
    expect(thrown?.message).toContain(badLine);
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
