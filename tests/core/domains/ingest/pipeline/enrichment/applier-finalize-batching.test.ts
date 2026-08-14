/**
 * `applyFinalizeFile` write shape + concurrency (bd tea-rags-mcp-6aytq).
 *
 * The finalize apply is the second half of the post-pass-2 tail (~46s measured
 * on taxdome, 10,476 files). It used to emit ONE set_payload operation per
 * CHUNK — every chunk of a file carrying its own copy of that file's identical
 * overlay — and then walk the operation list 100 at a time, one HTTP round-trip
 * after another. A file's chunks all take the same payload under the same key,
 * so they belong in one operation, and consecutive batches touch disjoint point
 * sets, so they need not queue behind each other.
 *
 * What must NOT change: payload content, the `<provider>.file` key scoping, the
 * bare-`enrichedAt` stamp for a genuine miss, and the matched / missed / ignored
 * accounting.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";

type Op = { payload: Record<string, unknown>; points: (string | number)[]; key?: string };

function entries(count: number, prefix: string): { chunkId: string; startLine: number; endLine: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    chunkId: `${prefix}-c${i}`,
    startLine: i * 10 + 1,
    endLine: i * 10 + 10,
  }));
}

describe("EnrichmentApplier.applyFinalizeFile (bd tea-rags-mcp-6aytq)", () => {
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

  it("writes ONE operation per file covering all of its chunk ids", async () => {
    const chunkMap = new Map([
      ["src/a.ts", entries(4, "a")],
      ["src/b.ts", entries(2, "b")],
    ]);
    const overlays = new Map([
      ["src/a.ts", { fanIn: 3, fanOut: 1 }],
      ["src/b.ts", { fanIn: 0, fanOut: 7 }],
    ]);

    const applied = await applier.applyFinalizeFile("coll", "codegraph.symbols", overlays as never, chunkMap);

    expect(applied).toBe(2);
    const ops = allOps();
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({
      payload: { fanIn: 3, fanOut: 1 },
      points: ["a-c0", "a-c1", "a-c2", "a-c3"],
      key: "codegraph.symbols.file",
    });
    expect(ops[1].points).toEqual(["b-c0", "b-c1"]);
  });

  it("coalesces the bare enrichedAt stamp of a genuine miss the same way", async () => {
    const chunkMap = new Map([["src/missing.ts", entries(3, "m")]]);

    await applier.applyFinalizeFile(
      "coll",
      "codegraph.symbols",
      new Map(),
      chunkMap,
      undefined,
      "2026-08-14T00:00:00Z",
    );

    const ops = allOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      payload: { enrichedAt: "2026-08-14T00:00:00Z" },
      points: ["m-c0", "m-c1", "m-c2"],
      key: "codegraph.symbols.file",
    });
    // Still tracked for backfill — coalescing is a write-shape change only.
    expect(applier.missedFiles).toBe(1);
    expect(applier.getMissedFileChunks().get("src/missing.ts")).toHaveLength(3);
  });

  it("keeps the transform, the enrichedAt stamp and the ignore accounting intact", async () => {
    const chunkMap = new Map([
      ["src/keep.ts", entries(2, "k")],
      ["spec/skip_spec.ts", entries(1, "s")],
    ]);
    const overlays = new Map([["src/keep.ts", { fanIn: 2, fanOut: 2 }]]);

    await applier.applyFinalizeFile(
      "coll",
      "codegraph.symbols",
      overlays as never,
      chunkMap,
      (overlay, maxEndLine) => ({ ...(overlay as object), maxEndLine }) as never,
      "2026-08-14T00:00:00Z",
      (relPath) => relPath.startsWith("spec/"),
    );

    const ops = allOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].payload).toEqual({ fanIn: 2, fanOut: 2, maxEndLine: 20, enrichedAt: "2026-08-14T00:00:00Z" });
    expect(applier.ignoredFiles).toBe(1);
    expect(applier.matchedFiles).toBe(1);
  });

  it("keeps several payload batches in flight instead of one round-trip at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    mockQdrant.batchSetPayload.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
    });

    // 400 files, one chunk each ⇒ 400 coalesced ops ⇒ 4 batches of 100.
    const chunkMap = new Map(Array.from({ length: 400 }, (_, i) => [`src/f${i}.ts`, entries(1, `f${i}`)]));
    const overlays = new Map(Array.from({ length: 400 }, (_, i) => [`src/f${i}.ts`, { fanIn: i, fanOut: 0 }]));

    await applier.applyFinalizeFile("coll", "codegraph.symbols", overlays as never, chunkMap);

    expect(mockQdrant.batchSetPayload).toHaveBeenCalledTimes(4);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  });
});
