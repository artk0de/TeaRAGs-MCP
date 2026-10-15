import { describe, expect, it } from "vitest";

import { EmbeddingEndpointSlotLimiter } from "../../../../src/core/adapters/embeddings/endpoint-slot-limiter.js";

const A = "http://gpu:8081";
const B = "http://gpu:8082";

/** Let every settled promise run its continuations. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("EmbeddingEndpointSlotLimiter", () => {
  it("grants at most `capacity` leases per endpoint across concurrent acquirers", async () => {
    const limiter = new EmbeddingEndpointSlotLimiter();
    const granted: number[] = [];
    const leases = Array.from({ length: 5 }, async (_, i) => {
      const release = await limiter.acquire(A, 2);
      granted.push(i);
      return release;
    });
    await flush();

    expect(granted).toEqual([0, 1]);
    expect(limiter.inFlight(A)).toBe(2);
    expect(limiter.waiting(A)).toBe(3);

    // Another endpoint has its own slots.
    const other = await limiter.acquire(B, 1);
    expect(other).toBeDefined();
    expect(limiter.inFlight(B)).toBe(1);

    const first = await leases[0];
    first?.();
    await flush();
    expect(granted).toEqual([0, 1, 2]);
    expect(limiter.inFlight(A)).toBe(2);
  });

  it("hands freed slots to waiters in FIFO order", async () => {
    const limiter = new EmbeddingEndpointSlotLimiter();
    const holder = await limiter.acquire(A, 1);
    const order: string[] = [];
    const waiters = ["first", "second", "third"].map(async (name) => {
      const release = await limiter.acquire(A, 1);
      order.push(name);
      return release;
    });
    await flush();
    expect(order).toEqual([]);

    holder?.();
    await flush();
    (await waiters[0])?.();
    await flush();
    (await waiters[1])?.();
    await flush();

    expect(order).toEqual(["first", "second", "third"]);
  });

  it("frees exactly one slot per lease, however often the release is called", async () => {
    const limiter = new EmbeddingEndpointSlotLimiter();
    const lease = await limiter.acquire(A, 1);
    const granted: string[] = [];
    void limiter.acquire(A, 1).then(() => granted.push("w1"));
    void limiter.acquire(A, 1).then(() => granted.push("w2"));
    await flush();

    lease?.();
    lease?.();
    lease?.();
    await flush();

    expect(granted).toEqual(["w1"]);
    expect(limiter.inFlight(A)).toBe(1);
    expect(limiter.waiting(A)).toBe(1);
  });

  it("honours a raised capacity at once and a lowered one as leases return", async () => {
    const limiter = new EmbeddingEndpointSlotLimiter();
    const held = [await limiter.acquire(A, 1)];
    const granted: string[] = [];
    void limiter.acquire(A, 1).then((r) => {
      granted.push("w1");
      held.push(r);
    });
    await flush();
    expect(granted).toEqual([]);

    // /props re-read: the endpoint now reports 3 slots.
    void limiter.acquire(A, 3).then((r) => {
      granted.push("w2");
      held.push(r);
    });
    await flush();
    expect(granted).toEqual(["w1", "w2"]);
    expect(limiter.inFlight(A)).toBe(3);

    // Back to 1 slot: nothing new is granted until in-flight drops below 1.
    void limiter.acquire(A, 1).then(() => granted.push("w3"));
    await flush();
    held[0]?.();
    held[1]?.();
    await flush();
    expect(granted).toEqual(["w1", "w2"]);
    held[2]?.();
    await flush();
    expect(granted).toEqual(["w1", "w2", "w3"]);
  });

  it("treats a capacity below one as a single slot", async () => {
    const limiter = new EmbeddingEndpointSlotLimiter();
    await limiter.acquire(A, 0);
    let second = false;
    void limiter.acquire(A, 0).then(() => (second = true));
    await flush();
    expect(second).toBe(false);
  });

  it("resolves an aborted acquisition with no lease and drops it from the queue", async () => {
    const limiter = new EmbeddingEndpointSlotLimiter();
    const holder = await limiter.acquire(A, 1);
    const controller = new AbortController();
    const cancelled = limiter.acquire(A, 1, controller.signal);
    const granted: string[] = [];
    void limiter.acquire(A, 1).then(() => granted.push("next"));
    await flush();

    controller.abort();
    expect(await cancelled).toBeUndefined();
    expect(limiter.waiting(A)).toBe(1);

    holder?.();
    await flush();
    expect(granted).toEqual(["next"]);
    expect(await limiter.acquire(B, 1, controller.signal)).toBeUndefined();
  });
});
