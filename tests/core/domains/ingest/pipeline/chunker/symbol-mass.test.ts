/**
 * Symbol-mass post-pass — spec
 * docs/superpowers/specs/2026-08-01-risk-assessment-structural-axis-design.md §A.
 *
 * Language-independent pass over a single file's assembled chunk array. Reads
 * only chunk metadata every chunker already emits (symbolId, parentSymbolId,
 * chunkType, line span), so one module covers all nine languages plus the
 * character fallback.
 */

import { describe, expect, it } from "vitest";

import { assignSymbolMass } from "../../../../../../src/core/domains/ingest/pipeline/chunker/symbol-mass.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

function makeChunk(metadata: Partial<CodeChunk["metadata"]>, startLine = 1, endLine = 10): CodeChunk {
  return {
    content: "x",
    startLine,
    endLine,
    metadata: {
      filePath: "/project/src/thing.ts",
      language: "typescript",
      chunkIndex: 0,
      ...metadata,
    },
  };
}

describe("assignSymbolMass — fileSymbolCount", () => {
  it("stamps the distinct code-symbol count on every code chunk of the file", () => {
    const chunks = [
      makeChunk({ chunkType: "class", symbolId: "Alpha" }),
      makeChunk({ chunkType: "function", symbolId: "Alpha#one", parentSymbolId: "Alpha" }),
      makeChunk({ chunkType: "function", symbolId: "Alpha#two", parentSymbolId: "Alpha" }),
      makeChunk({ chunkType: "function", symbolId: "helper" }),
    ];

    assignSymbolMass(chunks);

    for (const chunk of chunks) {
      expect(chunk.metadata.fileSymbolCount).toBe(4);
    }
  });

  it("counts a symbol split across several chunks once", () => {
    const chunks = [
      makeChunk({ chunkType: "function", symbolId: "big#part1" }),
      makeChunk({ chunkType: "function", symbolId: "big#part2" }),
      makeChunk({ chunkType: "function", symbolId: "big#part3" }),
    ];

    assignSymbolMass(chunks);

    expect(chunks[0].metadata.fileSymbolCount).toBe(1);
  });

  it("stamps chunks that carry no symbolId, without counting them", () => {
    const chunks = [makeChunk({ chunkType: "function", symbolId: "named" }), makeChunk({ chunkType: "block" })];

    assignSymbolMass(chunks);

    expect(chunks[0].metadata.fileSymbolCount).toBe(1);
    expect(chunks[1].metadata.fileSymbolCount).toBe(1);
  });
});

describe("assignSymbolMass — memberCount", () => {
  it("counts direct members of a class", () => {
    const chunks = [
      makeChunk({ chunkType: "class", symbolId: "Alpha" }),
      makeChunk({ chunkType: "function", symbolId: "Alpha#one", parentSymbolId: "Alpha" }),
      makeChunk({ chunkType: "function", symbolId: "Alpha#two", parentSymbolId: "Alpha" }),
      makeChunk({ chunkType: "function", symbolId: "Alpha.three", parentSymbolId: "Alpha" }),
    ];

    assignSymbolMass(chunks);

    expect(chunks[0].metadata.memberCount).toBe(3);
  });

  it("folds #partN split chunks of one member into a single member", () => {
    const chunks = [
      makeChunk({ chunkType: "class", symbolId: "Alpha" }),
      // enforceMaxChunkSize rewrites an oversized member into parts whose
      // parentSymbolId is the member's own symbolId, not the class.
      makeChunk({ chunkType: "function", symbolId: "Alpha#big#part1", parentSymbolId: "Alpha#big" }),
      makeChunk({ chunkType: "function", symbolId: "Alpha#big#part2", parentSymbolId: "Alpha#big" }),
      makeChunk({ chunkType: "function", symbolId: "Alpha#big#part3", parentSymbolId: "Alpha#big" }),
      makeChunk({ chunkType: "function", symbolId: "Alpha#small", parentSymbolId: "Alpha" }),
    ];

    assignSymbolMass(chunks);

    expect(chunks[0].metadata.memberCount).toBe(2);
  });

  it("counts members of a nested class against the nested class, not the outer one", () => {
    const chunks = [
      makeChunk({ chunkType: "class", symbolId: "Outer" }),
      makeChunk({ chunkType: "function", symbolId: "Outer#outerMethod", parentSymbolId: "Outer" }),
      makeChunk({ chunkType: "class", symbolId: "Outer.Inner", parentSymbolId: "Outer" }),
      makeChunk({ chunkType: "function", symbolId: "Outer.Inner#a", parentSymbolId: "Outer.Inner" }),
      makeChunk({ chunkType: "function", symbolId: "Outer.Inner#b", parentSymbolId: "Outer.Inner" }),
    ];

    assignSymbolMass(chunks);

    // Outer's direct members: outerMethod + the Inner class itself.
    expect(chunks[0].metadata.memberCount).toBe(2);
    expect(chunks[2].metadata.memberCount).toBe(2);
  });

  it("does not attribute a symbol whose owner merely starts with the class name", () => {
    const chunks = [
      makeChunk({ chunkType: "class", symbolId: "Alpha" }),
      makeChunk({ chunkType: "function", symbolId: "Alpha#one", parentSymbolId: "Alpha" }),
      // AlphaHelper is a separate top-level symbol; "Alpha" is a string prefix
      // of it but not a symbol-boundary prefix.
      makeChunk({ chunkType: "function", symbolId: "AlphaHelper#inner", parentSymbolId: "AlphaHelper" }),
    ];

    assignSymbolMass(chunks);

    expect(chunks[0].metadata.memberCount).toBe(1);
  });
});

