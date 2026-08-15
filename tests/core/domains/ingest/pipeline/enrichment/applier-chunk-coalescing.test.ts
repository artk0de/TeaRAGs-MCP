/**
 * `applyChunkSignals` write shape — one operation per DISTINCT payload, not one
 * per chunk (bd tea-rags-mcp-6aytq).
 *
 * The deferred codegraph chunk pass hands the applier 27,555 overlays, and the
 * applier turned each into its own `set_payload` operation addressing a single
 * point. Qdrant applies operations one after another, so the terminal chunk
 * marker — a `wait: true` write, and therefore a barrier on everything queued
 * before it — spent 11.4s of the completion tail draining them. Chunk overlays
 * repeat heavily (every symbol the graph has no edge for is the same
 * `{fanIn: 0, fanOut: 0, pageRank: 0}`), and the no-signal `enrichedAt` stamp is
 * the SAME payload for every point it touches.
 *
 * What must NOT change: which point ends up carrying which payload, the
 * `<provider>.chunk` key scoping, the applied count (POINTS, not operations),
 * and the exclusion of policy-declined points.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";

type Op = { payload: Record<string, unknown>; points: (string | number)[]; key?: string };

describe("EnrichmentApplier.applyChunkSignals — payload coalescing (bd tea-rags-mcp-6aytq)", () => {
  let mockQdrant: { batchSetPayload: Mock<(collectionName: string, ops: Op[]) => Promise<void>> };
  let applier: EnrichmentApplier;

  beforeEach(() => {
    mockQdrant = { batchSetPayload: vi.fn<(collectionName: string, ops: Op[]) => Promise<void>>() };
    mockQdrant.batchSetPayload.mockResolvedValue(undefined);
    applier = new EnrichmentApplier(mockQdrant as never, { baseDelayMs: 0 });
  });

  function allOps(): Op[] {
    return mockQdrant.batchSetPayload.mock.calls.flatMap((c) => c[1] ?? []);
  }

  it("folds chunks sharing an overlay into ONE operation over all their points", async () => {
    const chunkMetadata = new Map([
      [
        "src/a.ts",
        new Map([
          ["c1", { fanIn: 0, fanOut: 0, pageRank: 0 }],
          ["c2", { fanIn: 0, fanOut: 0, pageRank: 0 }],
        ]),
      ],
      [
        "src/b.ts",
        new Map([
          ["c3", { fanIn: 0, fanOut: 0, pageRank: 0 }],
          ["c4", { fanIn: 2, fanOut: 1, pageRank: 0.5 }],
        ]),
      ],
    ]);

    const applied = await applier.applyChunkSignals("coll", "codegraph.symbols", chunkMetadata as never);

    // Four points, two distinct payloads.
    expect(applied).toBe(4);
    const ops = allOps();
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({
      payload: { fanIn: 0, fanOut: 0, pageRank: 0 },
      points: ["c1", "c2", "c3"],
      key: "codegraph.symbols.chunk",
    });
    expect(ops[1]).toEqual({
      payload: { fanIn: 2, fanOut: 1, pageRank: 0.5 },
      points: ["c4"],
      key: "codegraph.symbols.chunk",
    });
  });

  it("folds the no-signal enrichedAt stamp into a single operation", async () => {
    const chunkMetadata = new Map([["src/a.ts", new Map([["c1", { fanIn: 1, fanOut: 0, pageRank: 0.2 }]])]]);

    const applied = await applier.applyChunkSignals(
      "coll",
      "codegraph.symbols",
      chunkMetadata as never,
      "2026-08-14T00:00:00Z",
      new Set(["c1", "c2", "c3", "c4"]),
    );

    expect(applied).toBe(4);
    const stamps = allOps().filter((op) => Object.keys(op.payload).length === 1);
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toEqual({
      payload: { enrichedAt: "2026-08-14T00:00:00Z" },
      points: ["c2", "c3", "c4"],
      key: "codegraph.symbols.chunk",
    });
  });

  it("caps how many points one operation may carry", async () => {
    const overlays = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < 1200; i++) overlays.set(`c${i}`, { fanIn: 0, fanOut: 0, pageRank: 0 });

    const applied = await applier.applyChunkSignals("coll", "codegraph.symbols", new Map([["src/big.ts", overlays]]));

    expect(applied).toBe(1200);
    const ops = allOps();
    expect(ops.length).toBeGreaterThan(1);
    expect(Math.max(...ops.map((op) => op.points.length))).toBeLessThanOrEqual(512);
    expect(ops.flatMap((op) => op.points)).toHaveLength(1200);
  });

  it("never coalesces a policy-declined point into the write", async () => {
    const chunkMetadata = new Map([
      [
        "src/a.ts",
        new Map([
          ["c1", { fanIn: 0, fanOut: 0, pageRank: 0 }],
          ["declined", { fanIn: 0, fanOut: 0, pageRank: 0 }],
        ]),
      ],
    ]);

    const applied = await applier.applyChunkSignals(
      "coll",
      "codegraph.symbols",
      chunkMetadata as never,
      "2026-08-14T00:00:00Z",
      new Set(["c1", "declined"]),
      new Set(["declined"]),
    );

    expect(applied).toBe(1);
    expect(allOps().flatMap((op) => op.points)).toEqual(["c1"]);
  });
});
