import { beforeEach, describe, expect, it } from "vitest";

import type { CodegraphSignalDrift } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { BatchPayloadOp } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/batch-write.js";
import { CodegraphPayloadHealer } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/codegraph-payload-heal.js";

const PROVIDER_KEY = "codegraph.symbols";

interface StoredPoint {
  id: string;
  payload: Record<string, unknown>;
}

/**
 * Minimal Qdrant stand-in that HONOURS the `relativePath` match the healer
 * scrolls with. `MockQdrantManager#scrollFiltered` ignores its filter and
 * returns the whole collection, which would make "does the heal stay inside the
 * file it is healing" — the assertion that matters most here — unfalsifiable.
 */
class FileScopedQdrantStub {
  readonly batchSetPayloadCalls: { collectionName: string; operations: BatchPayloadOp[] }[] = [];
  readonly scrolledPaths: string[] = [];
  /** Rejections to serve before the first successful write — one shift per call. */
  readonly writeFailures: Error[] = [];

  constructor(private readonly points: StoredPoint[]) {}

  async scrollFiltered(
    _collectionName: string,
    filter: Record<string, unknown>,
    _limit: number,
    _pageSize?: number,
    _payloadInclude?: string[],
  ): Promise<{ id: string | number; payload: Record<string, unknown> }[]> {
    const must = (filter.must ?? []) as { key: string; match: { value: string } }[];
    const wanted = must.find((c) => c.key === "relativePath")?.match.value;
    this.scrolledPaths.push(wanted ?? "<none>");
    return this.points.filter((p) => p.payload.relativePath === wanted).map((p) => ({ id: p.id, payload: p.payload }));
  }

  /**
   * APPLIES the write, with the nested-key merge real Qdrant performs and
   * `MockQdrantManager` models: with `key`, the payload is merged into the object
   * AT that dotted path and sibling sub-trees are left alone; without it, merged
   * at the root. Recording the operations alone cannot tell the two apart, which
   * is exactly the mistake the healer must not make.
   */
  async batchSetPayload(collectionName: string, operations: BatchPayloadOp[]): Promise<void> {
    const failure = this.writeFailures.shift();
    if (failure) throw failure;
    this.batchSetPayloadCalls.push({ collectionName, operations });
    for (const op of operations) {
      for (const id of op.points) {
        const point = this.points.find((p) => p.id === id);
        if (!point) continue;
        if (op.key) {
          let node: Record<string, unknown> = point.payload;
          for (const segment of op.key.split(".")) {
            node[segment] = { ...(node[segment] as Record<string, unknown> | undefined) };
            node = node[segment] as Record<string, unknown>;
          }
          Object.assign(node, op.payload);
        } else {
          point.payload = { ...point.payload, ...op.payload };
        }
      }
    }
  }

  payloadOf(id: string): Record<string, unknown> {
    const found = this.points.find((p) => p.id === id);
    if (!found) throw new Error(`no such point: ${id}`);
    return found.payload;
  }

  /** Every operation from every call, flattened — assertion convenience. */
  get operations(): BatchPayloadOp[] {
    return this.batchSetPayloadCalls.flatMap((c) => c.operations);
  }

  opsForKey(key: string): BatchPayloadOp[] {
    return this.operations.filter((o) => o.key === key);
  }
}

function point(id: string, relativePath: string, symbolId?: string, codegraph?: unknown): StoredPoint {
  return {
    id,
    payload: {
      relativePath,
      ...(symbolId ? { symbolId } : {}),
      ...(codegraph ? { codegraph } : {}),
    },
  };
}

const FILE_SIGNALS = { fanIn: 3, fanOut: 1, instability: 0.25, connectionCount: 4, isHub: false, isLeaf: false };
const CHUNK_SIGNALS = { fanIn: 2.5, fanOut: 4, pageRank: 0.0002 };

function makeHealer(stub: FileScopedQdrantStub, overrides: Partial<{ file: unknown; chunk: unknown }> = {}) {
  return new CodegraphPayloadHealer({
    qdrant: stub,
    providerKey: PROVIDER_KEY,
    buildFileSignals: async () => ("file" in overrides ? overrides.file : FILE_SIGNALS) as never,
    buildChunkSignals: async () => ("chunk" in overrides ? overrides.chunk : CHUNK_SIGNALS) as never,
  });
}

const NOTHING: CodegraphSignalDrift = { symbols: [], files: [] };

