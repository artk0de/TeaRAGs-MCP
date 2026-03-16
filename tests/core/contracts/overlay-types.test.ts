import { describe, expect, it } from "vitest";

import type { OverlayMask, RankingOverlay } from "../../../src/core/contracts/types/reranker.js";

describe("OverlayMask", () => {
  it("should only have file and chunk fields", () => {
    const mask: OverlayMask = {
      file: ["commitCount", "ageDays"],
      chunk: ["commitCount"],
    };
    expect(mask).not.toHaveProperty("derived");
    expect(mask.file).toHaveLength(2);
  });
});

describe("RankingOverlay", () => {
  it("should not have derived field", () => {
    const overlay: RankingOverlay = {
      preset: "techDebt",
      file: { commitCount: { value: 12, label: "high" } },
    };
    expect(overlay).not.toHaveProperty("derived");
  });

  it("should support value+label objects in file/chunk", () => {
    const overlay: RankingOverlay = {
      preset: "test",
      file: {
        commitCount: { value: 12, label: "high" },
        dominantAuthor: "Alice",
      },
      chunk: { commitCount: { value: 8, label: "high" } },
    };
    expect((overlay.file!.commitCount as any).label).toBe("high");
    expect(overlay.file!.dominantAuthor).toBe("Alice");
  });
});
