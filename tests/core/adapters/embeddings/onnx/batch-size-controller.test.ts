import { describe, expect, it } from "vitest";

import { BatchSizeController } from "../../../../../src/core/adapters/embeddings/onnx/batch-size-controller.js";

describe("BatchSizeController", () => {
  it("should start at calibrated size", () => {
    const c = new BatchSizeController(32);
    expect(c.currentBatchSize()).toBe(32);
  });

  it("should halve on pressure (msPerText > rollingAvg * 2)", () => {
    const c = new BatchSizeController(16);
    // Build baseline: 10ms/text for 10 reports
    for (let i = 0; i < 10; i++) {
      c.report(80, 8); // 10ms/text
    }
    expect(c.currentBatchSize()).toBe(16);

    // Pressure: 25ms/text > 10 * 2.0
    c.report(200, 8);
    expect(c.currentBatchSize()).toBe(8);
  });

  it("should double on stability (msPerText < rollingAvg * 1.2)", () => {
    const c = new BatchSizeController(32);
    // Start at 32, force halve to 16
    for (let i = 0; i < 10; i++) c.report(80, 8); // 10ms/text baseline
    c.report(200, 8); // pressure -> halves to 16
    expect(c.currentBatchSize()).toBe(16);

    // Stable reports at ~10ms/text (< baseline * 1.2 = 12)
    for (let i = 0; i < 10; i++) {
      c.report(80, 8); // 10ms/text
    }
    // Should grow back to 32
    expect(c.currentBatchSize()).toBe(32);
  });

  it("should not go below minSize", () => {
    const c = new BatchSizeController(8, 4);
    for (let i = 0; i < 10; i++) c.report(80, 8);
    // Massive pressure multiple times
    c.report(500, 8); // halve 8->4
    expect(c.currentBatchSize()).toBe(4);
    c.report(500, 4); // would halve to 2, but min is 4
    expect(c.currentBatchSize()).toBe(4);
  });

  it("should not go above calibrated size", () => {
    const c = new BatchSizeController(16);
    // All stable, try to grow
    for (let i = 0; i < 20; i++) c.report(80, 8);
    expect(c.currentBatchSize()).toBe(16); // capped at calibrated
  });

  it("should not adjust before rolling window is filled", () => {
    const c = new BatchSizeController(16);
    c.report(1000, 8); // extreme pressure, but window not full
    expect(c.currentBatchSize()).toBe(16); // no change
  });

  describe("recommendedPipelineBatchSize", () => {
    it("should return calibrated * 2 when above minimum", () => {
      const c = new BatchSizeController(64);
      expect(c.recommendedPipelineBatchSize()).toBe(128); // 64 * 2
    });

    it("should return minimum 32 when calibrated * 2 is below", () => {
      const c = new BatchSizeController(4);
      expect(c.recommendedPipelineBatchSize()).toBe(32); // max(32, 4*2=8) = 32
    });

    it("should return 32 when calibrated is exactly 16", () => {
      const c = new BatchSizeController(16);
      expect(c.recommendedPipelineBatchSize()).toBe(32); // max(32, 16*2=32) = 32
    });
  });
});
