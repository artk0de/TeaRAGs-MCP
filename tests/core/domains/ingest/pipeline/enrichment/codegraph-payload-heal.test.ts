import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CodegraphSignalDrift } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { BatchPayloadOp } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/batch-write.js";
import { CodegraphPayloadHealer } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/codegraph-payload-heal.js";
import { pipelineLog } from "../../../../../../src/core/domains/ingest/pipeline/infra/debug-logger.js";

const PROVIDER_KEY = "codegraph.symbols";

interface StoredPoint {
  id: string;
  payload: Record<string, unknown>;
}

/**
 * Minimal Qdrant stand-in that serves the collection as PAGES, the way the
 * streaming pass reads it. `pageSize` is the stub's own, not the healer's: it
 * is how a test puts a chosen boundary between two points, which is the only
 * way to falsify "everything the target set names gets written even when its
 * points land in different pages".
 */
class PagedQdrantStub {
  readonly batchSetPayloadCalls: { collectionName: string; operations: BatchPayloadOp[] }[] = [];
  /** Rejections to serve before the first successful write — one shift per call. */
  readonly writeFailures: Error[] = [];
  pagesServed = 0;
  payloadInclude: string[] | undefined;

  constructor(
    private readonly points: StoredPoint[],
    private readonly pageSize = 1000,
  ) {}

