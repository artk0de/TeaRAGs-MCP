import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { assignNavigationAndDocSymbolId } from "../../../../../src/core/domains/ingest/pipeline/file-processor.js";
import type { CodeChunk } from "../../../../../src/core/types.js";

function docHash(input: string): string {
  return `doc:${createHash("sha256").update(input).digest("hex").slice(0, 12)}`;
}

function makeChunk(overrides: Partial<CodeChunk> & { metadata: Partial<CodeChunk["metadata"]> }): CodeChunk {
  return {
    content: overrides.content ?? "test content",
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 10,
    metadata: {
      filePath: "/project/docs/api.md",
      language: "markdown",
      chunkIndex: 0,
      ...overrides.metadata,
    },
  };
}

describe("assignNavigationAndDocSymbolId", () => {
  const basePath = "/project";

  it("generates doc: hash symbolId for documentation chunks with headingPath", () => {
    const chunks: CodeChunk[] = [
      makeChunk({
        metadata: {
          chunkIndex: 0,
          isDocumentation: true,
          symbolId: "Authentication",
          headingPath: [{ depth: 2, text: "Authentication" }],
        },
      }),
    ];

    assignNavigationAndDocSymbolId(chunks, basePath);

    expect(chunks[0].metadata.symbolId).toBe(docHash("docs/api.md#Authentication"));
  });

  it("generates doc: hash symbolId for preamble (empty headingPath)", () => {
    const chunks: CodeChunk[] = [
      makeChunk({
        metadata: {
          chunkIndex: 0,
          isDocumentation: true,
          symbolId: "Preamble",
          headingPath: [],
          name: "Preamble",
        },
      }),
    ];

    assignNavigationAndDocSymbolId(chunks, basePath);

    expect(chunks[0].metadata.symbolId).toBe(docHash("docs/api.md#preamble"));
  });

  it("generates doc: hash symbolId using chunkIndex when no headingPath", () => {
    const chunks: CodeChunk[] = [
      makeChunk({
        metadata: {
          chunkIndex: 3,
          isDocumentation: true,
        },
      }),
    ];

    assignNavigationAndDocSymbolId(chunks, basePath);

    expect(chunks[0].metadata.symbolId).toBe(docHash("docs/api.md#3"));
  });

  it("joins multi-level headingPath with ' > '", () => {
    const chunks: CodeChunk[] = [
      makeChunk({
        metadata: {
          chunkIndex: 0,
          isDocumentation: true,
          symbolId: "OAuth",
          headingPath: [
            { depth: 2, text: "Authentication" },
            { depth: 3, text: "OAuth" },
          ],
        },
      }),
    ];

    assignNavigationAndDocSymbolId(chunks, basePath);

    expect(chunks[0].metadata.symbolId).toBe(docHash("docs/api.md#Authentication > OAuth"));
  });

  it("does NOT change symbolId for code chunks", () => {
    const chunks: CodeChunk[] = [
      makeChunk({
        metadata: {
          filePath: "/project/src/app.ts",
          language: "typescript",
          chunkIndex: 0,
          symbolId: "Reranker.rerank",
        },
      }),
    ];

    assignNavigationAndDocSymbolId(chunks, basePath);

    expect(chunks[0].metadata.symbolId).toBe("Reranker.rerank");
  });

  it("sets navigation links for ordered chunks", () => {
    const chunks: CodeChunk[] = [
      makeChunk({ metadata: { chunkIndex: 0, symbolId: "first" } }),
      makeChunk({ metadata: { chunkIndex: 1, symbolId: "second" } }),
      makeChunk({ metadata: { chunkIndex: 2, symbolId: "third" } }),
    ];

    assignNavigationAndDocSymbolId(chunks, basePath);

    expect(chunks[0].metadata.navigation).toEqual({ nextSymbolId: "second" });
    expect(chunks[1].metadata.navigation).toEqual({
      prevSymbolId: "first",
      nextSymbolId: "third",
    });
    expect(chunks[2].metadata.navigation).toEqual({ prevSymbolId: "second" });
  });

  it("sets navigation for single chunk (no prev, no next)", () => {
    const chunks: CodeChunk[] = [makeChunk({ metadata: { chunkIndex: 0, symbolId: "only" } })];

    assignNavigationAndDocSymbolId(chunks, basePath);

    expect(chunks[0].metadata.navigation).toEqual({});
  });

  it("computes doc symbolId BEFORE building navigation links", () => {
    const chunks: CodeChunk[] = [
      makeChunk({
        metadata: {
          chunkIndex: 0,
          isDocumentation: true,
          symbolId: "Intro",
          headingPath: [{ depth: 2, text: "Intro" }],
        },
      }),
      makeChunk({
        metadata: {
          chunkIndex: 1,
          symbolId: "Reranker.rerank",
        },
      }),
    ];

    assignNavigationAndDocSymbolId(chunks, basePath);

    const docId = docHash("docs/api.md#Intro");
    expect(chunks[0].metadata.symbolId).toBe(docId);
    expect(chunks[0].metadata.navigation).toEqual({
      nextSymbolId: "Reranker.rerank",
    });
    expect(chunks[1].metadata.navigation).toEqual({ prevSymbolId: docId });
  });
});
