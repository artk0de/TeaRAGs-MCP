import { describe, expect, it } from "vitest";

import { FileLevelGrouper } from "../../../../../src/core/domains/explore/chunk-grouping/file-level.js";
import type { ExploreResult } from "../../../../../src/core/domains/explore/strategies/types.js";

describe("FileLevelGrouper", () => {
  describe("group (dedup by file)", () => {
    // Moved from BaseExploreStrategy#groupByFile tests — the invariant is
    // unchanged, only its home. Grouping is no longer a responsibility of the
    // strategy hub (tea-rags-mcp-zrma).
    it("deduplicates by relativePath, keeping highest-scored per file", () => {
      const results: ExploreResult[] = [
        { id: "1", score: 0.9, payload: { relativePath: "src/a.ts", content: "chunk1" } },
        { id: "2", score: 0.8, payload: { relativePath: "src/a.ts", content: "chunk2" } },
        { id: "3", score: 0.7, payload: { relativePath: "src/b.ts", content: "chunk3" } },
        { id: "4", score: 0.6, payload: { relativePath: "src/c.ts", content: "chunk4" } },
      ];

      const grouped = FileLevelGrouper.group(results, 10);

      expect(grouped).toHaveLength(3);
      expect(grouped[0].payload?.relativePath).toBe("src/a.ts");
      expect(grouped[0].score).toBe(0.9);
    });

    it("respects limit parameter", () => {
      const results: ExploreResult[] = [
        { id: "1", score: 0.9, payload: { relativePath: "src/a.ts" } },
        { id: "2", score: 0.8, payload: { relativePath: "src/b.ts" } },
        { id: "3", score: 0.7, payload: { relativePath: "src/c.ts" } },
      ];

      expect(FileLevelGrouper.group(results, 2)).toHaveLength(2);
    });

    it("keeps the representative payload of the highest-scored hit", () => {
      const results: ExploreResult[] = [
        { id: "top", score: 0.9, payload: { relativePath: "src/a.ts", symbolId: "Alpha", content: "alpha body" } },
        { id: "low", score: 0.4, payload: { relativePath: "src/a.ts", symbolId: "Beta", content: "beta body" } },
      ];

      const [file] = FileLevelGrouper.group(results, 10);

      expect(file.id).toBe("top");
      expect(file.payload?.symbolId).toBe("Alpha");
      expect(file.payload?.content).toBe("alpha body");
    });

    // bd tea-rags-mcp-947xf: the collapsed hits covered nearly the whole file,
    // so the outline built from them duplicated find_symbol(relativePath).
    it("attaches no members outline of the collapsed hits", () => {
      const results: ExploreResult[] = [
        { id: "1", score: 0.9, payload: { relativePath: "src/a.ts", name: "Alpha", symbolId: "Alpha" } },
        { id: "2", score: 0.8, payload: { relativePath: "src/a.ts", name: "run", symbolId: "Alpha#run" } },
      ];

      const [file] = FileLevelGrouper.group(results, 10);

      expect(file.payload).not.toHaveProperty("members");
    });

    it("leaves results without a payload untouched", () => {
      const grouped = FileLevelGrouper.group([{ id: "x", score: 0.5 }], 10);

      expect(grouped).toHaveLength(1);
      expect(grouped[0].payload).toBeUndefined();
    });
  });
});
