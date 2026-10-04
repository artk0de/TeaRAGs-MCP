import { describe, expect, it } from "vitest";

import { CodeChunkGrouper } from "../../../../../src/core/domains/explore/chunk-grouping/code.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";

describe("CodeChunkGrouper", () => {
  describe("group (class outline)", () => {
    it("builds outline with instance (#) and static (.) members sorted by startLine", () => {
      const classChunk: ScrollChunk = {
        id: "class-1",
        payload: {
          name: "Reranker",
          symbolId: "Reranker",
          chunkType: "class",
          relativePath: "src/reranker.ts",
          content: "class Reranker { ... }",
          startLine: 1,
          endLine: 50,
          language: "typescript",
          git: {
            file: { commitCount: 10, ageDays: 30 },
            chunk: { commitCount: 3, ageDays: 5 },
          },
        },
      };

      const memberChunks: ScrollChunk[] = [
        {
          id: "m-3",
          payload: {
            symbolId: "Reranker.create",
            name: "create",
            chunkType: "function",
            relativePath: "src/reranker.ts",
            content: "static create() { ... }",
            startLine: 40,
            endLine: 45,
            parentSymbolId: "Reranker",
          },
        },
        {
          id: "m-1",
          payload: {
            symbolId: "Reranker#rerank",
            name: "rerank",
            chunkType: "function",
            relativePath: "src/reranker.ts",
            content: "rerank(results) { ... }",
            startLine: 10,
            endLine: 20,
            parentSymbolId: "Reranker",
          },
        },
        {
          id: "m-2",
          payload: {
            symbolId: "Reranker#score",
            name: "score",
            chunkType: "function",
            relativePath: "src/reranker.ts",
            content: "score(item) { ... }",
            startLine: 25,
            endLine: 35,
            parentSymbolId: "Reranker",
          },
        },
      ];

      const result = CodeChunkGrouper.group(classChunk, memberChunks);

      expect(result.id).toBe("class-1");
      expect(result.score).toBe(1.0);

      // Synthetic outline content (members visible in outline, no separate members array)
      const content = result.payload?.content as string;
      expect(content).toBe("Reranker\n  Reranker#rerank\n  Reranker#score\n  Reranker.create");

      // Git stripped to file-level only
      expect(result.payload?.git).toEqual({ file: { commitCount: 10, ageDays: 30 } });
      expect((result.payload?.git as Record<string, unknown>).chunk).toBeUndefined();

      // Aggregated stats
      expect(result.payload?.chunkCount).toBe(4); // 1 class + 3 members
      expect(result.payload?.contentSize).toBe(
        "class Reranker { ... }".length +
          "rerank(results) { ... }".length +
          "score(item) { ... }".length +
          "static create() { ... }".length,
      );
    });

    // tea-rags-mcp-0am0: find_symbol metaOnly outlines flow through
    // CodeChunkGrouper, which rebuilt the payload from an explicit allowlist
    // and dropped the codegraph.symbols section entirely. Architectural-signal
    // presets (architecturalHub etc.) surface codegraph in their overlay, but
    // the outline projection must also preserve the nested codegraph.file
    // branch — mirroring how it strips git to file-level only.
    it("preserves codegraph.symbols.file nested section (stripped to file-level)", () => {
      const classChunk: ScrollChunk = {
        id: "class-cg",
        payload: {
          name: "Reranker",
          symbolId: "Reranker",
          chunkType: "class",
          relativePath: "src/reranker.ts",
          content: "class Reranker { ... }",
          startLine: 1,
          endLine: 50,
          language: "typescript",
          codegraph: {
            symbols: {
              file: {
                "codegraph.file.fanIn": 7,
                "codegraph.file.fanOut": 2,
                "codegraph.file.isHub": true,
              },
              chunk: { "codegraph.chunk.fanIn": 3 },
            },
          },
        },
      };

      const result = CodeChunkGrouper.group(classChunk, []);

      expect(result.payload?.codegraph).toEqual({
        symbols: {
          file: {
            "codegraph.file.fanIn": 7,
            "codegraph.file.fanOut": 2,
            "codegraph.file.isHub": true,
          },
        },
      });
      // chunk-level codegraph stripped (file-level outline)
      const cg = result.payload?.codegraph as { symbols?: { chunk?: unknown } };
      expect(cg.symbols?.chunk).toBeUndefined();
    });

    it("handles class with no members", () => {
      const classChunk: ScrollChunk = {
        id: "class-empty",
        payload: {
          name: "EmptyClass",
          symbolId: "EmptyClass",
          chunkType: "class",
          relativePath: "src/empty.ts",
          content: "class EmptyClass {}",
          startLine: 1,
          endLine: 1,
          language: "typescript",
        },
      };

      const result = CodeChunkGrouper.group(classChunk, []);

      expect(result.payload?.content).toBe("EmptyClass");
      expect(result.payload?.chunkCount).toBe(1);
      expect(result.payload?.contentSize).toBe("class EmptyClass {}".length);
      expect(result.payload?.git).toBeUndefined();
    });
  });

  describe("groupFile (file-level outline)", () => {
    it("builds hierarchy with top-level symbols and nested members", () => {
      const chunks: ScrollChunk[] = [
        {
          id: "c-1",
          payload: {
            name: "Reranker",
            symbolId: "Reranker",
            chunkType: "class",
            relativePath: "src/reranker.ts",
            content: "class Reranker {}",
            startLine: 5,
            endLine: 50,
            language: "typescript",
            git: {
              file: { commitCount: 10 },
              chunk: { commitCount: 2 },
            },
          },
        },
        {
          id: "c-2",
          payload: {
            name: "rerank",
            symbolId: "Reranker#rerank",
            chunkType: "function",
            relativePath: "src/reranker.ts",
            content: "rerank() {}",
            startLine: 10,
            endLine: 20,
            language: "typescript",
            parentSymbolId: "Reranker",
          },
        },
        {
          id: "c-3",
          payload: {
            name: "score",
            symbolId: "Reranker#score",
            chunkType: "function",
            relativePath: "src/reranker.ts",
            content: "score() {}",
            startLine: 25,
            endLine: 35,
            language: "typescript",
            parentSymbolId: "Reranker",
          },
        },
        {
          id: "c-4",
          payload: {
            name: "createReranker",
            symbolId: "createReranker",
            chunkType: "function",
            relativePath: "src/reranker.ts",
            content: "function createReranker() {}",
            startLine: 55,
            endLine: 60,
            language: "typescript",
          },
        },
        {
          id: "c-5",
          payload: {
            name: "DEFAULTS",
            symbolId: "DEFAULTS",
            chunkType: "block",
            relativePath: "src/reranker.ts",
            content: "const DEFAULTS = {}",
            startLine: 1,
            endLine: 3,
            language: "typescript",
            git: {
              file: { commitCount: 10 },
            },
          },
        },
      ];

      const result = CodeChunkGrouper.groupFile(chunks);

      expect(result.id).toBe("c-5"); // first by startLine (DEFAULTS at line 1)
      expect(result.score).toBe(1.0);

      const content = result.payload?.content as string;
      const lines = content.split("\n");
      expect(lines[0]).toBe("src/reranker.ts");
      expect(lines[1]).toBe("  DEFAULTS");
      expect(lines[2]).toBe("  Reranker");
      expect(lines[3]).toBe("    Reranker#rerank");
      expect(lines[4]).toBe("    Reranker#score");
      expect(lines[5]).toBe("  createReranker");

      expect(result.payload?.relativePath).toBe("src/reranker.ts");
      expect(result.payload?.language).toBe("typescript");
      expect(result.payload?.chunkCount).toBe(5);
      expect(result.payload?.git).toEqual({ file: { commitCount: 10 } });
    });

    // tea-rags-mcp-0am0: file-level outline (find_symbol relativePath mode)
    // must carry the codegraph.symbols.file branch like it carries git.file.
    it("preserves codegraph.symbols.file nested section in file outline", () => {
      const chunks: ScrollChunk[] = [
        {
          id: "fcg-1",
          payload: {
            name: "DEFAULTS",
            symbolId: "DEFAULTS",
            chunkType: "block",
            relativePath: "src/reranker.ts",
            content: "const DEFAULTS = {}",
            startLine: 1,
            endLine: 3,
            language: "typescript",
            git: { file: { commitCount: 10 } },
            codegraph: {
              symbols: {
                file: {
                  "codegraph.file.fanIn": 12,
                  "codegraph.file.instability": 0.4,
                },
                chunk: { "codegraph.chunk.fanIn": 1 },
              },
            },
          },
        },
      ];

      const result = CodeChunkGrouper.groupFile(chunks);

      expect(result.payload?.codegraph).toEqual({
        symbols: {
          file: {
            "codegraph.file.fanIn": 12,
            "codegraph.file.instability": 0.4,
          },
        },
      });
    });

    // tea-rags-mcp-zrma: level=file search hands the grouper a SUBSET of the
    // file (only the chunks that matched), so a method routinely arrives
    // without its declaring class. Such a member used to vanish from the
    // outline entirely — it is neither top-level nor reachable from any
    // rendered parent. It must surface as a root under its qualified symbolId.
    it("renders members whose declaring parent is absent as roots", () => {
      const chunks: ScrollChunk[] = [
        {
          id: "o-1",
          payload: {
            name: "rerank",
            symbolId: "Reranker#rerank",
            chunkType: "function",
            relativePath: "src/reranker.ts",
            content: "rerank() {}",
            startLine: 10,
            endLine: 20,
            language: "typescript",
            parentSymbolId: "Reranker",
          },
        },
        {
          id: "o-2",
          payload: {
            name: "createReranker",
            symbolId: "createReranker",
            chunkType: "function",
            relativePath: "src/reranker.ts",
            content: "function createReranker() {}",
            startLine: 55,
            endLine: 60,
            language: "typescript",
          },
        },
      ];

      const result = CodeChunkGrouper.groupFile(chunks);

      expect(result.payload?.content).toBe("src/reranker.ts\n  Reranker#rerank\n  createReranker");
    });

    it("handles file with only top-level symbols (no nesting)", () => {
      const chunks: ScrollChunk[] = [
        {
          id: "f-1",
          payload: {
            name: "helperA",
            symbolId: "helperA",
            chunkType: "function",
            relativePath: "src/utils.ts",
            content: "function helperA() {}",
            startLine: 1,
            endLine: 5,
            language: "typescript",
          },
        },
        {
          id: "f-2",
          payload: {
            name: "helperB",
            symbolId: "helperB",
            chunkType: "function",
            relativePath: "src/utils.ts",
            content: "function helperB() {}",
            startLine: 10,
            endLine: 15,
            language: "typescript",
          },
        },
      ];

      const result = CodeChunkGrouper.groupFile(chunks);

      const content = result.payload?.content as string;
      expect(content).toBe("src/utils.ts\n  helperA\n  helperB");
      expect(result.payload?.chunkCount).toBe(2);
    });
  });

  describe("groupFile on a test file (outline by example, tea-rags-mcp-msv3l)", () => {
    const specPath = "spec/models/user_spec.rb";
    const testChunk = (
      id: string,
      symbolId: string,
      parentSymbolId: string,
      startLine: number,
      chunkType = "test",
    ): ScrollChunk => ({
      id,
      payload: {
        symbolId,
        name: symbolId.slice(parentSymbolId.length + 1),
        chunkType,
        isTest: true,
        parentSymbolId,
        parentType: "test_scope",
        relativePath: specPath,
        language: "ruby",
        content: `it "case ${startLine}" do\n  expect(user).to be_valid\nend`,
        startLine,
        endLine: startLine + 2,
      },
    });
    const admin = "User.context 'when admin'";
    const guest = "User.context 'when guest'";

    it("lists each scope once as an address with its examples nested under it, in line order", () => {
      const chunks = [
        testChunk("e-3", `${guest}.it 'cannot invite'`, guest, 30),
        testChunk("e-1", `${admin}.it 'can manage accounts'`, admin, 10),
        testChunk("e-2", `${admin}.it 'can invite'`, admin, 15),
      ];

      const result = CodeChunkGrouper.groupFile(chunks);

      expect(result.payload?.content).toBe(
        [
          specPath,
          `  ${admin}`,
          `    ${admin}.it 'can manage accounts'`,
          `    ${admin}.it 'can invite'`,
          `  ${guest}`,
          `    ${guest}.it 'cannot invite'`,
        ].join("\n"),
      );
    });

    it("folds an oversized example's #partN windows into one line under its scope", () => {
      const huge = `${admin}.it 'exports everything'`;
      const chunks = [
        testChunk("e-1", `${admin}.it 'can invite'`, admin, 10),
        testChunk("p-1", `${huge}#part1`, huge, 20),
        testChunk("p-2", `${huge}#part2`, huge, 40),
      ];

      const result = CodeChunkGrouper.groupFile(chunks);

      expect(result.payload?.content).toBe(
        [specPath, `  ${admin}`, `    ${admin}.it 'can invite'`, `    ${huge}`].join("\n"),
      );
    });

    it("lists every member of a grouped tiny-example chunk under its scope (5xpq4)", () => {
      const group = testChunk("g-1", `${admin}.it`, admin, 10);
      group.payload.memberSymbolIds = [`${admin}.it`, `${admin}.it~2`, `${admin}.it~3`];

      const result = CodeChunkGrouper.groupFile([group, testChunk("e-1", `${admin}.it 'can invite'`, admin, 20)]);

      expect(result.payload?.content).toBe(
        [
          specPath,
          `  ${admin}`,
          `    ${admin}.it`,
          `    ${admin}.it~2`,
          `    ${admin}.it~3`,
          `    ${admin}.it 'can invite'`,
        ].join("\n"),
      );
    });

    it("folds a scope's setup chunk into the scope line its examples draw (5xpq4)", () => {
      const setup = testChunk("s-1", admin, "User", 4, "test_setup");
      setup.payload.parentType = "call";

      const result = CodeChunkGrouper.groupFile([setup, testChunk("e-1", `${admin}.it 'can invite'`, admin, 10)]);

      expect(result.payload?.content).toBe([specPath, `  ${admin}`, `    ${admin}.it 'can invite'`].join("\n"));
    });

    it("folds the drawn members of a packed setup chunk and lists only its undrawn ones (5xpq4)", () => {
      const fixtures = "User.context 'shared fixtures'";
      const pack = testChunk("s-1", admin, "User", 4, "test_setup");
      pack.payload.parentType = "call";
      pack.payload.memberSymbolIds = [admin, fixtures];

      const result = CodeChunkGrouper.groupFile([pack, testChunk("e-1", `${admin}.it 'can invite'`, admin, 10)]);

      expect(result.payload?.content).toBe(
        [specPath, `  ${fixtures}`, `  ${admin}`, `    ${admin}.it 'can invite'`].join("\n"),
      );
    });

    it("draws a setup-only scope and a pre-example-era test chunk as plain lines, not as a scope", () => {
      const setupOnly = testChunk("s-1", "User.context 'shared fixtures'", "User", 3, "test_setup");
      const legacy = testChunk("l-1", "User.describe User", "User", 20);
      setupOnly.payload.parentType = "call";
      legacy.payload.parentType = "call";

      const result = CodeChunkGrouper.groupFile([setupOnly, legacy]);

      expect(result.payload?.content).toBe(
        [specPath, "  User.context 'shared fixtures'", "  User.describe User"].join("\n"),
      );
    });

    it("leaves non-test orphans labelled by their own qualified symbolId", () => {
      const chunks: ScrollChunk[] = [
        {
          id: "m-1",
          payload: {
            symbolId: "Reranker#rerank",
            name: "rerank",
            chunkType: "function",
            parentSymbolId: "Reranker",
            relativePath: "src/reranker.ts",
            startLine: 5,
            endLine: 9,
          },
        },
        {
          id: "m-2",
          payload: {
            symbolId: "Reranker#score",
            name: "score",
            chunkType: "function",
            parentSymbolId: "Reranker",
            relativePath: "src/reranker.ts",
            startLine: 12,
            endLine: 20,
          },
        },
      ];

      const result = CodeChunkGrouper.groupFile(chunks);

      expect(result.payload?.content).toBe("src/reranker.ts\n  Reranker#rerank\n  Reranker#score");
    });
  });
});
