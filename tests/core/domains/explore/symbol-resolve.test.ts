import { describe, expect, it } from "vitest";

import { resolveSymbols } from "../../../../src/core/domains/explore/symbol-resolve.js";

describe("resolveSymbols", () => {
  describe("function merge strategy", () => {
    it("merges multiple chunks of the same function into one result", () => {
      const chunks = [
        {
          id: "uuid-1",
          payload: {
            symbolId: "processData",
            chunkType: "function",
            relativePath: "src/processor.ts",
            content: "function processData(input: string) {\n  const parsed = parse(input);",
            startLine: 10,
            endLine: 20,
            language: "typescript",
            git: { file: { commitCount: 5, ageDays: 30 } },
          },
        },
        {
          id: "uuid-2",
          payload: {
            symbolId: "processData",
            chunkType: "function",
            relativePath: "src/processor.ts",
            content: "  return transform(parsed);\n}",
            startLine: 21,
            endLine: 25,
            language: "typescript",
            git: { file: { commitCount: 5, ageDays: 30 } },
          },
        },
      ];

      const results = resolveSymbols(chunks);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("uuid-1");
      expect(results[0].score).toBe(1.0);
      expect(results[0].payload?.symbolId).toBe("processData");
      expect(results[0].payload?.startLine).toBe(10);
      expect(results[0].payload?.endLine).toBe(25);
      expect(results[0].payload?.mergedChunkIds).toEqual(["uuid-1", "uuid-2"]);
      expect(results[0].payload?.content).toContain("function processData");
      expect(results[0].payload?.content).toContain("return transform");
      expect(results[0].payload?.git).toEqual({ file: { commitCount: 5, ageDays: 30 } });
    });

    it("returns single chunk as-is without mergedChunkIds", () => {
      const chunks = [
        {
          id: "uuid-1",
          payload: {
            symbolId: "simpleFunc",
            chunkType: "function",
            relativePath: "src/utils.ts",
            content: "function simpleFunc() { return 42; }",
            startLine: 1,
            endLine: 1,
            language: "typescript",
            git: { file: { ageDays: 10 } },
          },
        },
      ];

      const results = resolveSymbols(chunks);

      expect(results).toHaveLength(1);
      expect(results[0].payload?.mergedChunkIds).toBeUndefined();
    });

    it("strips content when metaOnly is true", () => {
      const chunks = [
        {
          id: "uuid-1",
          payload: {
            symbolId: "myFunc",
            chunkType: "function",
            relativePath: "src/utils.ts",
            content: "function myFunc() { return 42; }",
            startLine: 1,
            endLine: 1,
            language: "typescript",
            git: { file: { ageDays: 5 } },
          },
        },
      ];

      const results = resolveSymbols(chunks, undefined, true);

      expect(results).toHaveLength(1);
      expect(results[0].payload?.content).toBeUndefined();
      expect(results[0].payload?.symbolId).toBe("myFunc");
      expect(results[0].payload?.relativePath).toBe("src/utils.ts");
      expect(results[0].payload?.git).toBeDefined();
    });
  });

  describe("class outline strategy", () => {
    it("returns class outline via CodeChunkGrouper", () => {
      const chunks = [
        {
          id: "class-uuid",
          payload: {
            symbolId: "Reranker",
            chunkType: "class",
            name: "Reranker",
            relativePath: "src/reranker.ts",
            content: "class Reranker {\n  constructor(deps: Deps) {}",
            startLine: 10,
            endLine: 25,
            language: "typescript",
            git: { file: { commitCount: 15, ageDays: 60 } },
          },
        },
        {
          id: "method-1",
          payload: {
            symbolId: "Reranker#score",
            chunkType: "function",
            parentSymbolId: "Reranker",
            relativePath: "src/reranker.ts",
            content: "score() { ... }",
            startLine: 30,
            endLine: 50,
            language: "typescript",
            git: { file: { commitCount: 15, ageDays: 60 } },
          },
        },
        {
          id: "method-2",
          payload: {
            symbolId: "Reranker#rerank",
            chunkType: "function",
            parentSymbolId: "Reranker",
            relativePath: "src/reranker.ts",
            content: "rerank() { ... }",
            startLine: 55,
            endLine: 80,
            language: "typescript",
            git: { file: { commitCount: 15, ageDays: 60 } },
          },
        },
      ];

      const results = resolveSymbols(chunks);

      const classResult = results.find((r) => r.payload?.chunkType === "class");
      expect(classResult).toBeDefined();
      expect(classResult!.payload?.content).toContain("Reranker#score");
      expect(classResult!.payload?.content).toContain("Reranker#rerank");
      expect(classResult!.payload?.git).toEqual({ file: { commitCount: 15, ageDays: 60 } });
    });

    it("detects class from residual block with parentType=class_declaration", () => {
      const chunks = [
        {
          id: "residual-uuid",
          payload: {
            symbolId: "Reranker",
            chunkType: "block",
            parentType: "class_declaration",
            name: "Reranker",
            relativePath: "src/reranker.ts",
            content: "export class Reranker {\n  private readonly descriptors;",
            startLine: 43,
            endLine: 46,
            language: "typescript",
            git: { file: { commitCount: 5, ageDays: 1 } },
          },
        },
        {
          id: "method-uuid",
          payload: {
            symbolId: "Reranker#rerank",
            chunkType: "function",
            parentSymbolId: "Reranker",
            relativePath: "src/reranker.ts",
            content: "rerank() { ... }",
            startLine: 76,
            endLine: 151,
            language: "typescript",
            git: { file: { commitCount: 5, ageDays: 1 } },
          },
        },
      ];

      const results = resolveSymbols(chunks);

      const classResult = results.find((r) => r.payload?.symbolId === "Reranker");
      expect(classResult).toBeDefined();
      expect(classResult!.payload?.content).toContain("Reranker#rerank");
    });
  });

  describe("sorting", () => {
    it("sorts exact symbolId matches before partial matches", () => {
      const chunks = [
        {
          id: "uuid-partial",
          payload: {
            symbolId: "Reranker#score",
            chunkType: "function",
            relativePath: "src/reranker.ts",
            content: "score() {}",
            startLine: 30,
            endLine: 50,
            language: "typescript",
          },
        },
        {
          id: "uuid-exact",
          payload: {
            symbolId: "Reranker",
            chunkType: "class",
            name: "Reranker",
            relativePath: "src/reranker.ts",
            content: "class Reranker {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
      ];

      const results = resolveSymbols(chunks, "Reranker");

      expect(results[0].payload?.symbolId).toBe("Reranker");
    });

    it("sorts alphabetically by path for same match rank", () => {
      const chunks = [
        {
          id: "uuid-b",
          payload: {
            symbolId: "score",
            chunkType: "function",
            relativePath: "src/b/scorer.ts",
            content: "function score() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
        {
          id: "uuid-a",
          payload: {
            symbolId: "score",
            chunkType: "function",
            relativePath: "src/a/scorer.ts",
            content: "function score() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
      ];

      const results = resolveSymbols(chunks, "score");

      expect(results[0].payload?.relativePath).toBe("src/a/scorer.ts");
    });
  });

  describe("doc outline strategy", () => {
    it("groups doc chunks by parentSymbolId into outline with merged headingPath", () => {
      const chunks = [
        {
          id: "doc-1",
          payload: {
            symbolId: "doc:aaa111",
            chunkType: "block",
            parentSymbolId: "docs/api.md",
            relativePath: "docs/api.md",
            isDocumentation: true,
            name: "Introduction",
            headingPath: [{ depth: 1, text: "API" }],
            content: "Introduction text",
            startLine: 1,
            endLine: 10,
            language: "markdown",
            navigation: { nextSymbolId: "doc:bbb222" },
          },
        },
        {
          id: "doc-2",
          payload: {
            symbolId: "doc:bbb222",
            chunkType: "block",
            parentSymbolId: "docs/api.md",
            relativePath: "docs/api.md",
            isDocumentation: true,
            name: "Authentication",
            headingPath: [
              { depth: 1, text: "API" },
              { depth: 2, text: "Authentication" },
            ],
            content: "Auth content",
            startLine: 12,
            endLine: 25,
            language: "markdown",
            navigation: { prevSymbolId: "doc:aaa111", nextSymbolId: "doc:ccc333" },
          },
        },
        {
          id: "doc-3",
          payload: {
            symbolId: "doc:ccc333",
            chunkType: "block",
            parentSymbolId: "docs/api.md",
            relativePath: "docs/api.md",
            isDocumentation: true,
            name: "Usage",
            headingPath: [
              { depth: 1, text: "API" },
              { depth: 2, text: "Usage" },
            ],
            content: "Usage content",
            startLine: 27,
            endLine: 40,
            language: "markdown",
            navigation: { prevSymbolId: "doc:bbb222" },
          },
        },
      ];

      const results = resolveSymbols(chunks, "docs/api.md");

      expect(results).toHaveLength(1);
      const outline = results[0];
      expect(outline.payload?.relativePath).toBe("docs/api.md");
      expect(outline.payload?.content).toContain("doc:aaa111");
      expect(outline.payload?.content).toContain("doc:bbb222");
      expect(outline.payload?.content).toContain("doc:ccc333");
      expect(outline.payload?.headingPath).toEqual([
        { depth: 1, text: "API" },
        { depth: 2, text: "Authentication" },
        { depth: 2, text: "Usage" },
      ]);
    });

    it("returns doc outline with metaOnly (no content)", () => {
      const chunks = [
        {
          id: "doc-1",
          payload: {
            symbolId: "doc:aaa111",
            chunkType: "block",
            parentSymbolId: "docs/guide.md",
            relativePath: "docs/guide.md",
            isDocumentation: true,
            name: "Setup",
            headingPath: [{ depth: 2, text: "Setup" }],
            content: "Setup instructions",
            startLine: 1,
            endLine: 10,
            language: "markdown",
          },
        },
      ];

      const results = resolveSymbols(chunks, "docs/guide.md", true);

      expect(results).toHaveLength(1);
      expect(results[0].payload?.content).toBeUndefined();
      expect(results[0].payload?.headingPath).toEqual([{ depth: 2, text: "Setup" }]);
    });
  });

  describe("split-method fragment collapse (tea-rags-mcp-lyv7k)", () => {
    // Real chunk shapes from graphql-ruby @ 28ea3ec — an oversized method whose
    // hard-cap split produced `#part1`/`#part2` fragments alongside the base
    // `#resolve` window. find_symbol must collapse all fragments of one method
    // into ONE result instead of leaking three.
    const baseSymbolId = "GraphQL::Schema::Field#resolve";
    const path = "lib/graphql/schema/field.rb";
    const splitFragments = [
      {
        id: "base-window",
        payload: {
          symbolId: baseSymbolId,
          parentSymbolId: "GraphQL::Schema::Field",
          chunkType: "function",
          relativePath: path,
          name: "resolve",
          // Base window is the most-complete single view (mirrors real
          // graphql-ruby where the base window's body is the longest fragment).
          content:
            "def resolve(object, args, query_ctx)\n  application_object = object.object\n  # ... full method body window ...\nrescue GraphQL::ExecutionError => err\n  err\nend",
          startLine: 760,
          endLine: 928,
          methodLines: 104,
          language: "ruby",
        },
      },
      {
        id: "part-2",
        payload: {
          symbolId: `${baseSymbolId}#part2`,
          parentSymbolId: baseSymbolId,
          chunkType: "function",
          relativePath: path,
          name: "resolve (part 2/2)",
          content: "rescue GraphQL::ExecutionError => err\n  err\nend",
          startLine: 869,
          endLine: 872,
          methodLines: 104,
          language: "ruby",
        },
      },
      {
        id: "part-1",
        payload: {
          symbolId: `${baseSymbolId}#part1`,
          parentSymbolId: baseSymbolId,
          chunkType: "function",
          relativePath: path,
          name: "resolve (part 1/2)",
          content: "def resolve(object, args, query_ctx)\n  application_object = object.object",
          startLine: 722,
          endLine: 869,
          methodLines: 104,
          language: "ruby",
        },
      },
    ];

    it("collapses #partN fragments and the base window into a single result", () => {
      const results = resolveSymbols(splitFragments, baseSymbolId);

      expect(results).toHaveLength(1);
      expect(results[0].payload?.symbolId).toBe(baseSymbolId);
    });

    it("merged result carries the base name without the (part N/M) suffix", () => {
      const results = resolveSymbols(splitFragments, baseSymbolId);

      expect(results[0].payload?.name).toBe("resolve");
    });

    it("merged result lists every fragment id in mergedChunkIds", () => {
      const results = resolveSymbols(splitFragments, baseSymbolId);

      expect(results[0].payload?.mergedChunkIds).toEqual(expect.arrayContaining(["base-window", "part-1", "part-2"]));
    });

    it("uses the head fragment as content (begins at the signature, no duplicated overlap)", () => {
      const results = resolveSymbols(splitFragments, baseSymbolId);

      const content = results[0].payload?.content as string;
      // part-1 has the smallest startLine (722) — the method head, beginning at
      // `def resolve`. Exact equality proves the overlapping fragments were NOT
      // concatenated (which would duplicate the body).
      const head = splitFragments.find((c) => c.id === "part-1")!.payload.content;
      expect(content).toBe(head);
      expect(content.startsWith("def resolve")).toBe(true);
    });

    it("keeps a part fragment alone as a single result when the base window is absent", () => {
      // Only the parts survive the scroll (no separate `#resolve` window).
      const partsOnly = splitFragments.filter((c) => c.id !== "base-window");

      const results = resolveSymbols(partsOnly, baseSymbolId);

      expect(results).toHaveLength(1);
      expect(results[0].payload?.symbolId).toBe(baseSymbolId);
    });
  });

  describe("mixed results", () => {
    it("handles functions from different files separately", () => {
      const chunks = [
        {
          id: "uuid-1",
          payload: {
            symbolId: "validate",
            chunkType: "function",
            relativePath: "src/auth.ts",
            content: "function validate() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
        {
          id: "uuid-2",
          payload: {
            symbolId: "validate",
            chunkType: "function",
            relativePath: "src/input.ts",
            content: "function validate() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
      ];

      const results = resolveSymbols(chunks, "validate");

      expect(results).toHaveLength(2);
    });
  });
});
