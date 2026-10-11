/**
 * `QdrantManager` write-barrier wiring and strict point read (bd
 * tea-rags-mcp-wjyaf, tea-rags-mcp-yf4je): the relativePathExact heal confirms a
 * `wait_timeout` write through the manager's barrier, the barrier reports its
 * rounds on the adapter log channel, and `getPointOrThrow` tells "absent" from
 * "unreadable".
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";
import { QdrantOperationError } from "../../../../src/core/adapters/qdrant/errors.js";

type BatchRequest = { operations: Record<string, unknown>[]; wait?: boolean };

function isBarrierRequest(request: BatchRequest): boolean {
  return "delete_payload" in request.operations[0];
}

/** A v20 collection where two path-carrying points lack the twin until a write lands. */
function managerHealingTwoPoints(onBatchUpdate: (request: BatchRequest) => Promise<unknown>) {
  const manager = new QdrantManager("http://127.0.0.1:6333");
  let healed = false;
  const batchUpdate = vi.fn(async (_collection: string, request: BatchRequest) => {
    if (!isBarrierRequest(request)) healed = true;
    return onBatchUpdate(request);
  });
  const client = {
    getAliases: vi.fn(async () => ({ aliases: [{ alias_name: "code_x", collection_name: "code_x_v3" }] })),
    retrieve: vi.fn(async () => [{ id: "m", payload: { _type: "schema_metadata", schemaVersion: 20 } }]),
    count: vi.fn(async (_c: string, req: { filter: { must_not: unknown[] } }) => ({
      count: req.filter.must_not.length === 1 || healed ? 7 : 5,
    })),
    scroll: vi.fn(async () => ({
      points: [
        { id: 1, payload: { relativePath: "a.ts" } },
        { id: 2, payload: { relativePath: "b.ts" } },
      ],
      next_page_offset: null,
    })),
    getCollection: vi.fn(async () => ({
      payload_schema: {
        relativePath: { data_type: "text", points: 7 },
        relativePathExact: { data_type: "keyword", points: 7 },
      },
    })),
    createPayloadIndex: vi.fn(async () => ({})),
    batchUpdate,
  };
  (manager as unknown as { client: unknown }).client = client;
  return { manager, client, batchUpdate };
}

describe("QdrantManager write barrier", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("confirms a wait_timeout heal write through the barrier and serves once the queue drains", async () => {
    const { manager, batchUpdate } = managerHealingTwoPoints(async (request) =>
      isBarrierRequest(request) ? [{ status: "completed" }] : [{ status: "wait_timeout" }],
    );

    expect(await manager.servesRelativePathExact("code_x")).toBe(true);

    const barrierCalls = batchUpdate.mock.calls.filter(([, request]) => isBarrierRequest(request));
    expect(barrierCalls).toHaveLength(1);
    expect(barrierCalls[0][0]).toBe("code_x_v3");
    expect(barrierCalls[0][1].wait).toBe(true);
  });

  it("logs PAYLOAD_WRITE_BARRIER_FAILED and does not serve when the barrier request throws", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { manager } = managerHealingTwoPoints(async (request) => {
      if (isBarrierRequest(request)) throw new Error("barrier boom");
      return [{ status: "wait_timeout" }];
    });

    expect(await manager.servesRelativePathExact("code_x")).toBe(false);

    const logged = errorLog.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes("PAYLOAD_WRITE_BARRIER_FAILED") && line.includes("code_x_v3"))).toBe(
      true,
    );
  });

  it("logs each timed-out barrier round and reports timedOut once the budget is spent", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const manager = new QdrantManager("http://127.0.0.1:6333", undefined, undefined, undefined, {
      writeBarrierBudgetMs: 0,
    });
    (manager as unknown as { client: unknown }).client = {
      batchUpdate: vi.fn(async () => [{ status: "wait_timeout" }]),
    };

    const outcome = await manager.awaitWriteBarrier("code_x_v3");

    expect(outcome.kind).toBe("timedOut");
    const logged = errorLog.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes("PAYLOAD_WRITE_BARRIER_TIMED_OUT"))).toBe(true);
  });
});

describe("QdrantManager#getPointOrThrow", () => {
  function managerWithRetrieve(retrieve: () => Promise<unknown>) {
    const manager = new QdrantManager("http://127.0.0.1:6333");
    (manager as unknown as { client: unknown }).client = { retrieve: vi.fn(retrieve) };
    return manager;
  }

  it("answers the stored point, and null only when Qdrant answered that it is absent", async () => {
    const present = managerWithRetrieve(async () => [{ id: 1, payload: { a: 1 } }]);
    expect(await present.getPointOrThrow("c", 1)).toEqual({ id: 1, payload: { a: 1 } });

    const absent = managerWithRetrieve(async () => []);
    expect(await absent.getPointOrThrow("c", 1)).toBeNull();
  });

  it("throws an operation error on a failed read where getPoint would answer null", async () => {
    const manager = managerWithRetrieve(async () => {
      throw new Error("HTTP 500");
    });

    await expect(manager.getPointOrThrow("c", 1)).rejects.toBeInstanceOf(QdrantOperationError);
    expect(await manager.getPoint("c", 1)).toBeNull();
  });
});
