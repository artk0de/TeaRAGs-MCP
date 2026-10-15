import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BrokeredResidualProvider,
  type ProcessSignals,
} from "../../../../src/core/adapters/kev/brokered-residual-provider.js";
import {
  KevSessionBusyError,
  KevSessionLostError,
  KevSessionUnavailableError,
} from "../../../../src/core/adapters/kev/errors.js";
import { KevSessionClient } from "../../../../src/core/adapters/kev/kev-session-client.js";
import type {
  ResidualAnswer,
  ResidualModelProvider,
  ResidualQuestionGroup,
} from "../../../../src/core/contracts/types/codegraph-residual.js";
import { startFakeGpuBroker, type FakeGpuBroker } from "./__helpers__/fake-gpu-broker.js";

const GROUP: ResidualQuestionGroup = {
  sourceRelPath: "app/a.rb",
  methodSymbolId: "A#run",
  methodSource: "def run(firm)\n  firm.users\nend",
  questions: [
    {
      siteKey: "s1",
      menuHash: "menu-1",
      receiverText: "firm",
      member: "users",
      kind: "ambiguous",
      candidates: ["Firm#users", "Client#users"],
    },
  ],
};

class FakeKev implements ResidualModelProvider {
  readonly id = "kev";
  readonly threshold = 0.7;
  readonly asked: string[] = [];
  constructor(
    readonly url: string,
    private readonly run: string,
  ) {}
  version = async (): Promise<string> => this.run;
  health = async (): Promise<{ ok: true }> => ({ ok: true });
  resolveGroup = async (group: ResidualQuestionGroup): Promise<ResidualAnswer[]> => {
    this.asked.push(`${this.url} ${group.methodSymbolId}`);
    return [{ siteKey: "s1", pick: "Firm#users", p: 0.9, probabilities: {}, questionPayload: "{}" }];
  };
}

class FakeSignals extends EventEmitter implements ProcessSignals {
  readonly pid = 4242;
  readonly killed: string[] = [];
  kill = (pid: number, signal: NodeJS.Signals): boolean => {
    this.killed.push(`${pid} ${signal}`);
    return true;
  };
}

const sleep = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await sleep(5);
};

describe("BrokeredResidualProvider", () => {
  let broker: FakeGpuBroker;
  let signals: FakeSignals;
  let kevs: FakeKev[];
  let kevRun: string;

  beforeEach(async () => {
    broker = await startFakeGpuBroker();
    signals = new FakeSignals();
    kevs = [];
    ({ kevRun } = broker);
  });

  afterEach(async () => {
    await broker.close();
  });

  const provider = (heartbeatMs = 60_000) =>
    new BrokeredResidualProvider(
      {
        session: new KevSessionClient({ url: broker.url }),
        threshold: 0.7,
        holder: "laptop:42",
        ttlSec: 120,
        heartbeatMs,
        kevProvider: (kevUrl) => {
          const kev = new FakeKev(kevUrl, kevRun);
          kevs.push(kev);
          return kev;
        },
      },
      { signals },
    );

  const paths = () => broker.requests.map((r) => `${r.method} ${r.path}`);

  it("answers health and version from the broker without taking the GPU", async () => {
    const brokered = provider();

    await expect(brokered.health()).resolves.toEqual({ ok: true });
    await expect(brokered.version()).resolves.toBe("jaredpalmer/kev-4b@v1.0");

    expect(paths()).toEqual(["GET /v1/state", "GET /v1/state"]);
    expect(kevs).toEqual([]);
  });

  it("reports the broker unreachable as unhealthy", async () => {
    await broker.close();

    const health = await provider().health();

    expect(health.ok).toBe(false);
  });

  it("asks Kev at the URL of the lease and releases the lease afterwards", async () => {
    const brokered = provider();
    await brokered.version();

    const lease = await brokered.acquire();
    const answers = await brokered.resolveGroup(GROUP);
    await lease.release();

    expect(broker.requests.find((r) => r.method === "POST")?.body).toEqual({ holder: "laptop:42", ttlSec: 120 });
    expect(answers.map((a) => a.pick)).toEqual(["Firm#users"]);
    expect(kevs.map((k) => k.asked)).toEqual([["http://kev-host:8009 A#run"]]);
    expect(paths().at(-1)).toBe("DELETE /v1/session/lease-1");
    expect(broker.lease).toBeUndefined();
  });

  it("refuses and releases a lease whose Kev serves another run than the broker announced", async () => {
    const brokered = provider();
    await brokered.version();
    kevRun = "jaredpalmer/kev-4b@v2.0";

    const error = await brokered.acquire().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KevSessionUnavailableError);
    expect((error as Error).message).toContain("jaredpalmer/kev-4b@v2.0");
    expect(broker.lease).toBeUndefined();
  });

  it("propagates a busy broker without starting heartbeats or signal handlers", async () => {
    broker.lease = "lease-other";

    await expect(provider(5).acquire()).rejects.toBeInstanceOf(KevSessionBusyError);
    await sleep(30);

    expect(paths()).toEqual(["POST /v1/session"]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("heartbeats while leased and stops on release", async () => {
    const brokered = provider(10);
    const lease = await brokered.acquire();

    await waitFor(() => paths().filter((p) => p.endsWith("/heartbeat")).length >= 2);
    await lease.release();
    const beats = paths().filter((p) => p.endsWith("/heartbeat")).length;
    await sleep(40);

    expect(beats).toBeGreaterThanOrEqual(2);
    expect(paths().filter((p) => p.endsWith("/heartbeat"))).toHaveLength(beats);
  });

  it("fails every later ask with a lost session once a heartbeat answers 404", async () => {
    const brokered = provider(10);
    const lease = await brokered.acquire();
    broker.onHeartbeat = () => ({ status: 404, body: {} });

    await waitFor(() => paths().some((p) => p.endsWith("/heartbeat")));
    await sleep(10);

    await expect(brokered.resolveGroup(GROUP)).rejects.toBeInstanceOf(KevSessionLostError);
    expect(kevs[0].asked).toEqual([]);
    await lease.release();
  });

  it("releases on SIGINT and re-raises the signal when nobody else handles it", async () => {
    await provider().acquire();

    signals.emit("SIGINT");
    await waitFor(() => broker.lease === undefined && signals.killed.length > 0);

    expect(paths().at(-1)).toBe("DELETE /v1/session/lease-1");
    expect(signals.killed).toEqual(["4242 SIGINT"]);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("removes its signal handlers on release; a second release is a no-op even with the broker gone", async () => {
    const lease = await provider().acquire();

    await lease.release();
    await broker.close();
    await expect(lease.release()).resolves.toBeUndefined();

    expect(paths().filter((p) => p.startsWith("DELETE"))).toHaveLength(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});
