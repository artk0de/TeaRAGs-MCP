/**
 * Tests for chunk-level overlay assembler.
 *
 * The assembler computes ChunkChurnOverlay from a ChunkAccumulator,
 * mirroring the original computeChunkSignals() behavior.
 */

import { describe, expect, it } from "vitest";

import type { ChunkAccumulator } from "../../../../../../src/core/trajectory/git/infra/metrics.js";
import { assembleChunkSignals } from "../../../../../../src/core/trajectory/git/infra/metrics/chunk-assembler.js";

describe("assembleChunkSignals", () => {
  it("computes overlay from accumulator", () => {
    const acc: ChunkAccumulator = {
      commitShas: new Set(["a", "b"]),
      authors: new Set(["alice"]),
      bugFixCount: 1,
      lastModifiedAt: Date.now() / 1000 - 86400,
      linesAdded: 20,
      linesDeleted: 5,
      commitTimestamps: [Date.now() / 1000 - 86400, Date.now() / 1000],
    };
    const result = assembleChunkSignals(acc, 10, undefined, 50);
    expect(result.commitCount).toBe(2);
    expect(result.churnRatio).toBeCloseTo(0.2, 1);
    expect(result.contributorCount).toBe(1);
    // Laplace-smoothed: (1 + 0.5) / (2 + 1.0) = 1.5/3.0 = 0.5 → 50
    expect(result.bugFixRate).toBe(50);
    expect(result.ageDays).toBeGreaterThanOrEqual(0);
    // relativeChurn uses saturation: (25/50) * (1 - exp(-50/30))
    expect(result.relativeChurn).toBeGreaterThan(0);
    expect(result.relativeChurn).toBeLessThan(0.5);
  });

  it("returns zero-value overlay for empty accumulator", () => {
    const acc: ChunkAccumulator = {
      commitShas: new Set(),
      authors: new Set(),
      bugFixCount: 0,
      lastModifiedAt: 0,
      linesAdded: 0,
      linesDeleted: 0,
      commitTimestamps: [],
    };
    const result = assembleChunkSignals(acc, 10, undefined, 50);
    expect(result.commitCount).toBe(0);
    expect(result.churnRatio).toBe(0);
    expect(result.bugFixRate).toBe(0);
    expect(result.recencyWeightedFreq).toBe(0);
    expect(result.changeDensity).toBe(0);
    expect(result.ageDays).toBe(0);
  });

  it("caps contributorCount at file-level when provided", () => {
    const acc: ChunkAccumulator = {
      commitShas: new Set(["a"]),
      authors: new Set(["alice", "bob", "charlie"]),
      bugFixCount: 0,
      lastModifiedAt: Date.now() / 1000,
      linesAdded: 5,
      linesDeleted: 2,
      commitTimestamps: [Date.now() / 1000],
    };
    const result = assembleChunkSignals(acc, 5, 2, 10);
    expect(result.contributorCount).toBe(2); // capped at fileContributorCount
  });

  it("uses chunk authors count when fileContributorCount not provided", () => {
    const acc: ChunkAccumulator = {
      commitShas: new Set(["a"]),
      authors: new Set(["alice", "bob"]),
      bugFixCount: 0,
      lastModifiedAt: Date.now() / 1000,
      linesAdded: 5,
      linesDeleted: 2,
      commitTimestamps: [Date.now() / 1000],
    };
    const result = assembleChunkSignals(acc, 5, undefined, 10);
    expect(result.contributorCount).toBe(2);
  });

  it("computes recencyWeightedFreq from commit timestamps", () => {
    const now = Date.now() / 1000;
    const acc: ChunkAccumulator = {
      commitShas: new Set(["a"]),
      authors: new Set(["alice"]),
      bugFixCount: 0,
      lastModifiedAt: now,
      linesAdded: 1,
      linesDeleted: 0,
      commitTimestamps: [now], // 0 days ago
    };
    const result = assembleChunkSignals(acc, 1, undefined, 10);
    expect(result.recencyWeightedFreq).toBeCloseTo(1.0, 1);
  });
});
