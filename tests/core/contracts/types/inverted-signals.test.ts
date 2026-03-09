import { describe, expect, it } from "vitest";

import { AgeSignal } from "../../../../src/core/trajectory/git/rerank/derived-signals/age.js";
import { BlockPenaltySignal } from "../../../../src/core/trajectory/git/rerank/derived-signals/block-penalty.js";
import { ChurnSignal } from "../../../../src/core/trajectory/git/rerank/derived-signals/churn.js";
import { RecencySignal } from "../../../../src/core/trajectory/git/rerank/derived-signals/recency.js";
import { StabilitySignal } from "../../../../src/core/trajectory/git/rerank/derived-signals/stability.js";
import { ChunkSizeSignal } from "../../../../src/core/trajectory/static/rerank/derived-signals/chunk-size.js";

describe("DerivedSignalDescriptor.inverted", () => {
  it("RecencySignal is inverted (1 - normalize)", () => {
    const signal = new RecencySignal();
    expect(signal.inverted).toBe(true);
  });

  it("StabilitySignal is inverted (1 - normalize)", () => {
    const signal = new StabilitySignal();
    expect(signal.inverted).toBe(true);
  });

  it("BlockPenaltySignal is inverted", () => {
    const signal = new BlockPenaltySignal();
    expect(signal.inverted).toBe(true);
  });

  it("ChurnSignal is not inverted", () => {
    const signal = new ChurnSignal();
    expect(signal.inverted).toBeUndefined();
  });

  it("AgeSignal is not inverted", () => {
    const signal = new AgeSignal();
    expect(signal.inverted).toBeUndefined();
  });

  it("ChunkSizeSignal is not inverted", () => {
    const signal = new ChunkSizeSignal();
    expect(signal.inverted).toBeUndefined();
  });
});
