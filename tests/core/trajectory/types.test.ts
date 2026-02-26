import { describe, expect, it } from "vitest";

import type {
  ChunkSignalOverlay,
  FieldDoc,
  FileSignalOverlay,
  FilterDescriptor,
  QdrantFilterCondition,
  ScoringWeights,
  Signal,
  TrajectoryQueryContract,
} from "../../../src/core/trajectory/types.js";

describe("trajectory types (re-export layer)", () => {
  it("Signal satisfies contract", () => {
    const signal: Signal = {
      key: "git.file.ageDays",
      name: "recency",
      type: "number",
      description: "Days since last modification",
      defaultBound: 365,
    };
    expect(signal.name).toBe("recency");
    expect(signal.key).toBe("git.file.ageDays");
    expect(signal.defaultBound).toBe(365);
  });

  it("FieldDoc is a deprecated alias for Signal", () => {
    // FieldDoc = Signal, so it must have the same required fields
    const field: FieldDoc = {
      key: "git.file.commitCount",
      name: "commitCount",
      type: "number",
      description: "Total number of commits modifying this file",
    };
    expect(field.key).toBe("git.file.commitCount");
    expect(field.name).toBe("commitCount");
    expect(field.type).toBe("number");
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

  it("FileSignalOverlay and ChunkSignalOverlay are extensible index types", () => {
    const file: FileSignalOverlay = { commitCount: 10, authors: ["a"] };
    const chunk: ChunkSignalOverlay = { churnRatio: 0.5 };
    expect(file.commitCount).toBe(10);
    expect(chunk.churnRatio).toBe(0.5);
  });

  it("TrajectoryQueryContract bundles signals, filters, presets", () => {
    const contract: TrajectoryQueryContract = {
      signals: [{ key: "test.field", name: "s", type: "number", description: "d" }],
      filters: [{ param: "p", description: "d", type: "string", toCondition: () => [] }],
      presets: { myPreset: { s: 1.0 } },
    };
    expect(contract.signals).toHaveLength(1);
    expect(contract.filters).toHaveLength(1);
    expect(contract.presets.myPreset).toBeDefined();
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
