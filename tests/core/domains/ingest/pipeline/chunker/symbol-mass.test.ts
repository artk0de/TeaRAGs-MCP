/**
 * Symbol-mass post-pass — spec
 * docs/superpowers/specs/2026-08-02-module-mass-signals-design.md.
 *
 * Language-independent pass over a single file's assembled chunk array. Reads
 * only chunk metadata every chunker already emits (symbolId, parentSymbolId,
 * parentType, chunkType, line span) plus the file's source, so one module
 * covers all nine languages plus the character fallback.
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

/** Source text of `lines` physical lines. */
function sourceOf(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("assignSymbolMass — moduleMethodCount", () => {
  it("counts callables only, so a class and its methods contribute N, not N+1", () => {
    const chunks = [
      makeChunk({ chunkType: "class", symbolId: "Alpha" }),
      makeChunk({ chunkType: "function", symbolId: "Alpha#one", parentSymbolId: "Alpha" }),
      makeChunk({ chunkType: "function", symbolId: "Alpha#two", parentSymbolId: "Alpha" }),
      makeChunk({ chunkType: "function", symbolId: "helper" }),
    ];

    assignSymbolMass(chunks, sourceOf(40));

    for (const chunk of chunks) {
      expect(chunk.metadata.moduleMethodCount).toBe(3);
    }
  });

  it("scores a declaration-only file at zero — a type barrel is not a god module", () => {
    const chunks = [
      makeChunk({ chunkType: "interface", symbolId: "SignalStats" }),
      makeChunk({ chunkType: "interface", symbolId: "SignalMetrics" }),
      makeChunk({ chunkType: "block", symbolId: "SignalFloors" }),
    ];

    assignSymbolMass(chunks, sourceOf(40));

    for (const chunk of chunks) {
      expect(chunk.metadata.moduleMethodCount).toBe(0);
    }
  });

  it("counts test and setup chunks, so a spec file still reports its mass", () => {
    const chunks = [
      makeChunk({ chunkType: "test", symbolId: "describe A.it one" }),
      makeChunk({ chunkType: "test", symbolId: "describe A.it two" }),
      makeChunk({ chunkType: "test_setup", symbolId: "describe A.beforeEach" }),
    ];

    assignSymbolMass(chunks, sourceOf(40));

    expect(chunks[0].metadata.moduleMethodCount).toBe(3);
  });

  it("counts a callable split across several chunks once", () => {
    const chunks = [
      makeChunk({ chunkType: "function", symbolId: "big#part1" }),
      makeChunk({ chunkType: "function", symbolId: "big#part2" }),
      makeChunk({ chunkType: "function", symbolId: "big#part3" }),
    ];

    assignSymbolMass(chunks, sourceOf(40));

    expect(chunks[0].metadata.moduleMethodCount).toBe(1);
  });

  it("stamps chunks that carry no symbolId, without counting them", () => {
    const chunks = [makeChunk({ chunkType: "function", symbolId: "named" }), makeChunk({ chunkType: "block" })];

    assignSymbolMass(chunks, sourceOf(40));

    expect(chunks[0].metadata.moduleMethodCount).toBe(1);
    expect(chunks[1].metadata.moduleMethodCount).toBe(1);
  });
});

describe("assignSymbolMass — moduleLines", () => {
  it("stamps the file's physical line count on every code chunk", () => {
    const chunks = [
      makeChunk({ chunkType: "class", symbolId: "Alpha" }, 1, 5),
      makeChunk({ chunkType: "function", symbolId: "Alpha#one", parentSymbolId: "Alpha" }, 7, 40),
    ];

    assignSymbolMass(chunks, sourceOf(312));

    for (const chunk of chunks) {
      expect(chunk.metadata.moduleLines).toBe(312);
    }
  });

  it("counts physical lines, including blanks and comments", () => {
    const chunks = [makeChunk({ chunkType: "function", symbolId: "one" })];

    assignSymbolMass(chunks, "// header\n\nfunction one() {}\n");

    // Trailing newline yields a final empty line — physical count, ESLint-style.
    expect(chunks[0].metadata.moduleLines).toBe(4);
  });

  it("is not stamped on documentation chunks", () => {
    const chunks = [
      makeChunk({ chunkType: "function", symbolId: "code" }),
      makeChunk({ isDocumentation: true, symbolId: "doc:cccccccccccc" }),
    ];

    assignSymbolMass(chunks, sourceOf(120));

    expect(chunks[0].metadata.moduleLines).toBe(120);
    expect(chunks[1].metadata.moduleLines).toBeUndefined();
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

    assignSymbolMass(chunks, sourceOf(40));

    expect(chunks[0].metadata.memberCount).toBe(3);
  });

  it("indexes a class that emits no class chunk at all — the TypeScript body-chunker shape", () => {
    // typescriptBodyChunkingHook writes ctx.bodyChunks with no chunkType, so
    // every chunk of a class WITH members lands as "block". Before the fix the
    // class was invisible and memberCount was never stamped.
    const chunks = [
      makeChunk(
        {
          chunkType: "block",
          symbolId: "Reranker#rerank",
          parentSymbolId: "Reranker",
          parentType: "class_declaration",
        },
        77,
        140,
      ),
      makeChunk(
        { chunkType: "block", symbolId: "Reranker#score", parentSymbolId: "Reranker", parentType: "class_declaration" },
        142,
        300,
      ),
      makeChunk(
        {
          chunkType: "block",
          symbolId: "Reranker#overlay",
          parentSymbolId: "Reranker",
          parentType: "class_declaration",
        },
        302,
        764,
      ),
    ];

    assignSymbolMass(chunks, sourceOf(800));

    expect(chunks[0].metadata.memberCount).toBe(3);
  });

  it("stamps exactly one chunk per class — the lowest-startLine one", () => {
    const chunks = [
      makeChunk(
        { chunkType: "block", symbolId: "Alpha#late", parentSymbolId: "Alpha", parentType: "class_declaration" },
        90,
        120,
      ),
      makeChunk(
        { chunkType: "block", symbolId: "Alpha#early", parentSymbolId: "Alpha", parentType: "class_declaration" },
        10,
        40,
      ),
    ];

    assignSymbolMass(chunks, sourceOf(200));

    expect(chunks[1].metadata.memberCount).toBe(2);
    expect(chunks[0].metadata.memberCount).toBeUndefined();
  });

  it("indexes Ruby modules and Go structs by the same parentType test", () => {
    const chunks = [
      makeChunk(
        { chunkType: "block", symbolId: "Acme::Util#a", parentSymbolId: "Acme::Util", parentType: "module" },
        5,
      ),
      makeChunk(
        { chunkType: "block", symbolId: "Acme::Util#b", parentSymbolId: "Acme::Util", parentType: "module" },
        9,
      ),
      makeChunk(
        { chunkType: "block", symbolId: "Server#Serve", parentSymbolId: "Server", parentType: "struct_type" },
        3,
      ),
    ];

    assignSymbolMass(chunks, sourceOf(60));

    expect(chunks[0].metadata.memberCount).toBe(2);
    expect(chunks[2].metadata.memberCount).toBe(1);
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

    assignSymbolMass(chunks, sourceOf(40));

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

    assignSymbolMass(chunks, sourceOf(40));

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

    assignSymbolMass(chunks, sourceOf(40));

    expect(chunks[0].metadata.memberCount).toBe(1);
  });

  it("reports zero members for a class chunk that has none", () => {
    const chunks = [makeChunk({ chunkType: "class", symbolId: "Empty" }, 3, 11)];

    assignSymbolMass(chunks, sourceOf(20));

    expect(chunks[0].metadata.memberCount).toBe(0);
  });
});

describe("assignSymbolMass — chunks that get no class fields", () => {
  it("emits only the file-scoped fields for a file with no classes", () => {
    const chunks = [
      makeChunk({ chunkType: "function", symbolId: "one" }),
      makeChunk({ chunkType: "function", symbolId: "two" }),
    ];

    assignSymbolMass(chunks, sourceOf(45));

    for (const chunk of chunks) {
      expect(chunk.metadata.moduleMethodCount).toBe(2);
      expect(chunk.metadata.moduleLines).toBe(45);
      expect(chunk.metadata.memberCount).toBeUndefined();
    }
  });

  it("emits nothing at all for a documentation file", () => {
    const chunks = [
      makeChunk({ isDocumentation: true, symbolId: "doc:aaaaaaaaaaaa", parentSymbolId: "docs/api.md" }),
      makeChunk({ isDocumentation: true, symbolId: "doc:bbbbbbbbbbbb", parentSymbolId: "docs/api.md" }),
    ];

    assignSymbolMass(chunks, sourceOf(200));

    for (const chunk of chunks) {
      expect(chunk.metadata.moduleMethodCount).toBeUndefined();
      expect(chunk.metadata.moduleLines).toBeUndefined();
      expect(chunk.metadata.memberCount).toBeUndefined();
    }
  });

  it("excludes documentation chunks from the callable count of a mixed file", () => {
    const chunks = [
      makeChunk({ chunkType: "function", symbolId: "code" }),
      makeChunk({ isDocumentation: true, symbolId: "doc:cccccccccccc" }),
    ];

    assignSymbolMass(chunks, sourceOf(40));

    expect(chunks[0].metadata.moduleMethodCount).toBe(1);
    expect(chunks[1].metadata.moduleMethodCount).toBeUndefined();
  });

  it("is a no-op on an empty chunk array", () => {
    expect(() => {
      assignSymbolMass([], "");
    }).not.toThrow();
  });
});
