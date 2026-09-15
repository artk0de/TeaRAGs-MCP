/**
 * settleCodegraphChunkSignals — the one computation behind every
 * `codegraph.symbols.chunk.*` overlay, over an explicit range source
 * (bd tea-rags-mcp-39xca.2).
 *
 * The chunk-owner rule was already shared; what the writers did NOT share was
 * what "no ranges" meant. The deferred pass stamped `enrichedAt` over empty
 * overlays for a file its walk left no line index for (fxio5), and the heal
 * read a pre-migration-024 file — symbol rows, NULL ranges — as "no range row"
 * and kept anchor owners (71n0p). Both are now typed outcomes a caller has to
 * handle, not values it silently writes.
 *
 * The fixture is walker.ts's measured ranges (see chunk-owner-symbol.test.ts).
 */

import { describe, expect, it } from "vitest";

import type { ChunkGraphSignals, SymbolLineRange } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  CodegraphChunkSettlementTally,
  settleCodegraphChunkSignals,
  toChunkSignalOverlays,
  type CodegraphChunkRangeSource,
  type CodegraphStoredChunk,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/chunk-signal-settlement.js";

const OUTER = "collectPythonInheritanceEdges";
const NESTED = "collectPythonInheritanceEdges.walkScope";

const RANGES: SymbolLineRange[] = [
  { symbolId: OUTER, startLine: 240, endLine: 320 },
  { symbolId: NESTED, startLine: 257, endLine: 300 },
];

const SIGNALS = new Map<string, ChunkGraphSignals>([
  [OUTER, { fanIn: 1, fanOut: 2, pageRank: 0.1 }],
  [NESTED, { fanIn: 3, fanOut: 6, pageRank: 0.3 }],
]);

const CHUNKS: CodegraphStoredChunk[] = [
  { chunkId: "head", startLine: 240, endLine: 256, symbolId: OUTER },
  { chunkId: "nested", startLine: 282, endLine: 303, symbolId: `${OUTER}#part2` },
  { chunkId: "block", startLine: 321, endLine: 330 },
];

