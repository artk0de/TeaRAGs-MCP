import { describe, expect, it } from "vitest";

import {
  computeChunkSignals,
  type ChunkAccumulator,
} from "../../../../../../src/core/domains/trajectory/git/infra/metrics.js";

function makeAcc(overrides: Partial<ChunkAccumulator> = {}): ChunkAccumulator {
  return {
    commitShas: new Set(),
    authors: new Set(),
    bugFixCount: 0,
    lastModifiedAt: 0,
    linesAdded: 0,
    linesDeleted: 0,
    commitTimestamps: [],
    commitAuthors: [],
    taskIds: new Set(),
    ...overrides,
  };
}

describe("computeChunkSignals", () => {
  it("returns zeroed overlay for empty accumulator", () => {
    const result = computeChunkSignals(makeAcc(), 10);
    expect(result.commitCount).toBe(0);
    expect(result.churnRatio).toBe(0);
    expect(result.bugFixRate).toBe(0);
    expect(result.recencyWeightedFreq).toBe(0);
    expect(result.changeDensity).toBe(0);
    expect(result.churnVolatility).toBe(0);
    expect(result.ageDays).toBe(0);
    expect(result.taskIds).toEqual([]);
  });

  it("computes basic signals from accumulator", () => {
    const now = Date.now() / 1000;
    const result = computeChunkSignals(
      makeAcc({
        commitShas: new Set(["a", "b"]),
        authors: new Set(["alice"]),
        bugFixCount: 1,
        lastModifiedAt: now - 86400,
        linesAdded: 20,
        linesDeleted: 5,
        commitTimestamps: [now - 86400, now],
        commitAuthors: ["alice", "alice"],
      }),
      10,
      undefined,
      50,
    );
    expect(result.commitCount).toBe(2);
    expect(result.churnRatio).toBeCloseTo(0.2, 1);
    expect(result.contributorCount).toBe(1);
    expect(result.bugFixRate).toBeGreaterThan(0);
    expect(result.ageDays).toBeGreaterThanOrEqual(0);
    expect(result.relativeChurn).toBeGreaterThan(0);
    expect(result.recencyWeightedFreq).toBeGreaterThan(0);
  });

  it("computes churnVolatility for uneven gaps", () => {
    const now = Date.now() / 1000;
    const result = computeChunkSignals(
      makeAcc({
        commitShas: new Set(["a", "b", "c"]),
        authors: new Set(["alice"]),
        lastModifiedAt: now,
        linesAdded: 10,
        linesDeleted: 2,
        commitTimestamps: [now - 10 * 86400, now - 9 * 86400, now],
        commitAuthors: ["alice", "alice", "alice"],
      }),
      10,
      undefined,
      50,
    );
    // gaps = [1, 9], mean=5, variance=16, stddev=4
    expect(result.churnVolatility).toBeCloseTo(4.0, 1);
  });

  it("caps contributorCount at fileContributorCount", () => {
    const now = Date.now() / 1000;
    const result = computeChunkSignals(
      makeAcc({
        commitShas: new Set(["a"]),
        authors: new Set(["alice", "bob", "charlie"]),
        lastModifiedAt: now,
        linesAdded: 5,
        linesDeleted: 2,
        commitTimestamps: [now],
        commitAuthors: ["alice"],
      }),
      5,
      2,
      10,
    );
    expect(result.contributorCount).toBe(2);
  });

  it("defaults chunkLineCount to 1 when not provided", () => {
    const now = Date.now() / 1000;
    const result = computeChunkSignals(
      makeAcc({
        commitShas: new Set(["a"]),
        authors: new Set(["alice"]),
        lastModifiedAt: now,
        linesAdded: 10,
        linesDeleted: 5,
        commitTimestamps: [now],
        commitAuthors: ["alice"],
      }),
      1,
    );
    expect(result.relativeChurn).toBeGreaterThan(0);
  });

  it("passes through taskIds", () => {
    const result = computeChunkSignals(
      makeAcc({
        commitShas: new Set(["a"]),
        authors: new Set(["alice"]),
        lastModifiedAt: Date.now() / 1000,
        commitTimestamps: [Date.now() / 1000],
        commitAuthors: ["alice"],
        taskIds: new Set(["TD-123", "#456"]),
      }),
      1,
    );
    expect(result.taskIds).toEqual(expect.arrayContaining(["TD-123", "#456"]));
  });
});
