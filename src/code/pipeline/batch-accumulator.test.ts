/**
 * Tests for BatchAccumulator
 *
 * Coverage:
 * - Basic batch formation
 * - Flush on batch size reached
 * - Flush on timeout (partial batches)
 * - Backpressure handling
 * - Edge cases
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchAccumulator } from "./batch-accumulator.js";
import type { Batch, BatchAccumulatorConfig, UpsertItem } from "./types.js";

describe("BatchAccumulator", () => {
  let accumulator: BatchAccumulator<UpsertItem>;
  let receivedBatches: Batch<UpsertItem>[];
  let config: BatchAccumulatorConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    receivedBatches = [];

    config = {
      batchSize: 5,
      flushTimeoutMs: 100,
      maxQueueSize: 10,
    };

    accumulator = new BatchAccumulator(config, "upsert", (batch) => {
      receivedBatches.push(batch);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper to create test items
  function createItem(id: number): UpsertItem {
    return {
      type: "upsert",
      id: `item-${id}`,
      point: {
        id: `item-${id}`,
        vector: [1, 2, 3],
        payload: { index: id },
      },
    };
  }

  describe("Basic batch formation", () => {
    it("should not flush until batch size is reached", () => {
      accumulator.add(createItem(1));
      accumulator.add(createItem(2));
      accumulator.add(createItem(3));

      expect(receivedBatches).toHaveLength(0);
      expect(accumulator.getPendingCount()).toBe(3);
    });

    it("should flush when batch size is reached", () => {
      for (let i = 1; i <= 5; i++) {
        accumulator.add(createItem(i));
      }

      expect(receivedBatches).toHaveLength(1);
      expect(receivedBatches[0].items).toHaveLength(5);
      expect(accumulator.getPendingCount()).toBe(0);
    });

    it("should create multiple batches for many items", () => {
      for (let i = 1; i <= 12; i++) {
        accumulator.add(createItem(i));
      }

      expect(receivedBatches).toHaveLength(2); // 5 + 5 = 10 items
      expect(receivedBatches[0].items).toHaveLength(5);
      expect(receivedBatches[1].items).toHaveLength(5);
      expect(accumulator.getPendingCount()).toBe(2); // 2 remaining
    });

    it("should assign unique batch IDs", () => {
      for (let i = 1; i <= 10; i++) {
        accumulator.add(createItem(i));
      }

      expect(receivedBatches).toHaveLength(2);
      expect(receivedBatches[0].id).not.toBe(receivedBatches[1].id);
      expect(receivedBatches[0].id).toContain("upsert-1-");
      expect(receivedBatches[1].id).toContain("upsert-2-");
    });

    it("should set correct batch type", () => {
      for (let i = 1; i <= 5; i++) {
        accumulator.add(createItem(i));
      }

      expect(receivedBatches[0].type).toBe("upsert");
    });

    it("should set createdAt timestamp", () => {
      const now = Date.now();
      vi.setSystemTime(now);

      for (let i = 1; i <= 5; i++) {
        accumulator.add(createItem(i));
      }

      expect(receivedBatches[0].createdAt).toBe(now);
    });
  });

  describe("Flush timeout", () => {
    it("should flush partial batch after timeout", () => {
      accumulator.add(createItem(1));
      accumulator.add(createItem(2));

      expect(receivedBatches).toHaveLength(0);

      vi.advanceTimersByTime(100);

      expect(receivedBatches).toHaveLength(1);
      expect(receivedBatches[0].items).toHaveLength(2);
    });

    it("should not flush if already flushed by size", () => {
      for (let i = 1; i <= 5; i++) {
        accumulator.add(createItem(i));
      }

      expect(receivedBatches).toHaveLength(1);

      vi.advanceTimersByTime(100);

      // Should not create additional empty batch
      expect(receivedBatches).toHaveLength(1);
    });

    it("should restart timer for new items after timeout", () => {
      accumulator.add(createItem(1));
      vi.advanceTimersByTime(100);

      expect(receivedBatches).toHaveLength(1);

      accumulator.add(createItem(2));
      vi.advanceTimersByTime(100);

      expect(receivedBatches).toHaveLength(2);
    });

    it("should not flush empty batch on timeout", () => {
      vi.advanceTimersByTime(100);
      expect(receivedBatches).toHaveLength(0);
    });
  });

  describe("Manual flush", () => {
    it("should flush pending items on manual flush", () => {
      accumulator.add(createItem(1));
      accumulator.add(createItem(2));

      accumulator.flush();

      expect(receivedBatches).toHaveLength(1);
      expect(receivedBatches[0].items).toHaveLength(2);
    });

    it("should cancel timeout timer on manual flush", () => {
      accumulator.add(createItem(1));
      accumulator.flush();

      vi.advanceTimersByTime(100);

      // Should not create duplicate batch
      expect(receivedBatches).toHaveLength(1);
    });

    it("should do nothing on flush with no pending items", () => {
      accumulator.flush();
      expect(receivedBatches).toHaveLength(0);
    });
  });

  describe("Drain", () => {
    it("should flush and clear all pending items", () => {
      accumulator.add(createItem(1));
      accumulator.add(createItem(2));

      accumulator.drain();

      expect(receivedBatches).toHaveLength(1);
      expect(accumulator.getPendingCount()).toBe(0);
    });

    it("should cancel timers on drain", () => {
      accumulator.add(createItem(1));
      accumulator.drain();

      vi.advanceTimersByTime(100);

      // Should not create duplicate batch
      expect(receivedBatches).toHaveLength(1);
    });
  });

  describe("Clear", () => {
    it("should discard all pending items without flushing", () => {
      accumulator.add(createItem(1));
      accumulator.add(createItem(2));

      accumulator.clear();

      expect(receivedBatches).toHaveLength(0);
      expect(accumulator.getPendingCount()).toBe(0);
    });

    it("should cancel timers on clear", () => {
      accumulator.add(createItem(1));
      accumulator.clear();

      vi.advanceTimersByTime(100);

      expect(receivedBatches).toHaveLength(0);
    });
  });

  describe("Backpressure", () => {
    it("should reject items when paused", () => {
      accumulator.pause();

      const result = accumulator.add(createItem(1));

      expect(result).toBe(false);
      expect(accumulator.getPendingCount()).toBe(0);
    });

    it("should accept items after resume", () => {
      accumulator.pause();
      accumulator.resume();

      const result = accumulator.add(createItem(1));

      expect(result).toBe(true);
      expect(accumulator.getPendingCount()).toBe(1);
    });

    it("should report paused state correctly", () => {
      expect(accumulator.isPausedState()).toBe(false);

      accumulator.pause();
      expect(accumulator.isPausedState()).toBe(true);

      accumulator.resume();
      expect(accumulator.isPausedState()).toBe(false);
    });

    it("should invoke backpressure callback on pause", () => {
      const callback = vi.fn();
      const accumulatorWithCallback = new BatchAccumulator(
        config,
        "upsert",
        () => {},
        callback,
      );

      accumulatorWithCallback.pause();

      expect(callback).toHaveBeenCalledWith(true);
    });

    it("should invoke backpressure callback on resume", () => {
      const callback = vi.fn();
      const accumulatorWithCallback = new BatchAccumulator(
        config,
        "upsert",
        () => {},
        callback,
      );

      accumulatorWithCallback.pause();
      accumulatorWithCallback.resume();

      expect(callback).toHaveBeenCalledWith(true);
      expect(callback).toHaveBeenCalledWith(false);
    });

    it("should not double-pause", () => {
      const callback = vi.fn();
      const accumulatorWithCallback = new BatchAccumulator(
        config,
        "upsert",
        () => {},
        callback,
      );

      accumulatorWithCallback.pause();
      accumulatorWithCallback.pause();

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("should not double-resume", () => {
      const callback = vi.fn();
      const accumulatorWithCallback = new BatchAccumulator(
        config,
        "upsert",
        () => {},
        callback,
      );

      accumulatorWithCallback.pause();
      accumulatorWithCallback.resume();
      accumulatorWithCallback.resume();

      expect(callback).toHaveBeenCalledTimes(2);
    });
  });

  describe("addMany", () => {
    it("should add multiple items at once", () => {
      const items = [createItem(1), createItem(2), createItem(3)];
      const accepted = accumulator.addMany(items);

      expect(accepted).toBe(3);
      expect(accumulator.getPendingCount()).toBe(3);
    });

    it("should flush when batch size reached during addMany", () => {
      const items = Array.from({ length: 7 }, (_, i) => createItem(i + 1));
      accumulator.addMany(items);

      expect(receivedBatches).toHaveLength(1);
      expect(receivedBatches[0].items).toHaveLength(5);
      expect(accumulator.getPendingCount()).toBe(2);
    });

    it("should stop accepting when backpressure is triggered", () => {
      accumulator.add(createItem(0));
      accumulator.pause();

      const items = [createItem(1), createItem(2), createItem(3)];
      const accepted = accumulator.addMany(items);

      expect(accepted).toBe(0);
    });
  });

  describe("Edge cases", () => {
    it("should handle batch size of 1", () => {
      const smallBatchConfig: BatchAccumulatorConfig = {
        batchSize: 1,
        flushTimeoutMs: 100,
        maxQueueSize: 10,
      };

      const smallBatchAccumulator = new BatchAccumulator<UpsertItem>(
        smallBatchConfig,
        "upsert",
        (batch) => {
          receivedBatches.push(batch);
        },
      );

      smallBatchAccumulator.add(createItem(1));
      smallBatchAccumulator.add(createItem(2));

      expect(receivedBatches).toHaveLength(2);
      expect(receivedBatches[0].items).toHaveLength(1);
      expect(receivedBatches[1].items).toHaveLength(1);
    });

    it("should handle very long flush timeout", () => {
      const longTimeoutConfig: BatchAccumulatorConfig = {
        batchSize: 5,
        flushTimeoutMs: 60000,
        maxQueueSize: 10,
      };

      const longTimeoutAccumulator = new BatchAccumulator<UpsertItem>(
        longTimeoutConfig,
        "upsert",
        (batch) => {
          receivedBatches.push(batch);
        },
      );

      longTimeoutAccumulator.add(createItem(1));

      vi.advanceTimersByTime(30000);
      expect(receivedBatches).toHaveLength(0);

      vi.advanceTimersByTime(30000);
      expect(receivedBatches).toHaveLength(1);
    });
  });
});
