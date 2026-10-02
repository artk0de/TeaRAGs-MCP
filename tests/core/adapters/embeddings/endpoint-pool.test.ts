import { describe, expect, it, vi } from "vitest";

import {
  EmbeddingEndpointPool,
  parseEmbeddingEndpointList,
  type EmbeddingEndpointPoolConfig,
} from "../../../../src/core/adapters/embeddings/endpoint-pool.js";

const PEER_A = "http://gpu:8081";
const PEER_B = "http://gpu:8082";
const FALLBACK = "http://127.0.0.1:8080";

function makePool(overrides: Partial<EmbeddingEndpointPoolConfig> = {}): EmbeddingEndpointPool {
  return new EmbeddingEndpointPool({
    peers: [PEER_A, PEER_B],
    fallbacks: [FALLBACK],
    failoverConsecutiveFailures: 3,
    probeIntervalMs: 1000,
    probe: async () => false,
    ...overrides,
  });
}

function urls(pool: EmbeddingEndpointPool): string[] {
  return pool.activeEndpoints().map((e) => e.url);
}

describe("parseEmbeddingEndpointList", () => {
  it("splits on commas, trims, and strips trailing slashes", () => {
    expect(parseEmbeddingEndpointList("http://a:1, http://b:2/")).toEqual(["http://a:1", "http://b:2"]);
  });

  it("returns an empty list for undefined", () => {
    expect(parseEmbeddingEndpointList(undefined)).toEqual([]);
  });

  it("returns one element for a single URL", () => {
    expect(parseEmbeddingEndpointList("http://localhost:11434")).toEqual(["http://localhost:11434"]);
  });

  it("drops empty entries", () => {
    expect(parseEmbeddingEndpointList(" ,http://a:1,, ")).toEqual(["http://a:1"]);
  });
});