  async *scrollPayloadPages(
    _collectionName: string,
    payloadInclude: string[],
    _pageSize?: number,
  ): AsyncGenerator<{ id: string | number; payload: Record<string, unknown> }[]> {
    this.payloadInclude = payloadInclude;
    for (let start = 0; start < this.points.length; start += this.pageSize) {
      this.pagesServed++;
      yield this.points.slice(start, start + this.pageSize).map((p) => ({ id: p.id, payload: p.payload }));
    }
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

  /** Every point id that took at least one write, in no particular order. */
  get writtenIds(): (string | number)[] {
    return [...new Set(this.operations.flatMap((o) => o.points))];
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

function makeHealer(stub: PagedQdrantStub, overrides: Partial<{ file: unknown; chunk: unknown }> = {}) {
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
  let stub: PagedQdrantStub;

  beforeEach(() => {
    stub = new PagedQdrantStub([
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

  // The pass reads the WHOLE collection, so "which files it scrolled" says
  // nothing any more. What the skip set buys is unchanged and is what this pins:
  // a file the run's chunk map already rewrote takes no second write here.
  it("skips the files this run's chunk map already rewrote", async () => {
    const result = await makeHealer(stub).heal(
      "coll",
      {
        symbols: [{ relPath: "src/hub.ts", symbolId: "Hub#serve" }],
        files: [{ relPath: "src/hub.ts" }, { relPath: "src/leaf.ts" }],
      },
      new Set(["src/hub.ts"]),
    );

    expect(stub.writtenIds).toEqual(["p3"]);
    expect(result).toEqual({ pointsRewritten: 1, filesTouched: 1 });
  });

  // The pass is the expensive part — on a large collection it is the only
  // expensive part — so an empty diff must not start one.
  it("touches nothing at all when the diff is empty", async () => {
    const result = await makeHealer(stub).heal("coll", NOTHING, new Set());
    expect(stub.pagesServed).toBe(0);
    expect(stub.batchSetPayloadCalls).toEqual([]);
    expect(result).toEqual({ pointsRewritten: 0, filesTouched: 0 });
  });

  // A point outside the target set is a point whose signals did NOT move.
  // Writing it would stamp this run's `enrichedAt` onto numbers the run never
  // recomputed — and on a full-collection pass every such point is one page
  // boundary away from being written by accident.
  it("leaves every point outside the target set untouched", async () => {
    stub = new PagedQdrantStub(
      [
        point("p1", "src/hub.ts", "Hub#serve"),
        point("p2", "src/other.ts", "Other#run"),
        point("p3", "src/third.ts", "Third#run"),
      ],
      1,
    );

    await makeHealer(stub).heal(
      "coll",
      { symbols: [{ relPath: "src/hub.ts", symbolId: "Hub#serve" }], files: [{ relPath: "src/hub.ts" }] },
      new Set(),
    );

    expect(stub.writtenIds).toEqual(["p1"]);
    expect(stub.payloadOf("p2").codegraph).toBeUndefined();
    expect(stub.payloadOf("p3").codegraph).toBeUndefined();
  });

  // The projection is the pass's whole transfer cost, multiplied by every point
  // in the collection. Pulling the `codegraph` subtree instead of the two stamp
  // paths would drag the file and chunk signal blocks along — blocks this pass
  // overwrites and never reads.
  it("reads only the payload keys it needs, the decline stamps as nested paths", async () => {
    await makeHealer(stub).heal("coll", { symbols: [], files: [{ relPath: "src/hub.ts" }] }, new Set());
    expect(stub.payloadInclude).toEqual([
      "relativePath",
      "symbolId",
      `${PROVIDER_KEY}.file.skippedAs`,
      `${PROVIDER_KEY}.chunk.skippedAs`,
    ]);
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
    stub = new PagedQdrantStub([
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

  // The decline is per LEVEL, not per point: the two are separate terminal
  // states on the same physical point, so a file-level decline says nothing
  // about the chunk level. Declining both at once — the case above — cannot
  // tell a per-level guard from a per-point one.
  it("writes the level that was not declined on a point declined at the other", async () => {
    stub = new PagedQdrantStub([
      point("p1", "src/half.ts", "halfFn", { symbols: { file: { skippedAs: "generated" } } }),
      point("p2", "src/half.ts", "otherFn", { symbols: { chunk: { skippedAs: "generated" } } }),
    ]);

    await makeHealer(stub).heal(
      "coll",
      {
        symbols: [
          { relPath: "src/half.ts", symbolId: "halfFn" },
          { relPath: "src/half.ts", symbolId: "otherFn" },
        ],
        files: [{ relPath: "src/half.ts" }],
      },
      new Set(),
    );

    // p1 declined at file level only -> takes the chunk write, not the file one.
    // p2 declined at chunk level only -> the mirror.
    expect(stub.opsForKey(`${PROVIDER_KEY}.file`).flatMap((o) => o.points)).toEqual(["p2"]);
    expect(stub.opsForKey(`${PROVIDER_KEY}.chunk`).flatMap((o) => o.points)).toEqual(["p1"]);
  });

  it("writes nothing for a file the graph can no longer describe", async () => {
    await makeHealer(stub, { file: null }).heal("coll", { symbols: [], files: [{ relPath: "src/hub.ts" }] }, new Set());
    expect(stub.batchSetPayloadCalls).toEqual([]);
  });

  it("coalesces the points of one symbol into a single chunk operation", async () => {
    stub = new PagedQdrantStub([
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

  // Page boundaries are the server's business, not the target set's. A symbol
  // whose chunks land either side of one yields two ops carrying the same
  // payload — harmless, because both are key-scoped — but every id must be
  // written, or a point keeps stale numbers that nothing will ever revisit:
  // the baseline advances once `heal` resolves.
  it("writes every id of a file and symbol whose points straddle a page boundary", async () => {
    stub = new PagedQdrantStub(
      [point("p1", "src/big.ts", "Big#run"), point("p2", "src/big.ts", "Big#run")],
      1, // one point per page: the two ids can only be seen in different pages
    );

    const result = await makeHealer(stub).heal(
      "coll",
      { symbols: [{ relPath: "src/big.ts", symbolId: "Big#run" }], files: [{ relPath: "src/big.ts" }] },
      new Set(),
    );

    expect(stub.pagesServed).toBe(2);
    for (const id of ["p1", "p2"]) {
      const codegraph = stub.payloadOf(id).codegraph as { symbols: { file: unknown; chunk: unknown } };
      expect(codegraph.symbols.file).toEqual(FILE_SIGNALS);
      expect(codegraph.symbols.chunk).toEqual(CHUNK_SIGNALS);
    }
    expect(result).toEqual({ pointsRewritten: 2, filesTouched: 1 });
  });

  // `pointsRewritten` counts DISTINCT points, and the pass flushes per page, so
  // a naive per-page sum would double-count nothing but a per-page reset would
  // lose everything before the last page. Spread the target set over many pages
  // and the total must still be the number of points.
  it("counts every point of a target set spread across many pages", async () => {
    const files = Array.from({ length: 24 }, (_, i) => `src/f${i}.ts`);
    stub = new PagedQdrantStub(
      files.map((f, i) => point(`p${i}`, f, `fn${i}`)),
      1,
    );

    const result = await makeHealer(stub).heal(
      "coll",
      { symbols: [], files: files.map((relPath) => ({ relPath })) },
      new Set(),
    );

    expect(stub.pagesServed).toBe(24);
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

  // A full-collection sweep on a large index runs for minutes. Printing nothing
  // while it does is how the first live heal looked like a hang.
  it("reports progress while the pass is still running", async () => {
    const spy = vi.spyOn(pipelineLog, "enrichmentPhase");
    const files = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`);
    stub = new PagedQdrantStub(
      files.map((f, i) => point(`p${i}`, f, `fn${i}`)),
      1,
    );

    await makeHealer(stub).heal("coll", { symbols: [], files: files.map((relPath) => ({ relPath })) }, new Set());

    const progress = spy.mock.calls.filter(([phase]) => phase === "CODEGRAPH_PAYLOAD_HEAL_PROGRESS");
    expect(progress).toHaveLength(2); // one line per 10 pages of 20
    expect(progress[0][1]).toMatchObject({ collection: "coll", pagesScanned: 10, pointsScanned: 10 });
    expect(progress[1][1]).toMatchObject({ pagesScanned: 20, pointsScanned: 20, pointsWritten: 20 });
    spy.mockRestore();
  });

  // The level-scoped `key` claim, checked on the STORED payload rather than on
  // the operation's shape: a root write would take both sibling blocks with it
  // and still satisfy an assertion about `op.key`.
  it("leaves the sibling file block and another provider's subtree byte-for-byte intact", async () => {
    const priorFile = { fanIn: 9, fanOut: 2, isHub: true, enrichedAt: "2026-01-01T00:00:00.000Z" };
    const priorGit = { commitCount: 12, ageDays: 40 };
    stub = new PagedQdrantStub([
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

  // The other half of the retry change, and the half that protects the baseline:
  // `batchSetPayloadWithRetry` reports an exhausted budget by RETURNING false, so
  // a caller that ignores the result resolves normally, the runner advances
  // `cg_*_signals_prev`, and points that were never written are recorded as
  // healed — drift erased, silently, with the run reporting success.
  //
  // Three rejections is the wrapper's whole attempt budget, so this costs its
  // 100ms + 200ms backoff. The healer takes the wrapper's defaults deliberately
  // (production wants the backoff), so the wait is paid here rather than
  // injected away.
  it("refuses to report a heal when the write budget is exhausted", async () => {
    stub.writeFailures.push(new Error("qdrant down"), new Error("qdrant down"), new Error("qdrant down"));

    await expect(
      makeHealer(stub).heal("coll", { symbols: [], files: [{ relPath: "src/hub.ts" }] }, new Set()),
    ).rejects.toThrow(/failed after every retry/);

    // Nothing recorded as written, and the stored payload never gained the
    // signals — so the next run's diff still names this file.
    expect(stub.batchSetPayloadCalls).toEqual([]);
    expect(stub.payloadOf("p1").codegraph).toBeUndefined();
  });

  // The throw has to abandon the pass, not just the page: a later page that
  // wrote successfully would leave the run reporting a heal it did not finish,
  // and the runner would refresh the baseline over the pages it never reached.
  it("abandons the whole pass when a page's write budget is exhausted", async () => {
    stub = new PagedQdrantStub([point("p1", "src/a.ts", "aFn"), point("p2", "src/b.ts", "bFn")], 1);
    stub.writeFailures.push(new Error("qdrant down"), new Error("qdrant down"), new Error("qdrant down"));

    await expect(
      makeHealer(stub).heal(
        "coll",
        { symbols: [], files: [{ relPath: "src/a.ts" }, { relPath: "src/b.ts" }] },
        new Set(),
      ),
      // The page and the files it was writing, so the reader of a failed run
      // has somewhere to start rather than "a write failed, somewhere".
    ).rejects.toThrow(/page 1 failed after every retry, covering src\/a\.ts/);

    expect(stub.pagesServed).toBe(1);
    expect(stub.payloadOf("p2").codegraph).toBeUndefined();
  });
});
