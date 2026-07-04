/**
 * awaitQdrantReadiness — bounded wait for the embedded Qdrant daemon
 * (tea-rags-mcp-2nfdm).
 *
 * After a daemon restart, shard recovery of large collections blocks the HTTP
 * bind for tens of seconds to minutes; every indexing run during it used to
 * die instantly on INFRA_QDRANT_RECOVERING. Indexing must WAIT (bounded)
 * instead of fail-fast, surfacing the state to the renderer while it waits.
 * Matching is structural (error `code` property) — the not-ready family is
 * INFRA_QDRANT_STARTING / INFRA_QDRANT_RECOVERING; anything else rethrows
 * immediately (a genuinely-unreachable external Qdrant must keep failing
 * loud, and MCP-side fail-fast semantics are untouched).
 */

import { describe, expect, it, vi } from "vitest";

import { awaitQdrantReadiness } from "../../../src/cli/index-progress/qdrant-readiness.js";

class FakeTypedError extends Error {
  constructor(public readonly code: string) {
    super(`fake ${code}`);
  }
}

const instantSleep = async (): Promise<void> => {};

describe("awaitQdrantReadiness", () => {
  it("returns the attempt result immediately when the first attempt succeeds (no waiting, no callbacks)", async () => {
    const onWait = vi.fn();
    const result = await awaitQdrantReadiness(async () => "ok", { onWait, sleep: instantSleep });
    expect(result).toBe("ok");
    expect(onWait).not.toHaveBeenCalled();
  });

  it("retries through recovering until the daemon is ready, reporting each wait", async () => {
    const attempts = [
      async () => Promise.reject(new FakeTypedError("INFRA_QDRANT_RECOVERING")),
      async () => Promise.reject(new FakeTypedError("INFRA_QDRANT_RECOVERING")),
      async () => Promise.resolve(42),
    ];
    let i = 0;
    const onWait = vi.fn();
    const result = await awaitQdrantReadiness(async () => attempts[i++](), { onWait, sleep: instantSleep });
    expect(result).toBe(42);
    expect(onWait).toHaveBeenCalledTimes(2);
    expect(onWait.mock.calls[0][0]).toBe("recovering");
  });

  it("classifies INFRA_QDRANT_STARTING as the 'starting' state", async () => {
    let first = true;
    const onWait = vi.fn();
    await awaitQdrantReadiness(
      async () => {
        if (first) {
          first = false;
          return Promise.reject(new FakeTypedError("INFRA_QDRANT_STARTING"));
        }
        return Promise.resolve("up");
      },
      { onWait, sleep: instantSleep },
    );
    expect(onWait).toHaveBeenCalledWith("starting", expect.any(Number));
  });

  it("rethrows a non-readiness error immediately (external Qdrant down stays fail-fast)", async () => {
    const onWait = vi.fn();
    await expect(
      awaitQdrantReadiness(async () => Promise.reject(new FakeTypedError("INFRA_QDRANT_UNAVAILABLE")), {
        onWait,
        sleep: instantSleep,
      }),
    ).rejects.toThrow("INFRA_QDRANT_UNAVAILABLE");
    expect(onWait).not.toHaveBeenCalled();
  });

  it("rethrows the readiness error once the bounded window is exhausted", async () => {
    let clock = 0;
    const now = () => clock;
    const sleep = async (): Promise<void> => {
      clock += 5_000;
    };
    await expect(
      awaitQdrantReadiness(async () => Promise.reject(new FakeTypedError("INFRA_QDRANT_RECOVERING")), {
        timeoutMs: 20_000,
        now,
        sleep,
      }),
    ).rejects.toThrow("INFRA_QDRANT_RECOVERING");
  });

  it("reports monotonically growing elapsed time to onWait", async () => {
    let clock = 0;
    const now = () => clock;
    const sleep = async (): Promise<void> => {
      clock += 3_000;
    };
    const elapsed: number[] = [];
    let calls = 0;
    await awaitQdrantReadiness(
      async () =>
        calls++ < 3 ? Promise.reject(new FakeTypedError("INFRA_QDRANT_RECOVERING")) : Promise.resolve("done"),
      { onWait: (_state, ms) => elapsed.push(ms), now, sleep },
    );
    expect(elapsed).toEqual([0, 3_000, 6_000]);
  });
});
