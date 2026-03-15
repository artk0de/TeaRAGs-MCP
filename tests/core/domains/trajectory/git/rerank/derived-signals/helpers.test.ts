import { describe, expect, it } from "vitest";

import {
  blendNormalized,
  blendSignal,
  payloadAlpha,
} from "../../../../../../../src/core/domains/trajectory/git/rerank/derived-signals/helpers.js";

describe("payloadAlpha with signalLevel", () => {
  const payloadWithChunk = {
    git: {
      file: { commitCount: 20, ageDays: 100 },
      chunk: { commitCount: 10, ageDays: 50 },
    },
  };

  it("should return 0 when signalLevel is file", () => {
    expect(payloadAlpha(payloadWithChunk, "file")).toBe(0);
  });

  it("should compute normally when signalLevel is chunk", () => {
    const alpha = payloadAlpha(payloadWithChunk, "chunk");
    expect(alpha).toBeGreaterThan(0);
  });

  it("should compute normally when signalLevel is undefined", () => {
    const alpha = payloadAlpha(payloadWithChunk);
    expect(alpha).toBeGreaterThan(0);
  });

  it("should return same alpha for chunk and undefined", () => {
    const alphaChunk = payloadAlpha(payloadWithChunk, "chunk");
    const alphaUndefined = payloadAlpha(payloadWithChunk);
    expect(alphaChunk).toBe(alphaUndefined);
  });
});

describe("blendNormalized with signalLevel", () => {
  const payload = {
    git: {
      file: { commitCount: 20, ageDays: 100 },
      chunk: { commitCount: 10, ageDays: 50 },
    },
  };

  it("should return pure file value when signalLevel is file", () => {
    const fileOnly = blendNormalized(payload, "ageDays", 365, 365, "file");
    const fileVal = 100 / 365; // normalize(100, 365)
    expect(fileOnly).toBeCloseTo(fileVal, 5);
  });

  it("should blend when signalLevel is chunk", () => {
    const blended = blendNormalized(payload, "ageDays", 365, 365, "chunk");
    const fileOnly = blendNormalized(payload, "ageDays", 365, 365, "file");
    expect(blended).not.toBeCloseTo(fileOnly, 5);
  });

  it("should blend when signalLevel is undefined", () => {
    const blended = blendNormalized(payload, "ageDays", 365, 365);
    const fileOnly = blendNormalized(payload, "ageDays", 365, 365, "file");
    expect(blended).not.toBeCloseTo(fileOnly, 5);
  });
});

describe("blendSignal with signalLevel", () => {
  const payload = {
    git: {
      file: { ageDays: 100, commitCount: 20 },
      chunk: { ageDays: 50, commitCount: 10 },
    },
  };

  it("should return pure file value when signalLevel is file", () => {
    expect(blendSignal(payload, "ageDays", "file")).toBe(100);
  });

  it("should blend file and chunk when signalLevel is chunk", () => {
    const blended = blendSignal(payload, "ageDays", "chunk");
    // Should be between chunk (50) and file (100)
    expect(blended).toBeGreaterThan(50);
    expect(blended).toBeLessThan(100);
  });

  it("should blend file and chunk when signalLevel is undefined", () => {
    const blended = blendSignal(payload, "ageDays");
    expect(blended).toBeGreaterThan(50);
    expect(blended).toBeLessThan(100);
  });
});
