import { describe, expect, it } from "vitest";

import { detectDevice, graphOptimizationLevelFor } from "../../../../../src/core/adapters/embeddings/onnx/device.js";

describe("detectDevice", () => {
  it("honours an explicitly requested backend verbatim", () => {
    expect(detectDevice("cpu")).toBe("cpu");
    expect(detectDevice("webgpu")).toBe("webgpu");
    expect(detectDevice("cuda")).toBe("cuda");
  });

  it("auto-detects webgpu when nothing is requested", () => {
    expect(detectDevice()).toBe("webgpu");
  });

  it('treats the literal "auto" as a request to auto-detect, not as a backend name', () => {
    expect(detectDevice("auto")).toBe("webgpu");
  });

  it("treats an empty string as unset rather than as an explicit backend", () => {
    expect(detectDevice("")).toBe("webgpu");
  });
});

// bd tea-rags-mcp-a3wk — onnxruntime 1.24.3 aborts session init on the fp16
// jina model at graphOptimizationLevel "all" on the CPU provider
// (InsertedPrecisionFreeCast_ … SimplifiedLayerNormFusion); "extended" loads it.
describe("graphOptimizationLevelFor", () => {
  it("steps the CPU fp16 session down from the level that crashes its init", () => {
    expect(graphOptimizationLevelFor("cpu", "fp16")).toBe("extended");
  });

  it("keeps full optimization for every combination that loads at it", () => {
    expect(graphOptimizationLevelFor("webgpu", "fp16")).toBe("all");
    expect(graphOptimizationLevelFor("cpu", "fp32")).toBe("all");
    expect(graphOptimizationLevelFor("cpu", "q8")).toBe("all");
    expect(graphOptimizationLevelFor("cpu", undefined)).toBe("all");
  });
});
