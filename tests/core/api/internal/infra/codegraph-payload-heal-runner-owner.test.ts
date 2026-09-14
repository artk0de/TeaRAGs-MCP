/**
 * The heal runner resolves each point's owner through the codegraph chunk-owner
 * rule over the ranges persisted in `cg_symbols` (bd tea-rags-mcp-9i2ow).
 *
 * The healer runs outside any walk, so the ranges come from
 * `getSymbolLineRangesBulk`; a file whose rows predate migration 024 has none,
 * and then every point keeps its own payload symbolId (`#partN` stripped) —
 * the heal as it was before the ranges existed.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createCodegraphPayloadHealRunner,
  type CodegraphPayloadHealRunnerDeps,
} from "../../../../../src/core/api/internal/infra/codegraph-payload-heal-runner.js";
import type {
  CodegraphSignalDrift,
  GraphDbClient,
  SymbolLineRange,
} from "../../../../../src/core/contracts/types/codegraph.js";
import type { BatchPayloadOp } from "../../../../../src/core/domains/ingest/pipeline/enrichment/batch-write.js";

const PROVIDER_KEY = "codegraph.symbols";
const REL = "src/walker.ts";

interface StoredPoint {
  id: string;
  relativePath: string;
  symbolId: string;
  startLine: number;
  endLine: number;
}

class OnePageQdrantStub {
  readonly writes: BatchPayloadOp[] = [];

  constructor(private readonly points: StoredPoint[]) {}

  async countPoints(): Promise<number> {
    return this.points.length;
  }

  async scrollFiltered(): Promise<never> {
    throw new Error("OnePageQdrantStub: per-file scroll requested; this spec expects the streaming pass");
  }

  async *scrollPayloadPages(): AsyncGenerator<{ id: string | number; payload: Record<string, unknown> }[]> {
    yield this.points.map(({ id, ...payload }) => ({ id, payload }));
  }

  async batchSetPayload(_collectionName: string, operations: BatchPayloadOp[]): Promise<void> {
    this.writes.push(...operations);
  }

  chunkWrites(): BatchPayloadOp[] {
    return this.writes.filter((op) => op.key === `${PROVIDER_KEY}.chunk`);
  }
}

const SIGNALS = new Map([
  ["collectPythonInheritanceEdges", { fanIn: 1, fanOut: 1, pageRank: 0.1 }],
  ["collectPythonInheritanceEdges.walkScope", { fanIn: 3, fanOut: 6, pageRank: 0.3 }],
]);

function graphDbStub(drift: CodegraphSignalDrift, ranges: Map<string, SymbolLineRange[]>) {
  return {
    diffSymbolSignals: vi.fn().mockResolvedValue(drift),
    refreshSymbolSignalsPrev: vi.fn().mockResolvedValue(undefined),
    getFanInP95: vi.fn().mockResolvedValue(1),
    getFileMetricsBulk: vi.fn().mockResolvedValue(new Map()),
    getChunkSignalsBulk: vi.fn().mockResolvedValue(SIGNALS),
    getSymbolLineRangesBulk: vi.fn(async (relPaths: readonly string[]) =>
      Promise.resolve(new Map([...ranges].filter(([relPath]) => relPaths.includes(relPath)))),
    ),
  };
}

async function heal(points: StoredPoint[], graphDb: ReturnType<typeof graphDbStub>): Promise<OnePageQdrantStub> {
  const qdrant = new OnePageQdrantStub(points);
  const deps: CodegraphPayloadHealRunnerDeps = {
    qdrant: qdrant as unknown as CodegraphPayloadHealRunnerDeps["qdrant"],
    acquireGraphDb: async () => Promise.resolve(graphDb as unknown as GraphDbClient),
    providerKey: PROVIDER_KEY,
  };
  await createCodegraphPayloadHealRunner(deps).run("coll", new Set());
  return qdrant;
}

const WALKER_RANGES = new Map<string, SymbolLineRange[]>([
  [
    REL,
    [
      { symbolId: "collectPythonInheritanceEdges", startLine: 240, endLine: 320 },
      { symbolId: "collectPythonInheritanceEdges.walkScope", startLine: 257, endLine: 300 },
    ],
  ],
]);

const POINTS: StoredPoint[] = [
  { id: "head", relativePath: REL, symbolId: "collectPythonInheritanceEdges", startLine: 240, endLine: 256 },
  { id: "nested", relativePath: REL, symbolId: "collectPythonInheritanceEdges#part2", startLine: 282, endLine: 303 },
];

describe("createCodegraphPayloadHealRunner chunk owner (bd tea-rags-mcp-9i2ow)", () => {
  it("writes a moved nested symbol's signals onto the point its persisted range owns", async () => {
    const graphDb = graphDbStub(
      { symbols: [{ relPath: REL, symbolId: "collectPythonInheritanceEdges.walkScope" }], files: [] },
      WALKER_RANGES,
    );

    const qdrant = await heal(POINTS, graphDb);

    expect(qdrant.chunkWrites()).toEqual([
      { key: `${PROVIDER_KEY}.chunk`, points: ["nested"], payload: { fanIn: 3, fanOut: 6, pageRank: 0.3 } },
    ]);
  });

  it("falls back to each point's own payload symbolId, `#part` stripped, when the file has no ranges", async () => {
    const graphDb = graphDbStub(
      { symbols: [{ relPath: REL, symbolId: "collectPythonInheritanceEdges" }], files: [] },
      new Map(),
    );

    const qdrant = await heal(POINTS, graphDb);

    expect(
      qdrant
        .chunkWrites()
        .flatMap((op) => op.points)
        .sort(),
    ).toEqual(["head", "nested"]);
    for (const op of qdrant.chunkWrites()) expect(op.payload).toEqual({ fanIn: 1, fanOut: 1, pageRank: 0.1 });
  });

  it("reads the ranges once per run, for the files whose symbols moved", async () => {
    const graphDb = graphDbStub(
      {
        symbols: [
          { relPath: REL, symbolId: "collectPythonInheritanceEdges" },
          { relPath: REL, symbolId: "collectPythonInheritanceEdges.walkScope" },
          { relPath: "src/other.ts", symbolId: "other" },
        ],
        files: [{ relPath: "src/file-only.ts" }],
      },
      WALKER_RANGES,
    );

    await heal(
      [...POINTS, { id: "o", relativePath: "src/other.ts", symbolId: "other", startLine: 1, endLine: 4 }],
      graphDb,
    );

    expect(graphDb.getSymbolLineRangesBulk).toHaveBeenCalledTimes(1);
    expect(graphDb.getSymbolLineRangesBulk).toHaveBeenCalledWith([REL, "src/other.ts"]);
  });
});
