import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  KevSessionBusyError,
  KevSessionLostError,
  KevSessionUnavailableError,
} from "../../../../src/core/adapters/kev/errors.js";
import { KevSessionClient } from "../../../../src/core/adapters/kev/kev-session-client.js";
import { startFakeGpuBroker, type FakeGpuBroker } from "./__helpers__/fake-gpu-broker.js";

describe("KevSessionClient", () => {
  let broker: FakeGpuBroker;

  beforeEach(async () => {
    broker = await startFakeGpuBroker();
  });

  afterEach(async () => {
    await broker.close();
  });

  it("acquires a lease with holder and ttl and returns the Kev URL the broker started", async () => {
    const client = new KevSessionClient({ url: `${broker.url}/` });

    const session = await client.acquire("laptop:42", 120);

    expect(session).toEqual({ lease: "lease-1", kevUrl: "http://kev-host:8009", expiresAt: 1_900_000_000 });
    expect(broker.requests).toEqual([
      { method: "POST", path: "/v1/session", body: { holder: "laptop:42", ttlSec: 120 } },
    ]);
  });

  it("names the holder and state of a session that is already held (409)", async () => {
    broker.lease = "lease-other";
    const client = new KevSessionClient({ url: broker.url });

    const error = await client.acquire("laptop:42", 120).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KevSessionBusyError);
    expect((error as Error).message).toBe(`gpu-session-busy: someone-else:1 (KEV) at ${broker.url}`);
  });

  it("carries the broker's refusal reason when it cannot switch to Kev (503)", async () => {
    broker.onAcquire = () => ({ status: 503, body: { reason: "embedding run in flight on 8091" } });
    const client = new KevSessionClient({ url: broker.url });

    const error = await client.acquire("laptop:42", 120).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KevSessionUnavailableError);
    expect((error as Error).message).toBe(`gpu-session-unavailable: embedding run in flight on 8091 at ${broker.url}`);
  });

  it("reports an unreachable broker as unavailable", async () => {
    await broker.close();
    const client = new KevSessionClient({ url: broker.url });

    await expect(client.acquire("laptop:42", 120)).rejects.toBeInstanceOf(KevSessionUnavailableError);
    await expect(client.state()).rejects.toBeInstanceOf(KevSessionUnavailableError);
  });

  it("reports a rejected token (401) as unavailable without echoing the token", async () => {
    await broker.close();
    broker = await startFakeGpuBroker({ token: "s3cret" });
    const client = new KevSessionClient({ url: broker.url, token: "wrong" });

    const error = await client.acquire("laptop:42", 120).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KevSessionUnavailableError);
    expect((error as Error).message).toContain("HTTP 401");
    expect(JSON.stringify(error)).not.toContain("wrong");
  });

  it("sends the token on every request", async () => {
    await broker.close();
    broker = await startFakeGpuBroker({ token: "s3cret" });
    const client = new KevSessionClient({ url: broker.url, token: "s3cret" });

    const { lease } = await client.acquire("laptop:42", 120);
    await client.heartbeat(lease);
    await client.release(lease);

    expect(broker.requests.map((r) => r.token)).toEqual(["s3cret", "s3cret", "s3cret"]);
  });

  it("extends a live lease and reports a lost one (404) on heartbeat", async () => {
    const client = new KevSessionClient({ url: broker.url });
    const { lease } = await client.acquire("laptop:42", 120);

    await expect(client.heartbeat(lease)).resolves.toBeUndefined();
    broker.lease = undefined;
    await expect(client.heartbeat(lease)).rejects.toBeInstanceOf(KevSessionLostError);
  });

  it("releases a lease, and treats an already gone lease as released", async () => {
    const client = new KevSessionClient({ url: broker.url });
    const { lease } = await client.acquire("laptop:42", 120);

    await client.release(lease);
    await client.release(lease);

    expect(broker.lease).toBeUndefined();
    expect(broker.requests.filter((r) => r.method === "DELETE")).toHaveLength(2);
  });

  it("reads the broker state and the Kev run it serves", async () => {
    const client = new KevSessionClient({ url: broker.url });

    await expect(client.state()).resolves.toEqual({ state: "EMBED", kevRun: "jaredpalmer/kev-4b@v1.0" });
  });
});
