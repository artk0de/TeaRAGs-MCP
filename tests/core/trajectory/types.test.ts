import { describe, expect, it } from "vitest";

import type {
  ChunkMetadataOverlay,
  FieldDoc,
  FileMetadataOverlay,
  FilterDescriptor,
  QdrantFilterCondition,
  ScoringWeights,
  SignalDescriptor,
  TrajectoryQueryContract,
} from "../../../src/core/trajectory/types.js";

describe("trajectory types", () => {
  it("SignalDescriptor satisfies contract", () => {
    const signal: SignalDescriptor = {
      name: "testSignal",
      description: "Test signal",
      extract: (payload) => (payload?.value as number) ?? 0,
    };
    expect(signal.extract({ value: 0.5 })).toBe(0.5);
    expect(signal.extract({})).toBe(0);
  });

  it("SignalDescriptor supports optional confidence config", () => {
    const signal: SignalDescriptor = {
      name: "bugFix",
      description: "Bug fix rate",
      extract: () => 0.5,
      defaultBound: 100,
      needsConfidence: true,
      confidenceField: "git.file.commitCount",
    };
    expect(signal.needsConfidence).toBe(true);
    expect(signal.defaultBound).toBe(100);
    expect(signal.confidenceField).toBe("git.file.commitCount");
  });

  it("FilterDescriptor satisfies contract", () => {
    const filter: FilterDescriptor = {
      param: "minAge",
      description: "Minimum age in days",
      type: "number",
      toCondition: (value) => [{ key: "ageDays", range: { gte: value as number } }],
    };
    const conditions = filter.toCondition(30);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toEqual({ key: "ageDays", range: { gte: 30 } });
  });

  it("FieldDoc satisfies contract", () => {
    const field: FieldDoc = {
      key: "git.file.commitCount",
      type: "number",
      description: "Total number of commits modifying this file",
    };
    expect(field.key).toBe("git.file.commitCount");
    expect(field.type).toBe("number");
  });

  it("FileMetadataOverlay and ChunkMetadataOverlay are extensible index types", () => {
    const file: FileMetadataOverlay = { commitCount: 10, authors: ["a"] };
    const chunk: ChunkMetadataOverlay = { churnRatio: 0.5 };
    expect(file.commitCount).toBe(10);
    expect(chunk.churnRatio).toBe(0.5);
  });

  it("TrajectoryQueryContract bundles signals, filters, presets, fields", () => {
    const contract: TrajectoryQueryContract = {
      signals: [{ name: "s", description: "d", extract: () => 0 }],
      filters: [{ param: "p", description: "d", type: "string", toCondition: () => [] }],
      presets: { myPreset: { s: 1.0 } },
      payloadFields: [{ key: "k", type: "number", description: "d" }],
    };
    expect(contract.signals).toHaveLength(1);
    expect(contract.filters).toHaveLength(1);
    expect(contract.presets.myPreset).toBeDefined();
    expect(contract.payloadFields).toHaveLength(1);
  });

  it("ScoringWeights accepts arbitrary signal names", () => {
    const weights: ScoringWeights = {
      similarity: 0.5,
      customSignal: 0.3,
      anotherSignal: 0.2,
    };
    expect(weights.similarity).toBe(0.5);
    expect(weights.customSignal).toBe(0.3);
  });

  it("QdrantFilterCondition covers match and range patterns", () => {
    const matchCond: QdrantFilterCondition = {
      key: "git.dominantAuthor",
      match: { value: "alice" },
    };
    const rangeCond: QdrantFilterCondition = {
      key: "git.ageDays",
      range: { gte: 30 },
    };
    expect(matchCond.key).toBe("git.dominantAuthor");
    expect(rangeCond.key).toBe("git.ageDays");
  });
});
