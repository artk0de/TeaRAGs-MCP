import { describe, expect, it } from "vitest";

import type { RerankPreset, SignalLevel } from "../../../../src/core/contracts/types/reranker.js";

describe("SignalLevel type", () => {
  it("should accept file and chunk as valid signal levels", () => {
    const file: SignalLevel = "file";
    const chunk: SignalLevel = "chunk";
    expect(file).toBe("file");
    expect(chunk).toBe("chunk");
  });

  it("should allow signalLevel on RerankPreset", () => {
    const preset: RerankPreset = {
      name: "test",
      description: "test",
      tools: ["semantic_search"],
      weights: { similarity: 1 },
      overlayMask: {},
      signalLevel: "file",
    };
    expect(preset.signalLevel).toBe("file");
  });

  it("should default signalLevel to undefined (treated as chunk)", () => {
    const preset: RerankPreset = {
      name: "test",
      description: "test",
      tools: ["semantic_search"],
      weights: { similarity: 1 },
      overlayMask: {},
    };
    expect(preset.signalLevel).toBeUndefined();
  });
});
