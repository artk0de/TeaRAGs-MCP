import { describe, it, expect } from "vitest";
import { GPU_BATCH_SIZE } from "../../../../../src/core/adapters/embeddings/onnx/constants.js";

describe("GPU_BATCH_SIZE", () => {
  it("should be 8", () => {
    expect(GPU_BATCH_SIZE).toBe(8);
  });
});
