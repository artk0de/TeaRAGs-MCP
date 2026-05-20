/**
 * performDeletion — 3-level fallback cascade returning DeletionOutcome.
 *
 * L0 (batched) and L1 (bulk) are atomic: on success they mark ALL paths
 * as succeeded; on failure they throw upstream to next level. Only L2
 * (per-file filter deletion) can produce a partial outcome — each file
 * that throws inside its catch branch is marked via outcome.markFailed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { performDeletion } from "../../../../../../src/core/domains/ingest/sync/deletion/strategy.js";

describe("performDeletion", () => {
  let qdrant: MockQdrantManager;
  const collectionName = "code_test";
  const deleteConfig = { batchSize: 500, concurrency: 8 };

  beforeEach(async () => {
    qdrant = new MockQdrantManager();
    await qdrant.createCollection(collectionName, 384, "Cosine");

    // Seed 3 points — one per file we'll attempt to delete
    await qdrant.addPoints(collectionName, [
      { id: "1", vector: new Array(384).fill(0.1), payload: { relativePath: "a.ts" } },
      { id: "2", vector: new Array(384).fill(0.1), payload: { relativePath: "b.ts" } },
      { id: "3", vector: new Array(384).fill(0.1), payload: { relativePath: "c.ts" } },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("return type contract", () => {
    it("returns a DeletionOutcome (not a bare number)", async () => {
      const outcome = await performDeletion(qdrant as any, collectionName, ["a.ts"], deleteConfig);

      expect(outcome).toBeDefined();
      expect(outcome.succeeded).toBeInstanceOf(Set);
      expect(outcome.failed).toBeInstanceOf(Set);
      expect(typeof outcome.chunksDeleted).toBe("number");
      expect(typeof outcome.isFullSuccess).toBe("function");
    });
  });

  describe("empty input", () => {
    it("short-circuits to an empty outcome", async () => {
      const outcome = await performDeletion(qdrant as any, collectionName, [], deleteConfig);

      expect(outcome.succeeded.size).toBe(0);
      expect(outcome.failed.size).toBe(0);
      expect(outcome.chunksDeleted).toBe(0);
      expect(outcome.isFullSuccess()).toBe(true);
    });
  });

  // Slice 2 / A4d — provider-notification hook fires BEFORE Qdrant
  // deletion so codegraph (and future trajectories) prune their own
  // state first. Orphan graph edges are silent corruption; orphan
  // Qdrant points are merely clutter — order is deliberate.
  describe("preDeleteHook (A4d wiring)", () => {
    it("invokes the hook with the same paths before the Qdrant delete runs", async () => {
      const callOrder: string[] = [];
      const deleteSpy = vi.spyOn(qdrant, "deletePointsByPathsBatched");
      deleteSpy.mockImplementation((async (...args: any[]) => {
        callOrder.push("qdrant.deletePointsByPathsBatched");
        // Delegate to the original mock behaviour so the rest of
        // performDeletion finds a happy L0 path.
        const orig = MockQdrantManager.prototype.deletePointsByPathsBatched;
        return orig.apply(qdrant, args as Parameters<typeof orig>);
      }) as any);
      const hook = vi.fn(async (paths: string[]) => {
        callOrder.push(`hook(${paths.join(",")})`);
      });

      await performDeletion(qdrant as any, collectionName, ["a.ts", "b.ts"], deleteConfig, undefined, hook);
      expect(hook).toHaveBeenCalledExactlyOnceWith(["a.ts", "b.ts"]);
      expect(callOrder).toEqual(["hook(a.ts,b.ts)", "qdrant.deletePointsByPathsBatched"]);
    });

    it("skips the hook entirely on empty input (short-circuit fast path)", async () => {
      const hook = vi.fn(async () => {
        /* should not run */
      });
      const outcome = await performDeletion(qdrant as any, collectionName, [], deleteConfig, undefined, hook);
      expect(hook).not.toHaveBeenCalled();
      expect(outcome.succeeded.size).toBe(0);
    });

    it("hook failure aborts the operation before Qdrant is touched", async () => {
      // If a provider hook crashes catastrophically (programmer error,
      // not a normal provider failure — those are caught inside
      // coordinator.notifyDeletions), the Qdrant delete must NOT run.
      // Otherwise the ordering invariant is silently violated.
      const deleteSpy = vi.spyOn(qdrant, "deletePointsByPathsBatched");
      const hook = vi.fn(async () => {
        throw new Error("coordinator wiring crashed");
      });
      await expect(
        performDeletion(qdrant as any, collectionName, ["a.ts"], deleteConfig, undefined, hook),
      ).rejects.toThrow("coordinator wiring crashed");
      expect(deleteSpy).not.toHaveBeenCalled();
    });
  });

  describe("L0 batched success (happy path)", () => {
    it("marks every attempted path as succeeded and reports chunksDeleted", async () => {
      const outcome = await performDeletion(qdrant as any, collectionName, ["a.ts", "b.ts", "c.ts"], deleteConfig);

      expect(outcome.isFullSuccess()).toBe(true);
      expect(outcome.failed.size).toBe(0);
      expect(outcome.succeeded.size).toBe(3);
      expect(outcome.succeeded.has("a.ts")).toBe(true);
      expect(outcome.succeeded.has("b.ts")).toBe(true);
      expect(outcome.succeeded.has("c.ts")).toBe(true);
      expect(outcome.chunksDeleted).toBe(3);
    });
  });

  describe("L1 bulk fallback success", () => {
    it("is full success when L0 throws but L1 recovers atomically", async () => {
      vi.spyOn(qdrant, "deletePointsByPathsBatched").mockRejectedValueOnce(new Error("L0 timeout"));

      const outcome = await performDeletion(qdrant as any, collectionName, ["a.ts", "b.ts", "c.ts"], deleteConfig);

      expect(outcome.isFullSuccess()).toBe(true);
      expect(outcome.failed.size).toBe(0);
      expect(outcome.succeeded.size).toBe(3);
      expect(outcome.chunksDeleted).toBe(3);
    });
  });

  describe("L2 per-file partial failure", () => {
    it("marks only the files whose deletePointsByFilter throws", async () => {
      vi.spyOn(qdrant, "deletePointsByPathsBatched").mockRejectedValueOnce(new Error("L0 timeout"));
      vi.spyOn(qdrant, "deletePointsByPaths").mockRejectedValueOnce(new Error("L1 timeout"));

      const filterSpy = vi.spyOn(qdrant, "deletePointsByFilter").mockImplementation(async (_col, filter: any) => {
        const path = filter?.must?.[0]?.match?.value;
        if (path === "b.ts") {
          throw new Error("yellow state");
        }
        // Succeed for a.ts and c.ts via real behavior
        const resolved = "code_test";
        const pts = (qdrant as any).points.get(resolved) || [];
        (qdrant as any).points.set(
          resolved,
          pts.filter((p: any) => p.payload?.relativePath !== path),
        );
      });

      const outcome = await performDeletion(qdrant as any, collectionName, ["a.ts", "b.ts", "c.ts"], deleteConfig);

      expect(filterSpy).toHaveBeenCalledTimes(3);
      expect(outcome.isFullSuccess()).toBe(false);
      expect(outcome.succeeded.size).toBe(2);
      expect(outcome.succeeded.has("a.ts")).toBe(true);
      expect(outcome.succeeded.has("c.ts")).toBe(true);
      expect(outcome.failed.size).toBe(1);
      expect(outcome.failed.has("b.ts")).toBe(true);
    });
  });

  describe("L2 total failure", () => {
    it("marks every path as failed when every per-file delete throws", async () => {
      vi.spyOn(qdrant, "deletePointsByPathsBatched").mockRejectedValueOnce(new Error("L0 timeout"));
      vi.spyOn(qdrant, "deletePointsByPaths").mockRejectedValueOnce(new Error("L1 timeout"));
      vi.spyOn(qdrant, "deletePointsByFilter").mockRejectedValue(new Error("per-file always fails"));

      const outcome = await performDeletion(qdrant as any, collectionName, ["a.ts", "b.ts", "c.ts"], deleteConfig);

      expect(outcome.isFullSuccess()).toBe(false);
      expect(outcome.succeeded.size).toBe(0);
      expect(outcome.failed.size).toBe(3);
      expect(outcome.failed.has("a.ts")).toBe(true);
      expect(outcome.failed.has("b.ts")).toBe(true);
      expect(outcome.failed.has("c.ts")).toBe(true);
    });
  });

  describe("chunksDeleted computation", () => {
    it("equals Math.max(0, totalBefore - totalAfter)", async () => {
      const outcome = await performDeletion(qdrant as any, collectionName, ["a.ts", "b.ts"], deleteConfig);

      expect(outcome.chunksDeleted).toBe(2);
    });

    it("never goes negative if totalAfter exceeds totalBefore (robustness)", async () => {
      // No points match the requested paths — totalBefore and totalAfter both equal 3
      const outcome = await performDeletion(qdrant as any, collectionName, ["nonexistent.ts"], deleteConfig);

      expect(outcome.chunksDeleted).toBe(0);
      expect(outcome.isFullSuccess()).toBe(true);
    });
  });
});
