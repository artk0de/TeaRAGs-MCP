/**
 * The payload healer groups a point under the symbol that OWNS it, not under
 * the point's payload symbolId (bd tea-rags-mcp-9i2ow).
 *
 * The owner comes from the injected chunk-owner resolver, which the api layer
 * builds over the codegraph trajectory's shared rule. Matching by payload
 * symbolId meant a moved NESTED symbol never reached its points — nested
 * symbols have no points of their own — and an outer symbol's write landed on a
 * point the nested one owns: chunk 282-303 of walker.ts took
 * `collectPythonInheritanceEdges`'s numbers instead of `.walkScope`'s.
 */

import { describe, expect, it, vi } from "vitest";

import type { CodegraphSignalDrift } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { BatchPayloadOp } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/batch-write.js";
import { CodegraphPayloadHealer } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/codegraph-payload-heal.js";

const PROVIDER_KEY = "codegraph.symbols";
const REL = "src/walker.ts";

interface StoredPoint {
  id: string;
  payload: Record<string, unknown>;
}

/** One page, streaming-pass only: a handful of points never favours per-file scrolls. */
class OnePageQdrantStub {
  readonly operations: BatchPayloadOp[] = [];
  payloadInclude: string[] | undefined;

  constructor(private readonly points: StoredPoint[]) {}

  async countPoints(): Promise<number> {
    return this.points.length;
  }

  async scrollFiltered(): Promise<never> {
    throw new Error("OnePageQdrantStub: per-file scroll requested; this spec expects the streaming pass");
  }

  async *scrollPayloadPages(
    _collectionName: string,
    payloadInclude: string[],
  ): AsyncGenerator<{ id: string | number; payload: Record<string, unknown> }[]> {
    this.payloadInclude = payloadInclude;
    yield this.points;
  }

  async batchSetPayload(_collectionName: string, operations: BatchPayloadOp[]): Promise<void> {
    this.operations.push(...operations);
  }

  chunkOps(): BatchPayloadOp[] {
    return this.operations.filter((op) => op.key === `${PROVIDER_KEY}.chunk`);
  }
}

function point(id: string, symbolId: string, startLine: number, endLine: number): StoredPoint {
  return { id, payload: { relativePath: REL, symbolId, startLine, endLine } };
}

/** Owner by the walker.ts ranges: anything starting inside 257-300 is `.walkScope`. */
const walkerOwner = vi.fn(
  async (_relPath: string, chunk: { startLine?: number; endLine?: number; symbolId?: string }) =>
    chunk.startLine !== undefined && chunk.startLine >= 257 && chunk.startLine <= 300
      ? "collectPythonInheritanceEdges.walkScope"
      : "collectPythonInheritanceEdges",
);

function makeHealer(stub: OnePageQdrantStub) {
  return new CodegraphPayloadHealer({
    qdrant: stub,
    providerKey: PROVIDER_KEY,
    buildFileSignals: async () => null,
    buildChunkSignals: async (_relPath, symbolId) => ({ owner: symbolId }),
    resolveChunkOwner: walkerOwner,
  });
}

const POINTS = (): StoredPoint[] => [
  point("head", "collectPythonInheritanceEdges", 240, 256),
  point("nested", "collectPythonInheritanceEdges#part2", 282, 303),
];

describe("CodegraphPayloadHealer chunk owner (bd tea-rags-mcp-9i2ow)", () => {
  it("reaches the points a moved nested symbol owns", async () => {
    const stub = new OnePageQdrantStub(POINTS());
    const drift: CodegraphSignalDrift = {
      symbols: [{ relPath: REL, symbolId: "collectPythonInheritanceEdges.walkScope" }],
      files: [],
    };

    const result = await makeHealer(stub).heal("coll", drift, new Set());

    expect(stub.chunkOps()).toEqual([
      {
        key: `${PROVIDER_KEY}.chunk`,
        points: ["nested"],
        payload: { owner: "collectPythonInheritanceEdges.walkScope" },
      },
    ]);
    expect(result).toEqual({ pointsRewritten: 1, filesTouched: 1 });
  });

  it("keeps a moved outer symbol's write off the point a nested symbol owns", async () => {
    const stub = new OnePageQdrantStub([
      ...POINTS(),
      // Payload symbolId is the OUTER function, but the chunk starts inside walkScope.
      point("anchored-outer", "collectPythonInheritanceEdges", 270, 290),
    ]);
    const drift: CodegraphSignalDrift = {
      symbols: [{ relPath: REL, symbolId: "collectPythonInheritanceEdges" }],
      files: [],
    };

    await makeHealer(stub).heal("coll", drift, new Set());

    expect(stub.chunkOps().flatMap((op) => op.points)).toEqual(["head"]);
  });

  it("hands the resolver each point's stored span and symbolId, and projects both line keys", async () => {
    walkerOwner.mockClear();
    const stub = new OnePageQdrantStub(POINTS());

    await makeHealer(stub).heal(
      "coll",
      { symbols: [{ relPath: REL, symbolId: "collectPythonInheritanceEdges" }], files: [] },
      new Set(),
    );

    expect(stub.payloadInclude).toEqual(expect.arrayContaining(["startLine", "endLine", "symbolId"]));
    expect(walkerOwner).toHaveBeenCalledWith(REL, {
      startLine: 282,
      endLine: 303,
      symbolId: "collectPythonInheritanceEdges#part2",
    });
  });
});