// bd tea-rags-mcp-a2ddb — the healer is the SECOND writer of
// `codegraph.symbols.{file,chunk}`. It rewrites the points a run's chunk map
// never reached, whose derived signals moved because the graph around them did.
describe("CodegraphPayloadHealer", () => {
  let stub: FileScopedQdrantStub;

  beforeEach(() => {
    stub = new FileScopedQdrantStub([
      point("p1", "src/hub.ts", "Hub#serve"),
      point("p2", "src/hub.ts", "Hub#idle"),
      point("p3", "src/leaf.ts", "leafFn"),
    ]);
  });

  it("writes file signals under the provider's `.file` key, one op for the whole file", async () => {
    const result = await makeHealer(stub).heal("coll", { symbols: [], files: [{ relPath: "src/hub.ts" }] }, new Set());

    const fileOps = stub.opsForKey(`${PROVIDER_KEY}.file`);
    expect(fileOps).toHaveLength(1);
    expect(fileOps[0].points.sort()).toEqual(["p1", "p2"]);
    expect(fileOps[0].payload).toEqual(FILE_SIGNALS);
    expect(result).toEqual({ pointsRewritten: 2, filesTouched: 1 });
  });

  // The level-scoped `key` is the whole point: a root write would replace the
  // `codegraph` subtree and take the sibling level down with it.
  it("never writes at the payload root", async () => {
    await makeHealer(stub).heal(
      "coll",
      { symbols: [{ relPath: "src/hub.ts", symbolId: "Hub#serve" }], files: [{ relPath: "src/hub.ts" }] },
      new Set(),
    );
    expect(stub.operations.every((o) => o.key !== undefined)).toBe(true);
    expect(stub.operations.some((o) => "codegraph" in o.payload)).toBe(false);
  });

  it("writes chunk signals only for the points whose symbol moved", async () => {
    await makeHealer(stub).heal(
      "coll",
      { symbols: [{ relPath: "src/hub.ts", symbolId: "Hub#serve" }], files: [] },
      new Set(),
    );

    const chunkOps = stub.opsForKey(`${PROVIDER_KEY}.chunk`);
    expect(chunkOps).toHaveLength(1);
    expect(chunkOps[0].points).toEqual(["p1"]);
    expect(chunkOps[0].payload).toEqual(CHUNK_SIGNALS);
    // `Hub#idle` did not move, so its point keeps whatever it had.
    expect(stub.opsForKey(`${PROVIDER_KEY}.file`)).toHaveLength(0);
  });

  it("skips the files this run's chunk map already rewrote", async () => {
    const result = await makeHealer(stub).heal(
      "coll",
      {
        symbols: [{ relPath: "src/hub.ts", symbolId: "Hub#serve" }],
        files: [{ relPath: "src/hub.ts" }, { relPath: "src/leaf.ts" }],
      },
      new Set(["src/hub.ts"]),
    );

    expect(stub.scrolledPaths).toEqual(["src/leaf.ts"]);
    expect(result).toEqual({ pointsRewritten: 1, filesTouched: 1 });
  });

  it("touches nothing at all when the diff is empty", async () => {
    const result = await makeHealer(stub).heal("coll", NOTHING, new Set());
    expect(stub.scrolledPaths).toEqual([]);
    expect(stub.batchSetPayloadCalls).toEqual([]);
    expect(result).toEqual({ pointsRewritten: 0, filesTouched: 0 });
  });

  it("stamps the run's enrichedAt alongside the signals", async () => {
    await makeHealer(stub).heal(
      "coll",
      { symbols: [{ relPath: "src/hub.ts", symbolId: "Hub#serve" }], files: [{ relPath: "src/hub.ts" }] },
      new Set(),
      "2026-09-11T00:00:00.000Z",
    );
    for (const op of stub.operations) {
      expect(op.payload.enrichedAt).toBe("2026-09-11T00:00:00.000Z");
    }
  });

  // `skippedAs` and `enrichedAt` are mutually exclusive terminal states of one
  // decision; writing signals over a decline would leave a point carrying both.
  it("leaves a level that the policy already declined alone", async () => {
    stub = new FileScopedQdrantStub([
      point("p1", "src/gen.ts", "genFn", {
        symbols: { file: { skippedAs: "generated" }, chunk: { skippedAs: "generated" } },
      }),
      point("p2", "src/gen.ts", "otherFn"),
    ]);
    await makeHealer(stub).heal(
      "coll",
      {
        symbols: [
          { relPath: "src/gen.ts", symbolId: "genFn" },
          { relPath: "src/gen.ts", symbolId: "otherFn" },
        ],
        files: [{ relPath: "src/gen.ts" }],
      },
      new Set(),
    );

    expect(stub.opsForKey(`${PROVIDER_KEY}.file`)[0]?.points).toEqual(["p2"]);
    const chunkOps = stub.opsForKey(`${PROVIDER_KEY}.chunk`);
    expect(chunkOps.flatMap((o) => o.points)).toEqual(["p2"]);
  });

  it("writes nothing for a file the graph can no longer describe", async () => {
    await makeHealer(stub, { file: null }).heal("coll", { symbols: [], files: [{ relPath: "src/hub.ts" }] }, new Set());
    expect(stub.batchSetPayloadCalls).toEqual([]);
  });

  it("coalesces the points of one symbol into a single chunk operation", async () => {
    stub = new FileScopedQdrantStub([
      point("p1", "src/big.ts", "Big#run"),
      point("p2", "src/big.ts", "Big#run"),
      point("p3", "src/big.ts", "Big#other"),
    ]);
    await makeHealer(stub).heal(
      "coll",
      { symbols: [{ relPath: "src/big.ts", symbolId: "Big#run" }], files: [] },
      new Set(),
    );
    const chunkOps = stub.opsForKey(`${PROVIDER_KEY}.chunk`);
    expect(chunkOps).toHaveLength(1);
    expect(chunkOps[0].points.sort()).toEqual(["p1", "p2"]);
  });

  // The per-file loop runs several workers off one cursor. `x += await f()`
  // reads `x` BEFORE suspending, so each worker would add to the value it saw
  // on entry and the others' counts would vanish — a wrong number in the
  // pipeline log, and a heal that looks like it did less than it did.
  it("counts every file's points when more files than workers are in flight", async () => {
    const files = Array.from({ length: 24 }, (_, i) => `src/f${i}.ts`);
    stub = new FileScopedQdrantStub(files.map((f, i) => point(`p${i}`, f, `fn${i}`)));

    const result = await makeHealer(stub).heal(
      "coll",
      { symbols: [], files: files.map((relPath) => ({ relPath })) },
      new Set(),
    );

    expect(result).toEqual({ pointsRewritten: 24, filesTouched: 24 });
  });

  it("counts a point that took both levels once", async () => {
    const result = await makeHealer(stub).heal(
      "coll",
      { symbols: [{ relPath: "src/hub.ts", symbolId: "Hub#serve" }], files: [{ relPath: "src/hub.ts" }] },
      new Set(),
    );
    expect(result).toEqual({ pointsRewritten: 2, filesTouched: 1 });
  });

  // The level-scoped `key` claim, checked on the STORED payload rather than on
  // the operation's shape: a root write would take both sibling blocks with it
  // and still satisfy an assertion about `op.key`.
  it("leaves the sibling file block and another provider's subtree byte-for-byte intact", async () => {
    const priorFile = { fanIn: 9, fanOut: 2, isHub: true, enrichedAt: "2026-01-01T00:00:00.000Z" };
    const priorGit = { commitCount: 12, ageDays: 40 };
    stub = new FileScopedQdrantStub([
      {
        id: "p1",
        payload: {
          relativePath: "src/hub.ts",
          symbolId: "Hub#serve",
          codegraph: { symbols: { file: { ...priorFile }, chunk: { fanIn: 0, fanOut: 0, pageRank: 0 } } },
          git: { file: { ...priorGit } },
        },
      },
    ]);

    await makeHealer(stub).heal(
      "coll",
      { symbols: [{ relPath: "src/hub.ts", symbolId: "Hub#serve" }], files: [] },
      new Set(),
    );

    const payload = stub.payloadOf("p1");
    const codegraph = payload.codegraph as { symbols: { file: unknown; chunk: unknown } };
    expect(codegraph.symbols.file).toEqual(priorFile);
    expect(payload.git).toEqual({ file: priorGit });
    expect(codegraph.symbols.chunk).toEqual(CHUNK_SIGNALS);
  });

  // `batch-write.ts` exists because one transient blip used to drop a whole
  // batch of signals silently. The heal is the same kind of write.
  it("absorbs a transient write failure and still heals", async () => {
    stub.writeFailures.push(new Error("qdrant timeout"));

    const result = await makeHealer(stub).heal("coll", { symbols: [], files: [{ relPath: "src/hub.ts" }] }, new Set());

    expect(result).toEqual({ pointsRewritten: 2, filesTouched: 1 });
    expect(stub.batchSetPayloadCalls).toHaveLength(1);
    expect((stub.payloadOf("p1").codegraph as { symbols: { file: unknown } }).symbols.file).toEqual(FILE_SIGNALS);
  });

  // A scroll that comes back exactly at the cap may have more behind it, and
  // `scrollFiltered` gives no way to tell. Healing the visible part would let the
  // run advance the baseline over drift that was never written — erasing it.
  it("refuses a file whose scroll came back at the cap instead of healing it partially", async () => {
    const capped = {
      scrollFiltered: async () =>
        Array.from({ length: 10_000 }, (_, i) => ({
          id: `p${i}`,
          payload: { relativePath: "src/huge.ts", symbolId: `fn${i}` },
        })),
      batchSetPayload: async () => {
        throw new Error("must not write a partially-read file");
      },
    };
    const healer = new CodegraphPayloadHealer({
      qdrant: capped,
      providerKey: PROVIDER_KEY,
      buildFileSignals: async () => FILE_SIGNALS,
      buildChunkSignals: async () => CHUNK_SIGNALS,
    });

    await expect(healer.heal("coll", { symbols: [], files: [{ relPath: "src/huge.ts" }] }, new Set())).rejects.toThrow(
      /scroll cap/,
    );
  });
});