describe("EmbeddingEndpointPool", () => {
  it("starts on the peer tier with every peer active", () => {
    const pool = makePool();
    expect(pool.activeTier()).toBe("peer");
    expect(urls(pool)).toEqual([PEER_A, PEER_B]);
  });

  it("marks an endpoint unhealthy immediately on a refused connection", () => {
    const pool = makePool();
    pool.recordEndpointFailure(PEER_A, "refused");
    expect(urls(pool)).toEqual([PEER_B]);
    expect(pool.snapshot().find((e) => e.url === PEER_A)?.healthy).toBe(false);
  });

  it("marks an endpoint unhealthy on transient failures only after the threshold", () => {
    const pool = makePool({ failoverConsecutiveFailures: 3 });
    pool.recordEndpointFailure(PEER_A, "transient");
    pool.recordEndpointFailure(PEER_A, "transient");
    expect(urls(pool)).toEqual([PEER_A, PEER_B]);
    pool.recordEndpointFailure(PEER_A, "transient");
    expect(urls(pool)).toEqual([PEER_B]);
  });

  it("resets the transient failure counter on success", () => {
    const pool = makePool({ failoverConsecutiveFailures: 3 });
    pool.recordEndpointFailure(PEER_A, "transient");
    pool.recordEndpointFailure(PEER_A, "transient");
    pool.recordSuccess(PEER_A, 1000, 100);
    expect(pool.snapshot().find((e) => e.url === PEER_A)?.consecutiveFailures).toBe(0);
    pool.recordEndpointFailure(PEER_A, "transient");
    pool.recordEndpointFailure(PEER_A, "transient");
    expect(urls(pool)).toEqual([PEER_A, PEER_B]);
  });

  it("never marks an endpoint on transient failures when count-based failover is disabled", () => {
    const pool = makePool({ failoverConsecutiveFailures: 0 });
    for (let i = 0; i < 50; i++) pool.recordEndpointFailure(PEER_A, "transient");
    expect(urls(pool)).toEqual([PEER_A, PEER_B]);
  });

  it("serves from the healthy fallbacks when every peer is unhealthy", () => {
    const pool = makePool();
    pool.recordEndpointFailure(PEER_A, "refused");
    pool.recordEndpointFailure(PEER_B, "refused");
    expect(pool.activeTier()).toBe("fallback");
    expect(urls(pool)).toEqual([FALLBACK]);
  });

  it("has no active tier when every endpoint including fallbacks is unhealthy", () => {
    const pool = makePool();
    pool.recordEndpointFailure(PEER_A, "refused");
    pool.recordEndpointFailure(PEER_B, "refused");
    pool.recordEndpointFailure(FALLBACK, "refused");
    expect(pool.activeTier()).toBeUndefined();
    expect(pool.activeEndpoints()).toEqual([]);
  });

  it("re-admits a failed peer whose probe succeeds and flips back to the peer tier", async () => {
    const probe = vi.fn(async (url: string) => url === PEER_B);
    const pool = makePool({ probe });
    pool.recordEndpointFailure(PEER_A, "refused");
    pool.recordEndpointFailure(PEER_B, "refused");
    expect(pool.activeTier()).toBe("fallback");

    await pool.probeFailed();

    expect(pool.activeTier()).toBe("peer");
    expect(urls(pool)).toEqual([PEER_B]);
    expect(probe).toHaveBeenCalledWith(PEER_A);
    expect(probe).toHaveBeenCalledWith(PEER_B);
    expect(probe).not.toHaveBeenCalledWith(FALLBACK);
  });

  it("does not re-probe a failed endpoint sooner than probeIntervalMs after its last probe", async () => {
    let clock = 10_000;
    const probe = vi.fn(async () => false);
    const pool = makePool({ probe, probeIntervalMs: 1000, now: () => clock });
    pool.recordEndpointFailure(PEER_A, "refused");

    await pool.probeFailed();
    expect(probe).toHaveBeenCalledTimes(1);

    clock += 500;
    await pool.probeFailed();
    expect(probe).toHaveBeenCalledTimes(1);

    clock += 500;
    await pool.probeFailed();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("re-admitted endpoints start with a clean failure counter", async () => {
    const pool = makePool({ probe: async () => true });
    pool.recordEndpointFailure(PEER_A, "refused");
    await pool.probeFailed();
    expect(pool.snapshot().find((e) => e.url === PEER_A)).toMatchObject({ healthy: true, consecutiveFailures: 0 });
  });

  it("sets the EWMA rate from the first sample and blends later samples with alpha 0.3", () => {
    const pool = makePool();
    pool.recordSuccess(PEER_A, 1000, 1000); // 1000 chars/s
    expect(pool.snapshot().find((e) => e.url === PEER_A)?.charsPerSecond).toBe(1000);
    pool.recordSuccess(PEER_A, 2000, 1000); // 2000 chars/s
    expect(pool.snapshot().find((e) => e.url === PEER_A)?.charsPerSecond).toBeCloseTo(0.3 * 2000 + 0.7 * 1000);
  });

  it("honours a custom EWMA alpha", () => {
    const pool = makePool({ ewmaAlpha: 0.5 });
    pool.recordSuccess(PEER_A, 1000, 1000);
    pool.recordSuccess(PEER_A, 3000, 1000);
    expect(pool.snapshot().find((e) => e.url === PEER_A)?.charsPerSecond).toBeCloseTo(2000);
  });

  it("ignores a zero-duration sample for the EWMA", () => {
    const pool = makePool();
    pool.recordSuccess(PEER_A, 1000, 0);
    expect(pool.snapshot().find((e) => e.url === PEER_A)?.charsPerSecond).toBeUndefined();
  });

  it("returns the first healthy active endpoint as primaryUrl, and peers[0] when none is healthy", () => {
    const pool = makePool();
    expect(pool.primaryUrl()).toBe(PEER_A);
    pool.recordEndpointFailure(PEER_A, "refused");
    expect(pool.primaryUrl()).toBe(PEER_B);
    pool.recordEndpointFailure(PEER_B, "refused");
    expect(pool.primaryUrl()).toBe(FALLBACK);
    pool.recordEndpointFailure(FALLBACK, "refused");
    expect(pool.primaryUrl()).toBe(PEER_A);
  });

  it("labels configured peers and fallbacks", () => {
    expect(makePool().configuredPeersLabel()).toBe(`${PEER_A},${PEER_B}`);
    expect(makePool().configuredFallbacksLabel()).toBe(FALLBACK);
    expect(makePool({ fallbacks: [] }).configuredFallbacksLabel()).toBeUndefined();
  });

  it("checkPeersHealth probes every peer, updates health, and reports whether any is up", async () => {
    const pool = makePool({ probe: async (url) => url === PEER_B });
    expect(await pool.checkPeersHealth()).toBe(true);
    expect(urls(pool)).toEqual([PEER_B]);

    const down = makePool({ probe: async () => false });
    expect(await down.checkPeersHealth()).toBe(false);
    expect(down.activeTier()).toBe("fallback");
  });

  it("checkFallbacksHealth reports fallback health, or undefined when none is configured", async () => {
    expect(await makePool({ probe: async () => true }).checkFallbacksHealth()).toBe(true);
    expect(await makePool({ probe: async () => false }).checkFallbacksHealth()).toBe(false);
    expect(await makePool({ fallbacks: [] }).checkFallbacksHealth()).toBeUndefined();
  });

  it("treats a throwing probe as a failed probe", async () => {
    const pool = makePool({
      probe: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    pool.recordEndpointFailure(PEER_A, "refused");
    await pool.probeFailed();
    expect(urls(pool)).toEqual([PEER_B]);
  });

  it("ignores records for URLs outside the pool", () => {
    const pool = makePool();
    pool.recordEndpointFailure("http://elsewhere:1", "refused");
    pool.recordSuccess("http://elsewhere:1", 10, 10);
    expect(pool.snapshot()).toHaveLength(3);
    expect(urls(pool)).toEqual([PEER_A, PEER_B]);
  });

  it("returns snapshot copies that do not alias internal state", () => {
    const pool = makePool();
    const [first] = pool.snapshot();
    first.healthy = false;
    expect(urls(pool)).toEqual([PEER_A, PEER_B]);
  });
});
