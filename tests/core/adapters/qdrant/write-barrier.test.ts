import { describe, expect, it, vi } from "vitest";

import type { QdrantUpdateStatus } from "../../../../src/core/adapters/qdrant/types.js";
import { awaitWriteBarrier, type WriteBarrierLog } from "../../../../src/core/adapters/qdrant/write-barrier.js";

function clientAnswering(...answers: (QdrantUpdateStatus | Error)[]) {
  const queue = [...answers];
  return {
    awaitQueuedUpdates: vi.fn(async (_collection: string) => {
      const next = queue.shift() ?? "completed";
      if (next instanceof Error) throw next;
      return next;
    }),
  };
}

function ticking(stepMs: number): () => number {
  let t = 0;
  return () => {
    const now = t;
    t += stepMs;
    return now;
  };
}

function log() {
  return { timedOutRound: vi.fn<WriteBarrierLog["timedOutRound"]>(), failed: vi.fn<WriteBarrierLog["failed"]>() };
}

describe("awaitWriteBarrier", () => {
  it("drains in one round when Qdrant answers completed", async () => {
    const client = clientAnswering("completed");
    const outcome = await awaitWriteBarrier(client, "c", { budgetMs: 1000, now: ticking(10), log: log() });

    expect(outcome).toMatchObject({ kind: "drained", rounds: 1 });
    expect(client.awaitQueuedUpdates).toHaveBeenCalledTimes(1);
  });

  it("repeats a wait_timeout round and drains on the next completed answer", async () => {
    const client = clientAnswering("wait_timeout", "completed");
    const sink = log();
    const outcome = await awaitWriteBarrier(client, "c", { budgetMs: 1000, now: ticking(10), log: sink });

    expect(outcome).toMatchObject({ kind: "drained", rounds: 2 });
    expect(sink.timedOutRound).toHaveBeenCalledTimes(1);
  });

  it("reports timedOut once the budget is spent on wait_timeout rounds", async () => {
    const client = clientAnswering("wait_timeout", "wait_timeout", "wait_timeout", "wait_timeout");
    const sink = log();
    const outcome = await awaitWriteBarrier(client, "c", { budgetMs: 50, now: ticking(30), log: sink });

    expect(outcome.kind).toBe("timedOut");
    expect(client.awaitQueuedUpdates.mock.calls.length).toBeLessThan(4);
    expect(sink.timedOutRound).toHaveBeenCalled();
  });

  it("reports failed when the barrier request throws", async () => {
    const client = clientAnswering(new Error("boom"));
    const sink = log();
    const outcome = await awaitWriteBarrier(client, "c", { budgetMs: 1000, now: ticking(10), log: sink });

    expect(outcome).toEqual({ kind: "failed" });
    expect(sink.failed).toHaveBeenCalledWith(expect.objectContaining({ collection: "c", error: "boom" }));
  });
});