describe("assignSymbolMass — classLines", () => {
  it("spans the class to its last member, not to the header chunk", () => {
    const chunks = [
      // class chunk carries the header only: lines 10-14
      makeChunk({ chunkType: "class", symbolId: "Alpha" }, 10, 14),
      makeChunk({ chunkType: "function", symbolId: "Alpha#one", parentSymbolId: "Alpha" }, 16, 40),
      makeChunk({ chunkType: "function", symbolId: "Alpha#two", parentSymbolId: "Alpha" }, 42, 210),
    ];

    assignSymbolMass(chunks);

    expect(chunks[0].metadata.classLines).toBe(200);
  });

  it("extends an outer class span across a nested class's members", () => {
    const chunks = [
      makeChunk({ chunkType: "class", symbolId: "Outer" }, 1, 5),
      makeChunk({ chunkType: "class", symbolId: "Outer.Inner", parentSymbolId: "Outer" }, 7, 9),
      makeChunk({ chunkType: "function", symbolId: "Outer.Inner#a", parentSymbolId: "Outer.Inner" }, 11, 90),
    ];

    assignSymbolMass(chunks);

    expect(chunks[0].metadata.classLines).toBe(89);
    expect(chunks[1].metadata.classLines).toBe(83);
  });

  it("falls back to the class chunk's own span when the class has no members", () => {
    const chunks = [makeChunk({ chunkType: "class", symbolId: "Empty" }, 3, 11)];

    assignSymbolMass(chunks);

    expect(chunks[0].metadata.classLines).toBe(8);
    expect(chunks[0].metadata.memberCount).toBe(0);
  });
});

describe("assignSymbolMass — chunks that get no class fields", () => {
  it("emits only fileSymbolCount for a file with no classes", () => {
    const chunks = [
      makeChunk({ chunkType: "function", symbolId: "one" }),
      makeChunk({ chunkType: "function", symbolId: "two" }),
    ];

    assignSymbolMass(chunks);

    for (const chunk of chunks) {
      expect(chunk.metadata.fileSymbolCount).toBe(2);
      expect(chunk.metadata.memberCount).toBeUndefined();
      expect(chunk.metadata.classLines).toBeUndefined();
    }
  });

  it("emits nothing at all for a documentation file", () => {
    const chunks = [
      makeChunk({ isDocumentation: true, symbolId: "doc:aaaaaaaaaaaa", parentSymbolId: "docs/api.md" }),
      makeChunk({ isDocumentation: true, symbolId: "doc:bbbbbbbbbbbb", parentSymbolId: "docs/api.md" }),
    ];

    assignSymbolMass(chunks);

    for (const chunk of chunks) {
      expect(chunk.metadata.fileSymbolCount).toBeUndefined();
      expect(chunk.metadata.memberCount).toBeUndefined();
      expect(chunk.metadata.classLines).toBeUndefined();
    }
  });

  it("excludes documentation chunks from the symbol count of a mixed file", () => {
    const chunks = [
      makeChunk({ chunkType: "function", symbolId: "code" }),
      makeChunk({ isDocumentation: true, symbolId: "doc:cccccccccccc" }),
    ];

    assignSymbolMass(chunks);

    expect(chunks[0].metadata.fileSymbolCount).toBe(1);
    expect(chunks[1].metadata.fileSymbolCount).toBeUndefined();
  });

  it("is a no-op on an empty chunk array", () => {
    expect(() => {
      assignSymbolMass([]);
    }).not.toThrow();
  });
});
