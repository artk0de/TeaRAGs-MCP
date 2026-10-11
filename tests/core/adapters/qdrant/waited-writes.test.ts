/**
 * Waited writes outside the enrichment marker store read Qdrant's
 * `wait_timeout` answer instead of counting it as success (bd tea-rags-mcp-wjyaf,
 * follow-up of yf4je): payload-index creation, the relativePathExact backfill,
 * and the status the payload mutations report to their callers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";
import { backfillRelativePathExact } from "../../../../src/core/adapters/qdrant/relative-path-exact-backfill.js";
import { RelativePathExactCapability } from "../../../../src/core/adapters/qdrant/relative-path-exact-capability.js";
import { RELATIVE_PATH_EXACT_SCHEMA_VERSION } from "../../../../src/core/contracts/relative-path-exact.js";

const mockClient = {
  createPayloadIndex: vi.fn(),
  batchUpdate: vi.fn(),
  setPayload: vi.fn(),
};

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: vi.fn().mockImplementation(function () {
    return mockClient;
  }),
}));

function manager(writeBarrierBudgetMs = 600_000): QdrantManager {
  return new QdrantManager("http://localhost:6333", undefined, undefined, undefined, { writeBarrierBudgetMs });
}

describe("payload index creation under wait_timeout", () => {
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockClient.createPayloadIndex.mockReset();
    mockClient.batchUpdate.mockReset();
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errors.mockRestore();
  });

  it("completed: no barrier round is spent", async () => {
    mockClient.createPayloadIndex.mockResolvedValue({ status: "completed" });

    await manager().createPayloadIndex("c", "language", "keyword");

    expect(mockClient.batchUpdate).not.toHaveBeenCalled();
  });

  it("wait_timeout once, then the barrier drains: the index is confirmed and nothing is logged", async () => {
    mockClient.createPayloadIndex.mockResolvedValue({ status: "wait_timeout" });
    mockClient.batchUpdate.mockResolvedValue([{ status: "completed" }]);

    await expect(manager().createPayloadIndex("c", "language", "keyword")).resolves.toBeUndefined();

    expect(mockClient.batchUpdate).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("always wait_timeout: logs that the index may still be building and does NOT fail", async () => {
    mockClient.createPayloadIndex.mockResolvedValue({ status: "wait_timeout" });
    mockClient.batchUpdate.mockResolvedValue([{ status: "wait_timeout" }]);

    await expect(manager(0).createPayloadIndex("c", "language", "keyword")).resolves.toBeUndefined();

    expect(errors).toHaveBeenCalledWith(expect.stringContaining("PAYLOAD_INDEX_UNCONFIRMED"));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("language"));
  });

  it("ensurePayloadIndex keeps reporting created when the index may still be building", async () => {
    mockClient.createPayloadIndex.mockResolvedValue({ status: "wait_timeout" });
    mockClient.batchUpdate.mockResolvedValue([{ status: "wait_timeout" }]);
    const qdrant = manager(0);
    vi.spyOn(qdrant, "hasPayloadIndex").mockResolvedValue(false);

    await expect(qdrant.ensurePayloadIndex("c", "language", "keyword")).resolves.toBe(true);
  });
});

describe("payload mutations report Qdrant's update status", () => {
  beforeEach(() => {
    mockClient.setPayload.mockReset();
    mockClient.batchUpdate.mockReset();
  });

  it("setPayload returns wait_timeout for a waited write whose wait ran out", async () => {
    mockClient.setPayload.mockResolvedValue({ status: "wait_timeout" });

    await expect(manager().setPayload("c", { a: 1 }, { points: ["x"], wait: true })).resolves.toBe("wait_timeout");
  });

  it("setPayload returns completed when the answer carries no status", async () => {
    mockClient.setPayload.mockResolvedValue({});

    await expect(manager().setPayload("c", { a: 1 }, { points: ["x"], wait: true })).resolves.toBe("completed");
  });
});

describe("relativePathExact backfill under wait_timeout", () => {
  function storeWriting(...statuses: string[]) {
    const queue = [...statuses];
    return {
      scrollPayloadPages: () =>
        (async function* () {
          yield [{ id: "p1", payload: { relativePath: "a.ts" } }];
          yield [{ id: "p2", payload: { relativePath: "b.ts" } }];
        })(),
      batchSetPayload: vi.fn(async () => queue.shift() ?? "completed"),
    };
  }

  it("completed writes: every point counted, nothing unconfirmed", async () => {
    const store = storeWriting("completed", "completed");

    await expect(backfillRelativePathExact(store, "c")).resolves.toEqual({ backfilled: 2, unconfirmedWrites: 0 });
  });

  it("wait_timeout once, then the barrier drains: the write is confirmed", async () => {
    const confirmQueuedWrites = vi.fn(async () => ({ kind: "drained", rounds: 2, waitedMs: 5 }) as const);
    const store = { ...storeWriting("wait_timeout", "completed"), confirmQueuedWrites };

    await expect(backfillRelativePathExact(store, "c")).resolves.toEqual({ backfilled: 2, unconfirmedWrites: 0 });
    expect(confirmQueuedWrites).toHaveBeenCalledTimes(1);
  });

  it("always wait_timeout: reports every unconfirmed write in the outcome", async () => {
    const confirmQueuedWrites = vi.fn(async () => ({ kind: "timedOut", rounds: 3, waitedMs: 9 }) as const);
    const store = { ...storeWriting("wait_timeout", "wait_timeout"), confirmQueuedWrites };

    await expect(backfillRelativePathExact(store, "c")).resolves.toEqual({ backfilled: 2, unconfirmedWrites: 2 });
  });

  it("a store without a barrier cannot confirm a timed-out write", async () => {
    const store = storeWriting("wait_timeout", "completed");

    await expect(backfillRelativePathExact(store, "c")).resolves.toEqual({ backfilled: 2, unconfirmedWrites: 1 });
  });

  it("the gate does not serve a collection whose heal is unconfirmed, and serves it once confirmed", async () => {
    const heal = (confirmKind: "drained" | "timedOut") => {
      const store = {
        ...storeWriting("wait_timeout", "completed"),
        countPoints: vi.fn(async (_c: string, _filter?: Record<string, unknown>) => 0),
        confirmQueuedWrites: vi.fn(async () =>
          confirmKind === "drained"
            ? ({ kind: "drained", rounds: 1, waitedMs: 1 } as const)
            : ({ kind: "timedOut", rounds: 1, waitedMs: 1 } as const),
        ),
      };
      // two paths carry a path but lack the twin: with-path 2, with-both 0
      store.countPoints.mockImplementation(async (_c: string, filter?: Record<string, unknown>) =>
        JSON.stringify(filter).includes("relativePathExact") ? 0 : 2,
      );
      return new RelativePathExactCapability({
        resolvePhysical: async (n) => n,
        readSchemaVersion: async () => RELATIVE_PATH_EXACT_SCHEMA_VERSION,
        backfillStore: store,
        keywordIndex: {
          listPayloadIndexes: async () => [{ field: "relativePathExact", points: 2 }],
          recreateKeywordIndex: async () => {},
        },
      });
    };

    await expect(heal("timedOut").isServed("c")).resolves.toBe(false);
    await expect(heal("drained").isServed("c")).resolves.toBe(true);
  });
});
