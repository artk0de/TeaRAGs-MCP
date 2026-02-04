/**
 * Tests for PointsAccumulator
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PointsAccumulator, createAccumulator, type DensePoint, type HybridPoint } from "./accumulator.js";
import type { QdrantManager } from "./client.js";

// Mock QdrantManager
const createMockQdrant = () => ({
  addPointsOptimized: vi.fn().mockResolvedValue(undefined),
  addPointsWithSparseOptimized: vi.fn().mockResolvedValue(undefined),
});

function createPoints(count: number): DensePoint[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `point-${i}`,
    vector: Array(768).fill(0.1 * i),
    payload: { index: i },
  }));
}

function createHybridPoints(count: number): HybridPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `point-${i}`,
    vector: Array(768).fill(0.1 * i),
    sparseVector: { indices: [i], values: [1.0] },
    payload: { index: i },
  }));
}

describe("PointsAccumulator", () => {
  let mockQdrant: ReturnType<typeof createMockQdrant>;

  beforeEach(() => {
    mockQdrant = createMockQdrant();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("should create accumulator with default config", () => {
      const acc = new PointsAccumulator(
        mockQdrant as unknown as QdrantManager,
        "test-collection",
      );

      const stats = acc.getStats();
      expect(stats.totalPointsFlushed).toBe(0);
      expect(stats.flushCount).toBe(0);
      expect(stats.pendingPoints).toBe(0);
    });

    it("should create accumulator with custom config", () => {
      const acc = new PointsAccumulator(
        mockQdrant as unknown as QdrantManager,
        "test-collection",
        false,
        { bufferSize: 50, flushIntervalMs: 1000, ordering: "medium" },
      );

      expect(acc).toBeDefined();
    });
  });

  describe("add() - dense points", () => {
    it("should buffer points without flushing when under threshold", async () => {
      const acc = new PointsAccumulator(
        mockQdrant as unknown as QdrantManager,
        "test-collection",
        false,
        { bufferSize: 100, flushIntervalMs: 0 },
      );

      await acc.add(createPoints(50));

      expect(mockQdrant.addPointsOptimized).not.toHaveBeenCalled();
      expect(acc.getStats().pendingPoints).toBe(50);
    });

    it("should auto-flush when buffer reaches threshold", async () => {
      const acc = new PointsAccumulator(
        mockQdrant as unknown as QdrantManager,
        "test-collection",
        false,
        { bufferSize: 100, flushIntervalMs: 0 },
      );

      await acc.add(createPoints(150));

      expect(mockQdrant.addPointsOptimized).toHaveBeenCalledTimes(1);
      expect(acc.getStats().pendingPoints).toBe(50);
      expect(acc.getStats().totalPointsFlushed).toBe(100);
    });

    it("should flush multiple batches when adding many points", async () => {
      const acc = new PointsAccumulator(
        mockQdrant as unknown as QdrantManager,
        "test-collection",
        false,
        { bufferSize: 100, flushIntervalMs: 0 },
      );

      await acc.add(createPoints(350));

      expect(mockQdrant.addPointsOptimized).toHaveBeenCalledTimes(3);
      expect(acc.getStats().pendingPoints).toBe(50);
      expect(acc.getStats().totalPointsFlushed).toBe(300);
    });

    it("should use wait=false for auto-flush", async () => {
      const acc = new PointsAccumulator(
        mockQdrant as unknown as QdrantManager,
        "test-collection",
        false,
        { bufferSize: 100, flushIntervalMs: 0, ordering: "weak" },
      );

      await acc.add(createPoints(100));

      expect(mockQdrant.addPointsOptimized).toHaveBeenCalledWith(
        "test-collection",
        expect.any(Array),
        { wait: false, ordering: "weak" },
      );
    });
  });

  describe("add() - hybrid points", () => {
    it("should use addPointsWithSparseOptimized for hybrid mode", async () => {
      const acc = new PointsAccumulator(
        mockQdrant as unknown as QdrantManager,
        "test-collection",
        true, // hybrid mode
        { bufferSize: 100, flushIntervalMs: 0 },
      );

      await acc.add(createHybridPoints(100));

      expect(mockQdrant.addPointsWithSparseOptimized).toHaveBeenCalledTimes(1);
      expect(mockQdrant.addPointsOptimized).not.toHaveBeenCalled();
    });
  });

  describe("flush()", () => {
    it("should flush remaining points with wait=true", async () => {
      const acc = new PointsAccumulator(
        mockQdrant as unknown as QdrantManager,
        "test-collection",
        false,
        { bufferSize: 100, flushIntervalMs: 0 },
      );

      await acc.add(createPoints(50));
      await acc.flush();

      expect(mockQdrant.addPointsOptimized).toHaveBeenCalledWith(
        "test-collection",
        expect.any(Array),
        { wait: true, ordering: "weak" },
      );
      expect(acc.getStats().pendingPoints).toBe(0);
    });

    it("should not call API when buffer is empty", async () => {
      const acc = new PointsAccumulator(
        mockQdrant as unknown as QdrantManager,
        "test-collection",
        false,
        { bufferSize: 100, flushIntervalMs: 0 },
      );

      await acc.flush();

      expect(mockQdrant.addPointsOptimized).not.toHaveBeenCalled();
    });
  });

  describe("auto-flush timer", () => {
    it("should flush on timer when enabled", async () => {
      const acc = new PointsAccumulator(
        mockQdrant as unknown as QdrantManager,
        "test-collection",
        false,
        { bufferSize: 100, flushIntervalMs: 500 },
      );

      await acc.add(createPoints(30));
      expect(mockQdrant.addPointsOptimized).not.toHaveBeenCalled();

      // Advance timer
      await vi.advanceTimersByTimeAsync(500);

      expect(mockQdrant.addPointsOptimized).toHaveBeenCalledTimes(1);
    });

    it("should stop timer on explicit flush", async () => {
      const acc = new PointsAccumulator(
        mockQdrant as unknown as QdrantManager,
        "test-collection",
        false,
        { bufferSize: 100, flushIntervalMs: 500 },
      );

      await acc.add(createPoints(30));
      await acc.flush();

      // Advance timer - should not trigger additional flush
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockQdrant.addPointsOptimized).toHaveBeenCalledTimes(1);
    });
  });

  describe("error handling", () => {
    it("should restore points to buffer on error", async () => {
      mockQdrant.addPointsOptimized.mockRejectedValueOnce(new Error("Connection failed"));

      const acc = new PointsAccumulator(
        mockQdrant as unknown as QdrantManager,
        "test-collection",
        false,
        { bufferSize: 100, flushIntervalMs: 0 },
      );

      await acc.add(createPoints(50));

      await expect(acc.flush()).rejects.toThrow("Connection failed");

      // Points should be back in buffer
      expect(acc.getStats().pendingPoints).toBe(50);
    });
  });

  describe("getStats() and resetStats()", () => {
    it("should track statistics correctly", async () => {
      const acc = new PointsAccumulator(
        mockQdrant as unknown as QdrantManager,
        "test-collection",
        false,
        { bufferSize: 100, flushIntervalMs: 0 },
      );

      await acc.add(createPoints(250));

      const stats = acc.getStats();
      expect(stats.totalPointsFlushed).toBe(200);
      expect(stats.flushCount).toBe(2);
      expect(stats.pendingPoints).toBe(50);
      expect(stats.lastFlushTime).not.toBeNull();
    });

    it("should reset statistics", async () => {
      const acc = new PointsAccumulator(
        mockQdrant as unknown as QdrantManager,
        "test-collection",
        false,
        { bufferSize: 100, flushIntervalMs: 0 },
      );

      await acc.add(createPoints(150));
      acc.resetStats();

      const stats = acc.getStats();
      expect(stats.totalPointsFlushed).toBe(0);
      expect(stats.flushCount).toBe(0);
      expect(stats.pendingPoints).toBe(50); // Pending preserved
    });
  });

  describe("dispose()", () => {
    it("should flush and cleanup", async () => {
      const acc = new PointsAccumulator(
        mockQdrant as unknown as QdrantManager,
        "test-collection",
        false,
        { bufferSize: 100, flushIntervalMs: 500 },
      );

      await acc.add(createPoints(30));
      await acc.dispose();

      expect(mockQdrant.addPointsOptimized).toHaveBeenCalledTimes(1);
      expect(acc.getStats().pendingPoints).toBe(0);
    });
  });
});

describe("createAccumulator", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should use default values", () => {
    const mockQdrant = createMockQdrant();
    const acc = createAccumulator(
      mockQdrant as unknown as QdrantManager,
      "test-collection",
    );

    expect(acc).toBeDefined();
  });

  it("should read QDRANT_UPSERT_BATCH_SIZE from env (with CODE_BATCH_SIZE fallback)", () => {
    process.env.QDRANT_UPSERT_BATCH_SIZE = "200";
    const mockQdrant = createMockQdrant();
    const acc = createAccumulator(
      mockQdrant as unknown as QdrantManager,
      "test-collection",
    );

    expect(acc).toBeDefined();
  });

  it("should read QDRANT_FLUSH_INTERVAL_MS from env", () => {
    process.env.QDRANT_FLUSH_INTERVAL_MS = "1000";
    const mockQdrant = createMockQdrant();
    const acc = createAccumulator(
      mockQdrant as unknown as QdrantManager,
      "test-collection",
    );

    expect(acc).toBeDefined();
  });

  it("should create hybrid accumulator", () => {
    const mockQdrant = createMockQdrant();
    const acc = createAccumulator(
      mockQdrant as unknown as QdrantManager,
      "test-collection",
      true, // hybrid
    );

    expect(acc).toBeDefined();
  });
});
