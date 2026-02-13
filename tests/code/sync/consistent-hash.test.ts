/**
 * Tests for ConsistentHash - consistent hashing ring for shard distribution
 */

import { describe, expect, it } from "vitest";

import { ConsistentHash } from "../../../src/code/sync/consistent-hash.js";

describe("ConsistentHash", () => {
  describe("constructor", () => {
    it("should create a hash ring with specified shard count", () => {
      const ring = new ConsistentHash(4);
      expect(ring.getShardCount()).toBe(4);
    });

    it("should throw for invalid shard count", () => {
      expect(() => new ConsistentHash(0)).toThrow();
      expect(() => new ConsistentHash(-1)).toThrow();
    });
  });

  describe("getShard", () => {
    it("should return consistent results for same input", () => {
      const ring = new ConsistentHash(4);
      const path = "src/components/Button.tsx";

      const shard1 = ring.getShard(path);
      const shard2 = ring.getShard(path);

      expect(shard1).toBe(shard2);
    });

    it("should return shard index within valid range", () => {
      const ring = new ConsistentHash(4);
      const paths = ["src/index.ts", "lib/utils.ts", "tests/app.test.ts", "README.md"];

      for (const path of paths) {
        const shard = ring.getShard(path);
        expect(shard).toBeGreaterThanOrEqual(0);
        expect(shard).toBeLessThan(4);
      }
    });

    it("should distribute files evenly across shards", () => {
      const ring = new ConsistentHash(4);
      const distribution = new Map<number, number>();

      // 1000 random paths
      for (let i = 0; i < 1000; i++) {
        const shard = ring.getShard(`src/file-${i}.ts`);
        distribution.set(shard, (distribution.get(shard) || 0) + 1);
      }

      // Each shard should get 15-35% (ideal is 25%, allowing ±10%)
      for (const count of distribution.values()) {
        expect(count).toBeGreaterThan(150);
        expect(count).toBeLessThan(350);
      }
    });
  });

  describe("redistribution on shard count change", () => {
    it("should minimize redistribution when shard count increases", () => {
      const ring4 = new ConsistentHash(4);
      const ring8 = new ConsistentHash(8);

      const files = Array.from({ length: 1000 }, (_, i) => `src/file-${i}.ts`);
      let stayedCount = 0;

      for (const file of files) {
        const shard4 = ring4.getShard(file);
        const shard8 = ring8.getShard(file);

        // File "stays" if it maps to equivalent shard (0->0, 1->1, etc.)
        // or to the new shard that covers same ring segment
        // In consistent hashing, ~50% should stay when doubling shards
        if (shard4 === shard8 || shard4 === shard8 % 4) {
          stayedCount++;
        }
      }

      // At least 40% should stay (consistent hashing guarantee)
      // With simple modulo, only ~25% would stay
      expect(stayedCount).toBeGreaterThan(400);
    });

    it("should minimize redistribution when shard count decreases", () => {
      const ring8 = new ConsistentHash(8);
      const ring4 = new ConsistentHash(4);

      const files = Array.from({ length: 1000 }, (_, i) => `src/file-${i}.ts`);
      let stayedCount = 0;

      for (const file of files) {
        const shard8 = ring8.getShard(file);
        const shard4 = ring4.getShard(file);

        // Check if file maps to equivalent position
        if (shard8 % 4 === shard4) {
          stayedCount++;
        }
      }

      // With consistent hashing, distribution should be reasonable
      expect(stayedCount).toBeGreaterThan(200);
    });
  });

  describe("virtual nodes", () => {
    it("should use configurable virtual nodes per shard", () => {
      const ringDefault = new ConsistentHash(4);
      const ringCustom = new ConsistentHash(4, { virtualNodesPerShard: 50 });

      // Both should work, but custom has fewer virtual nodes
      expect(ringDefault.getShard("test.ts")).toBeGreaterThanOrEqual(0);
      expect(ringCustom.getShard("test.ts")).toBeGreaterThanOrEqual(0);
    });
  });

  describe("edge cases", () => {
    it("should handle empty string path", () => {
      const ring = new ConsistentHash(4);
      const shard = ring.getShard("");

      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(4);
    });

    it("should handle unicode paths", () => {
      const ring = new ConsistentHash(4);
      const shard = ring.getShard("src/компоненты/Кнопка.tsx");

      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(4);
    });

    it("should handle very long paths", () => {
      const ring = new ConsistentHash(4);
      const longPath = `${"a/".repeat(1000)}file.ts`;
      const shard = ring.getShard(longPath);

      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(4);
    });

    it("should handle single shard", () => {
      const ring = new ConsistentHash(1);

      expect(ring.getShard("any-file.ts")).toBe(0);
      expect(ring.getShard("another-file.ts")).toBe(0);
    });
  });
});