describe("settleCodegraphChunkSignals (bd tea-rags-mcp-39xca.2)", () => {
  it.each<[string, CodegraphChunkRangeSource]>([
    ["walk", { kind: "walk", ranges: RANGES }],
    ["persisted", { kind: "persisted", ranges: RANGES, rowsWithoutRanges: 0 }],
  ])("settles every chunk to the same owner and signals from a %s source", (_label, source) => {
    const settlement = settleCodegraphChunkSignals(source, CHUNKS, SIGNALS);

    expect(settlement).toEqual({
      kind: "signals",
      source: source.kind,
      chunks: new Map([
        ["head", { kind: "owned", owner: OUTER, signals: { fanIn: 1, fanOut: 2, pageRank: 0.1 } }],
        ["nested", { kind: "owned", owner: NESTED, signals: { fanIn: 3, fanOut: 6, pageRank: 0.3 } }],
        ["block", { kind: "unowned" }],
      ]),
    });
    // An unowned chunk is SETTLED — the ranges were read and nothing contains
    // it — so it rides as an empty overlay, which the applier stamps bare.
    expect(toChunkSignalOverlays(settlement, CHUNKS)).toEqual(
      new Map([
        ["head", { fanIn: 1, fanOut: 2, pageRank: 0.1 }],
        ["nested", { fanIn: 3, fanOut: 6, pageRank: 0.3 }],
        ["block", {}],
      ]),
    );
  });

  it("keeps an anchored chunk of a walked file with no symbols on its anchor, at zero", () => {
    const settlement = settleCodegraphChunkSignals({ kind: "walk", ranges: [] }, CHUNKS, SIGNALS);

    expect(toChunkSignalOverlays(settlement, CHUNKS)).toEqual(
      new Map([
        ["head", { fanIn: 1, fanOut: 2, pageRank: 0.1 }],
        ["nested", { fanIn: 1, fanOut: 2, pageRank: 0.1 }],
        ["block", {}],
      ]),
    );
  });

  it("leaves a walked file with no line index unsettled instead of stamping it", () => {
    const settlement = settleCodegraphChunkSignals({ kind: "walk", ranges: undefined }, CHUNKS, SIGNALS);

    expect(settlement).toEqual({ kind: "unsettled", reason: "walked-file-without-ranges" });
    expect(toChunkSignalOverlays(settlement, CHUNKS)).toEqual(new Map());
  });

  it("leaves pre-migration-024 rows unsettled instead of falling back to anchor owners", () => {
    const settlement = settleCodegraphChunkSignals(
      { kind: "persisted", ranges: [], rowsWithoutRanges: 2 },
      CHUNKS,
      SIGNALS,
    );

    expect(settlement).toEqual({ kind: "unsettled", reason: "persisted-rows-without-ranges" });
    expect(toChunkSignalOverlays(settlement, CHUNKS)).toEqual(new Map());
  });

  it("leaves a partly ranged file unsettled — the unranged row may be the true owner", () => {
    const settlement = settleCodegraphChunkSignals(
      { kind: "persisted", ranges: [RANGES[0]], rowsWithoutRanges: 1 },
      CHUNKS,
      SIGNALS,
    );

    expect(settlement).toEqual({ kind: "unsettled", reason: "persisted-rows-without-ranges" });
  });

  it("tells a file with no persisted symbol rows apart from one whose rows carry no ranges", () => {
    const settlement = settleCodegraphChunkSignals(
      { kind: "persisted", ranges: [], rowsWithoutRanges: 0 },
      CHUNKS,
      SIGNALS,
    );

    expect(settlement).toEqual({ kind: "unsettled", reason: "no-persisted-symbol-rows" });
  });

  it.each(["non-extractable-language", "excluded-from-graph"] as const)(
    "settles every chunk without signal values when the graph can never hold the file (%s)",
    (reason) => {
      const settlement = settleCodegraphChunkSignals({ kind: "none", reason }, CHUNKS, SIGNALS);

      expect(settlement).toEqual({ kind: "settled-without-signals", reason });
      expect(toChunkSignalOverlays(settlement, CHUNKS)).toEqual(
        new Map([
          ["head", {}],
          ["nested", {}],
          ["block", {}],
        ]),
      );
    },
  );
});

describe("CodegraphChunkSettlementTally (bd tea-rags-mcp-39xca.2)", () => {
  it("says nothing when every chunk settled", () => {
    const tally = new CodegraphChunkSettlementTally();
    tally.record("a.ts", settleCodegraphChunkSignals({ kind: "walk", ranges: RANGES }, CHUNKS, SIGNALS), 3);
    tally.record("b.json", { kind: "settled-without-signals", reason: "non-extractable-language" }, 2);

    expect(tally.unsettledChunks).toBe(0);
    expect(tally.describeUnsettled("deferred chunk pass")).toBeUndefined();
  });

  it("counts unsettled chunks per reason and names the files", () => {
    const tally = new CodegraphChunkSettlementTally();
    tally.record("a.ts", { kind: "unsettled", reason: "walked-file-without-ranges" }, 3);
    tally.record("b.ts", { kind: "unsettled", reason: "persisted-rows-without-ranges" }, 2);
    tally.recordUnsettled("c.ts", "chunk-without-line-span", 1);

    expect(tally.unsettledChunks).toBe(6);
    const line = tally.describeUnsettled("payload heal");
    expect(line).toContain("payload heal");
    expect(line).toContain("6 chunk(s) in 3 file(s)");
    expect(line).toContain("walked-file-without-ranges: 3");
    expect(line).toContain("persisted-rows-without-ranges: 2");
    expect(line).toContain("chunk-without-line-span: 1");
    expect(line).toContain("a.ts");
  });
});
