import { describe, it, expect } from "vitest";
import {
  DEFAULT_GPU_BATCH_SIZE,
  PROBE_BATCH_SIZES,
  PROBE_PRESSURE_THRESHOLD,
  RUNTIME_PRESSURE_THRESHOLD,
  RUNTIME_STABLE_THRESHOLD,
  ROLLING_WINDOW,
  MIN_BATCH_SIZE,
} from "../../../../../src/core/adapters/embeddings/onnx/constants.js";

describe("ONNX constants", () => {
  it("DEFAULT_GPU_BATCH_SIZE should be 8", () => {
    expect(DEFAULT_GPU_BATCH_SIZE).toBe(8);
  });

  it("PROBE_BATCH_SIZES should be ascending", () => {
    for (let i = 1; i < PROBE_BATCH_SIZES.length; i++) {
      expect(PROBE_BATCH_SIZES[i]).toBeGreaterThan(PROBE_BATCH_SIZES[i - 1]);
    }
  });

  it("thresholds should be sensible", () => {
    expect(PROBE_PRESSURE_THRESHOLD).toBeGreaterThan(1);
    expect(RUNTIME_PRESSURE_THRESHOLD).toBeGreaterThan(RUNTIME_STABLE_THRESHOLD);
    expect(ROLLING_WINDOW).toBeGreaterThanOrEqual(5);
    expect(MIN_BATCH_SIZE).toBeGreaterThanOrEqual(1);
  });
});
