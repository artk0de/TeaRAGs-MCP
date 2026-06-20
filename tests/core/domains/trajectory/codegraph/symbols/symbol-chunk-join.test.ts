import { describe, expect, it } from "vitest";

import type { SymbolId } from "../../../../../../src/core/contracts/types/codegraph.js";
import { computeSymbolChunkIds } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";

describe("computeSymbolChunkIds — symbol→covering-chunk containment", () => {
  it("collapsed method with no own chunk maps to the containing class chunk", () => {
    // Class Foo chunk spans 1..20; method Foo#bar declared at line 5 has no own chunk.
    const symbols = new Map<SymbolId, number>([
      ["Foo" as SymbolId, 1],
      ["Foo#bar" as SymbolId, 5],
    ]);
    const entries = [{ chunkId: "chunk_cls", startLine: 1, endLine: 20 }];
    const out = computeSymbolChunkIds(symbols, entries);
    expect(out.get("Foo" as SymbolId)).toBe("chunk_cls");
    expect(out.get("Foo#bar" as SymbolId)).toBe("chunk_cls");
  });

  it("normal method maps to its own (tightest) chunk, not the enclosing class", () => {
    const symbols = new Map<SymbolId, number>([["Foo#bar" as SymbolId, 5]]);
    const entries = [
      { chunkId: "chunk_cls", startLine: 1, endLine: 20 }, // class chunk
      { chunkId: "chunk_bar", startLine: 5, endLine: 9 }, // method's own chunk (tighter)
    ];
    const out = computeSymbolChunkIds(symbols, entries);
    expect(out.get("Foo#bar" as SymbolId)).toBe("chunk_bar");
  });

  it("#partN split: symbol maps to the part whose range contains its start line", () => {
    const symbols = new Map<SymbolId, number>([["Big#run" as SymbolId, 50]]);
    const entries = [
      { chunkId: "chunk_p1", startLine: 40, endLine: 49 },
      { chunkId: "chunk_p2", startLine: 50, endLine: 70 },
    ];
    const out = computeSymbolChunkIds(symbols, entries);
    expect(out.get("Big#run" as SymbolId)).toBe("chunk_p2");
  });

  it("uncovered symbol (excluded file region) is absent from the result", () => {
    const symbols = new Map<SymbolId, number>([["Orphan" as SymbolId, 100]]);
    const entries = [{ chunkId: "chunk_a", startLine: 1, endLine: 20 }];
    const out = computeSymbolChunkIds(symbols, entries);
    expect(out.has("Orphan" as SymbolId)).toBe(false);
  });

  it("honours non-contiguous lineRanges (Ruby body groups) for containment", () => {
    const symbols = new Map<SymbolId, number>([["Mod#m" as SymbolId, 30]]);
    const entries = [
      {
        chunkId: "chunk_grp",
        startLine: 10,
        endLine: 40,
        lineRanges: [
          { start: 10, end: 15 },
          { start: 28, end: 33 },
        ],
      },
      { chunkId: "chunk_wide", startLine: 1, endLine: 50 },
    ];
    const out = computeSymbolChunkIds(symbols, entries);
    // 30 ∈ [28,33] of chunk_grp (span 6 effective) is tighter than chunk_wide (span 49).
    expect(out.get("Mod#m" as SymbolId)).toBe("chunk_grp");
  });
});
