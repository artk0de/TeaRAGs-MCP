/**
 * An optional overlay key the new overlay leaves out must leave the stored
 * payload too (bd tea-rags-mcp-9mwny / k8gac follow-up C3).
 *
 * `set_payload` with `key` MERGES into the stored object, and a key whose value
 * is `undefined` never reaches the wire — so a chunk whose walk now finds no
 * commit kept the `ageDays` of an earlier run (286 such chunks on the
 * self-index, `lastModifiedAt: 0` beside a stale `ageDays` of 13–37). The
 * applier therefore removes, per write batch, the keys a provider DECLARES
 * optional at that level and the written overlay omits: one `delete_payload`
 * operation per distinct omitted-key set, addressed at the provider's own
 * `<provider>.<level>` namespace, only for points whose overlay write landed,
 * and never for a bare `enrichedAt` stamp (that is a terminal marker, not an
 * overlay).
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import type { ChunkItem } from "../../../../../../src/core/domains/ingest/pipeline/types.js";

type SetOp = { payload: Record<string, unknown>; points: (string | number)[]; key?: string };
type DeleteOp = { keys: string[]; points: (string | number)[] };

const GIT = { key: "git", optionalOverlayKeys: { file: ["lastModifiedAt", "ageDays"], chunk: ["ageDays"] } };
const CODEGRAPH = { key: "codegraph.symbols" };

function chunkItem(relPath: string, chunkId: string, endLine = 5): ChunkItem {
  return {
    chunkId,
    chunk: { content: "", startLine: 1, endLine, metadata: { filePath: `/r/${relPath}` } },
  } as unknown as ChunkItem;
}

function chunkOverlay(ageDays: number | undefined): Record<string, unknown> {
  return {
    commitCount: ageDays === undefined ? 0 : 2,
    lastModifiedAt: ageDays === undefined ? 0 : 1_700_000_000,
    ageDays,
  };
}

describe("EnrichmentApplier — optional overlay keys the new overlay omits", () => {
  let qdrant: {
    batchSetPayload: Mock<(collectionName: string, ops: SetOp[]) => Promise<void>>;
    batchDeletePayload: Mock<(collectionName: string, ops: DeleteOp[]) => Promise<void>>;
  };
  let applier: EnrichmentApplier;

  beforeEach(() => {
    qdrant = {
      batchSetPayload: vi.fn<(collectionName: string, ops: SetOp[]) => Promise<void>>().mockResolvedValue(undefined),
      batchDeletePayload: vi
        .fn<(collectionName: string, ops: DeleteOp[]) => Promise<void>>()
        .mockResolvedValue(undefined),
    };
    applier = new EnrichmentApplier(qdrant as never, { baseDelayMs: 0 }, [GIT, CODEGRAPH]);
  });

  function deleteOps(): DeleteOp[] {
    return qdrant.batchDeletePayload.mock.calls.flatMap((c) => c[1] ?? []);
  }

  describe("applyChunkSignals", () => {
    it("deletes the omitted key under the provider's chunk namespace, in ONE op over every point omitting it", async () => {
      const overlays = new Map([
        [
          "src/a.ts",
          new Map([
            ["c1", chunkOverlay(undefined)],
            ["c2", chunkOverlay(5)],
            ["c3", chunkOverlay(undefined)],
          ]),
        ],
      ]);

      await applier.applyChunkSignals("coll", "git", overlays, "t1");

      expect(qdrant.batchDeletePayload).toHaveBeenCalledTimes(1);
      expect(deleteOps()).toEqual([{ keys: ["git.chunk.ageDays"], points: ["c1", "c3"] }]);
    });

    it("issues no delete at all when every overlay carries every optional key", async () => {
      await applier.applyChunkSignals("coll", "git", new Map([["src/a.ts", new Map([["c1", chunkOverlay(3)]])]]), "t1");

      expect(qdrant.batchDeletePayload).not.toHaveBeenCalled();
    });

    it("never deletes from a bare enrichedAt stamp — a chunk the overlay map omits keeps its payload", async () => {
      await applier.applyChunkSignals(
        "coll",
        "git",
        new Map([["src/a.ts", new Map([["c1", chunkOverlay(3)]])]]),
        "t1",
        new Set(["c1", "stamped"]),
      );

      expect(qdrant.batchDeletePayload).not.toHaveBeenCalled();
    });

    it("skips the delete for points whose overlay write never landed", async () => {
      qdrant.batchSetPayload.mockRejectedValue(new Error("qdrant down"));

      await applier.applyChunkSignals(
        "coll",
        "git",
        new Map([["src/a.ts", new Map([["c1", chunkOverlay(undefined)]])]]),
        "t1",
      );

      expect(qdrant.batchDeletePayload).not.toHaveBeenCalled();
    });

    it("deletes nothing for a provider that declares no optional keys", async () => {
      await applier.applyChunkSignals(
        "coll",
        "codegraph.symbols",
        new Map([["src/a.ts", new Map([["c1", { fanIn: 1 }]])]]),
        "t1",
      );

      expect(qdrant.batchDeletePayload).not.toHaveBeenCalled();
    });

    it("keeps the extra Qdrant traffic bounded: one call, one op per 512 points, however many chunks omit", async () => {
      const overlays = new Map<string, Record<string, unknown>>();
      for (let i = 0; i < 1200; i++) overlays.set(`c${i}`, chunkOverlay(undefined));

      await applier.applyChunkSignals("coll", "git", new Map([["src/big.ts", overlays]]), "t1");

      expect(qdrant.batchDeletePayload).toHaveBeenCalledTimes(1);
      const ops = deleteOps();
      expect(ops).toHaveLength(3);
      expect(Math.max(...ops.map((op) => op.points.length))).toBeLessThanOrEqual(512);
      expect(ops.flatMap((op) => op.points)).toHaveLength(1200);
    });
  });

  describe("applyFileSignals", () => {
    it("deletes one op per DISTINCT omitted-key set, over every chunk of the files omitting it", async () => {
      const history = { commitCount: 4, lastModifiedAt: 1_700_000_000, ageDays: 9 };
      const noHistory = { commitCount: 0 };
      const noAge = { commitCount: 1, lastModifiedAt: 1_700_000_000 };

      await applier.applyFileSignals(
        "coll",
        "git",
        new Map<string, Record<string, unknown>>([
          ["a.ts", noHistory],
          ["b.ts", history],
          ["c.ts", noHistory],
          ["d.ts", noAge],
        ]),
        "/r",
        [
          chunkItem("a.ts", "a1"),
          chunkItem("a.ts", "a2"),
          chunkItem("b.ts", "b1"),
          chunkItem("c.ts", "c1"),
          chunkItem("d.ts", "d1"),
        ],
        undefined,
        "t1",
      );

      expect(qdrant.batchDeletePayload).toHaveBeenCalledTimes(1);
      expect(deleteOps()).toEqual([
        { keys: ["git.file.lastModifiedAt", "git.file.ageDays"], points: ["a1", "a2", "c1"] },
        { keys: ["git.file.ageDays"], points: ["d1"] },
      ]);
    });

    it("judges omission on the TRANSFORMED overlay — the payload that is actually written", async () => {
      const transform = (data: Record<string, unknown>) => ({ ...data, ageDays: 1, lastModifiedAt: 1 });

      await applier.applyFileSignals(
        "coll",
        "git",
        new Map([["a.ts", { commitCount: 0 }]]),
        "/r",
        [chunkItem("a.ts", "a1")],
        transform,
        "t1",
      );

      expect(qdrant.batchDeletePayload).not.toHaveBeenCalled();
    });

    it("never deletes from the bare stamp a file with no overlay gets", async () => {
      await applier.applyFileSignals("coll", "git", new Map(), "/r", [chunkItem("gone.ts", "g1")], undefined, "t1");

      expect(qdrant.batchSetPayload).toHaveBeenCalled();
      expect(qdrant.batchDeletePayload).not.toHaveBeenCalled();
    });
  });

  describe("applyFinalizeFile", () => {
    it("deletes the omitted optional keys of a finalize overlay, under that provider's file namespace", async () => {
      await applier.applyFinalizeFile(
        "coll",
        "git",
        new Map([["a.ts", { commitCount: 0 }]]),
        new Map([
          [
            "a.ts",
            [
              { chunkId: "a1", startLine: 1, endLine: 5 },
              { chunkId: "a2", startLine: 6, endLine: 9 },
            ],
          ],
        ]),
        undefined,
        "t1",
      );

      expect(deleteOps()).toEqual([{ keys: ["git.file.lastModifiedAt", "git.file.ageDays"], points: ["a1", "a2"] }]);
    });
  });

  it("stays inside the writing provider's namespace — no key of another provider is ever named", async () => {
    await applier.applyChunkSignals(
      "coll",
      "git",
      new Map([["src/a.ts", new Map([["c1", chunkOverlay(undefined)]])]]),
      "t1",
    );
    await applier.applyChunkSignals(
      "coll",
      "codegraph.symbols",
      new Map([["src/a.ts", new Map([["c1", { fanIn: 0 }]])]]),
      "t1",
    );

    const keys = deleteOps().flatMap((op) => op.keys);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith("git.chunk."))).toBe(true);
  });
});
