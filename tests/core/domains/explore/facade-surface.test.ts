import { describe, expect, it } from "vitest";

import { TEST_SCOPE_PARENT_TYPE } from "../../../../src/core/contracts/types/chunker.js";
import {
  CodeChunkGrouper,
  DocChunkGrouper,
  FileLevelGrouper,
  fileScopeOf,
  isTestChunk,
  isTestExampleChunk,
  reduceToFileScope,
  type ScrollChunk,
} from "../../../../src/core/domains/explore/chunk-grouping/index.js";
import { keepPathPatternMatches } from "../../../../src/core/domains/explore/post-process.js";

describe("explore facade surface", () => {
  describe("chunk-grouping", () => {
    it("exports isTestChunk", () => {
      const testChunk: ScrollChunk = { id: 1, payload: { chunkType: "test" } };
      const flaggedChunk: ScrollChunk = { id: 2, payload: { isTest: true } };
      const codeChunk: ScrollChunk = { id: 3, payload: { chunkType: "function" } };
      expect(isTestChunk(testChunk)).toBe(true);
      expect(isTestChunk(flaggedChunk)).toBe(true);
      expect(isTestChunk(codeChunk)).toBe(false);
    });

    it("exports isTestExampleChunk", () => {
      const example: ScrollChunk = { id: 1, payload: { parentType: TEST_SCOPE_PARENT_TYPE } };
      const member: ScrollChunk = { id: 2, payload: { parentType: "class_declaration" } };
      expect(isTestExampleChunk(example)).toBe(true);
      expect(isTestExampleChunk(member)).toBe(false);
    });

    it("exports the groupers and the file-scope helpers", () => {
      expect(CodeChunkGrouper).toBeDefined();
      expect(DocChunkGrouper).toBeDefined();
      expect(FileLevelGrouper).toBeDefined();
      expect(fileScopeOf([]).flatKeys.size).toBeGreaterThan(0);
      expect(typeof reduceToFileScope).toBe("function");
    });
  });

  describe("post-process", () => {
    it("exports keepPathPatternMatches", () => {
      const results = [
        { payload: { relativePath: "src/keep.ts" } },
        { payload: { relativePath: "docs/drop.md" } },
        { payload: {} },
      ];
      const kept = keepPathPatternMatches(results, (relativePath) => relativePath.startsWith("src/"));
      expect(kept).toHaveLength(1);
      expect(kept[0].payload?.relativePath).toBe("src/keep.ts");
    });
  });
});
