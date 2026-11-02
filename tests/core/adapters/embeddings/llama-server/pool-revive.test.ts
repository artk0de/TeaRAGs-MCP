import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LLAMA_SERVER_REVIVE_REARM_MS,
  LlamaServerEmbeddings,
  type LlamaServerEmbeddingsDeps,
} from "../../../../../src/core/adapters/embeddings/llama-server/provider.js";
import {
  LlamaServerPools,
  type LlamaServerPoolsDeps,
} from "../../../../../src/core/adapters/llama-server/pools/llama-server-pools.js";
import {
  readLlamaServerPoolRecords,
  writeLlamaServerPoolRecords,
  type LlamaServerPoolRecord,
} from "../../../../../src/core/adapters/llama-server/pools/pool-registry.js";
import { reviveManagedLlamaServerPool } from "../../../../../src/core/adapters/llama-server/pools/pool-revive.js";

const MODEL = "nomic-ai/CodeRankEmbed";
const PEER_A = "http://127.0.0.1:23456";
const PEER_B = "http://127.0.0.1:24567";

function refused(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });
}

/** Endpoints that refuse every connection until `up` is flipped. */
function fakeEndpoints(urls: string[]) {
  const up = new Set<string>();
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = new URL(input instanceof Request ? input.url : input);
    const base = `${target.protocol}//${target.host}`;
    if (!urls.includes(base) || !up.has(base)) throw refused();
    if (target.pathname === "/health") return Response.json({ status: "ok" });
    if (target.pathname === "/v1/embeddings") {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { input: string[] };
      return Response.json({
        object: "list",
        data: body.input.map((_, index) => ({ object: "embedding", index, embedding: [index, 0.5] })),
      });
    }
    return new Response("Not Found", { status: 404 });
  };
  return {
    fetch,
    bringUp: () => {
      for (const url of urls) up.add(url);
    },
    takeDown: () => {
      up.clear();
    },
  };
}

function makeProvider(
  endpoints: ReturnType<typeof fakeEndpoints>,
  reviveEndpoints?: LlamaServerEmbeddingsDeps["reviveEndpoints"],
  clock: { now: number } = { now: 1_000_000 },
): LlamaServerEmbeddings {
  return new LlamaServerEmbeddings(
    MODEL,
    undefined,
    { failoverConsecutiveFailures: 3, unavailableRetryMaxWaitMs: 0 },
    `${PEER_A},${PEER_B}`,
    undefined,
    undefined,
    {
      fetch: endpoints.fetch,
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms;
      },
      setInterval: () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {},
      log: () => {},
      reviveEndpoints,
    },
  );
}

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("LlamaServerEmbeddings — reviveEndpoints", () => {
  it("revives the endpoints once when all of them refuse, then retries the batch", async () => {
    const endpoints = fakeEndpoints([PEER_A, PEER_B]);
    const calls: string[][] = [];
    const provider = makeProvider(endpoints, async (urls) => {
      calls.push(urls);
      endpoints.bringUp();
      return true;
    });

    const results = await provider.embedBatch(["t0", "t1", "t2"]);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.embedding.length === 2)).toBe(true);
    expect(calls).toEqual([[PEER_A, PEER_B]]);
  });

  it("concurrent outages share one revive", async () => {
    const endpoints = fakeEndpoints([PEER_A, PEER_B]);
    let calls = 0;
    const provider = makeProvider(endpoints, async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      endpoints.bringUp();
      return true;
    });

    const [a, b] = await Promise.all([provider.embedBatch(["t0", "t1"]), provider.embedBatch(["t2"])]);

    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("surfaces the original unavailable error unchanged when the revive fails", async () => {
    const baseline = await errorOf(makeProvider(fakeEndpoints([PEER_A, PEER_B])).embedBatch(["t0"]));
    let calls = 0;
    const provider = makeProvider(fakeEndpoints([PEER_A, PEER_B]), async () => {
      calls += 1;
      return false;
    });

    const error = await errorOf(provider.embedBatch(["t0"]));

    expect(calls).toBe(1);
    expect(error.constructor).toBe(baseline.constructor);
    expect(error.message).toBe(baseline.message);
  });

  it("a revive that throws surfaces the original error and is not retried", async () => {
    const baseline = await errorOf(makeProvider(fakeEndpoints([PEER_A, PEER_B])).embedBatch(["t0"]));
    let calls = 0;
    const provider = makeProvider(fakeEndpoints([PEER_A, PEER_B]), async () => {
      calls += 1;
      throw new Error("spawn failed");
    });

    const first = await errorOf(provider.embedBatch(["t0"]));
    const second = await errorOf(provider.embedBatch(["t0"]));

    expect(first.message).toBe(baseline.message);
    expect(second.message).toBe(baseline.message);
    expect(calls).toBe(1);
  });

  it("a second outage in the same process does not revive again", async () => {
    const endpoints = fakeEndpoints([PEER_A, PEER_B]);
    let calls = 0;
    const provider = makeProvider(endpoints, async () => {
      calls += 1;
      endpoints.bringUp();
      return true;
    });
    await provider.embedBatch(["t0"]);
    endpoints.takeDown();

    await errorOf(provider.embedBatch(["t1"]));

    expect(calls).toBe(1);
  });

  it("re-arms after a successful revive once the re-arm window has passed", async () => {
    const endpoints = fakeEndpoints([PEER_A, PEER_B]);
    const clock = { now: 1_000_000 };
    let calls = 0;
    const provider = makeProvider(
      endpoints,
      async () => {
        calls += 1;
        endpoints.bringUp();
        return true;
      },
      clock,
    );
    await provider.embedBatch(["t0"]);
    endpoints.takeDown();
    clock.now += LLAMA_SERVER_REVIVE_REARM_MS;

    const results = await provider.embedBatch(["t1"]);

    expect(results).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("a revive that reports success while the endpoints stay down fails once, without looping", async () => {
    const endpoints = fakeEndpoints([PEER_A, PEER_B]);
    let calls = 0;
    const provider = makeProvider(endpoints, async () => {
      calls += 1;
      return true;
    });

    const error = await errorOf(provider.embedBatch(["t0"]));

    expect(error.name).toBe("LlamaServerUnavailableError");
    expect(calls).toBe(1);
  });

  it("never re-arms after a failed revive", async () => {
    const endpoints = fakeEndpoints([PEER_A, PEER_B]);
    const clock = { now: 1_000_000 };
    let calls = 0;
    const provider = makeProvider(
      endpoints,
      async () => {
        calls += 1;
        return false;
      },
      clock,
    );
    await errorOf(provider.embedBatch(["t0"]));
    clock.now += LLAMA_SERVER_REVIVE_REARM_MS * 10;

    await errorOf(provider.embedBatch(["t1"]));

    expect(calls).toBe(1);
  });
});

const BINARY = "/fake/llama-server";
const GGUF_FILE = "coderankembed-q8_0.gguf";

/** Fake process fleet: `spawn` "listens" on its `--port`; fetch answers only live ports. */
function fakeFleet(o: { failSpawn?: boolean } = {}) {
  let nextPid = 900;
  const live = new Map<number, { port: number; args: string[] }>();
  const spawned: { binary: string; args: string[]; logPath: string; pid: number }[] = [];
  const killed: number[] = [];
  const deps = (dataDir: string): LlamaServerPoolsDeps => ({
    dataDir,
    resolveBinary: () => null,
    spawn: (binary, args, logPath) => {
      if (o.failSpawn === true) throw new Error(`Could not start ${binary}`);
      const pid = nextPid++;
      live.set(pid, { port: Number(args[args.indexOf("--port") + 1]), args });
      spawned.push({ binary, args, logPath, pid });
      return { pid };
    },
    fetch: async (input) => {
      const url = new URL(String(input));
      const proc = [...live.values()].find((p) => p.port === Number(url.port));
      if (proc === undefined) throw new TypeError("fetch failed: ECONNREFUSED");
      if (url.pathname === "/health") return Response.json({ status: "ok" });
      if (url.pathname === "/props") return Response.json({ model_path: proc.args[proc.args.indexOf("-m") + 1] });
      return new Response("not found", { status: 404 });
    },
    kill: (pid) => {
      killed.push(pid);
      live.delete(pid);
    },
    // The recorded pids 101/102 are "alive" — recycled by unrelated processes after a reboot.
    isAlive: (pid) => live.has(pid) || pid === 101 || pid === 102,
    isPortFree: async (port) => ![...live.values()].some((p) => p.port === port),
    random: Math.random,
    now: () => 0,
    sleep: async () => {},
  });
  return { deps, spawned, killed };
}

describe("managed pool revive", () => {
  let dataDir: string;
  let record: LlamaServerPoolRecord;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "llama-pool-revive-"));
    mkdirSync(join(dataDir, "models"), { recursive: true });
    const ggufPath = join(dataDir, "models", GGUF_FILE);
    writeFileSync(ggufPath, "gguf");
    record = {
      model: MODEL,
      ggufPath,
      binary: BINARY,
      instances: [
        { pid: 101, port: 23456, logPath: join(dataDir, "llama-server", "logs", "a.log") },
        { pid: 102, port: 24567, logPath: join(dataDir, "llama-server", "logs", "b.log") },
      ],
      args: ["-m", ggufPath, "--embedding", "--host", "127.0.0.1", "-np", "4"],
      startedAt: "2026-11-01T00:00:00.000Z",
    };
    await writeLlamaServerPoolRecords(dataDir, [record]);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("LlamaServerPools#restart respawns the recorded binary and args on the recorded ports without signalling recorded pids", async () => {
    const fleet = fakeFleet();
    const pools = new LlamaServerPools(fleet.deps(dataDir));

    const restarted = await pools.restart(record);

    expect(fleet.spawned.map((s) => s.binary)).toEqual([BINARY, BINARY]);
    expect(fleet.spawned.map((s) => s.args)).toEqual([
      [...record.args, "--port", "23456"],
      [...record.args, "--port", "24567"],
    ]);
    expect(fleet.killed).toEqual([]);
    expect(restarted.instances.map((i) => i.port)).toEqual([23456, 24567]);
    expect(restarted.instances.map((i) => i.pid)).toEqual(fleet.spawned.map((s) => s.pid));
    expect(await readLlamaServerPoolRecords(dataDir)).toEqual([restarted]);
  });

  it("restarts the pool whose endpoints are the provider's endpoints", async () => {
    const fleet = fakeFleet();
    const pools = new LlamaServerPools(fleet.deps(dataDir));

    const revived = await reviveManagedLlamaServerPool([PEER_B, `${PEER_A}/`], { pools, dataDir });

    expect(revived).toBe(true);
    expect(fleet.spawned.map((s) => s.args.at(-1))).toEqual(["23456", "24567"]);
  });

  it("leaves endpoints outside every recorded pool alone", async () => {
    const fleet = fakeFleet();
    const pools = new LlamaServerPools(fleet.deps(dataDir));

    expect(await reviveManagedLlamaServerPool(["http://gpu:8081"], { pools, dataDir })).toBe(false);
    expect(await reviveManagedLlamaServerPool([PEER_A], { pools, dataDir })).toBe(false);
    expect(fleet.spawned).toEqual([]);
    expect(fleet.killed).toEqual([]);
  });

  it("reports false and keeps the record when the restart fails", async () => {
    const fleet = fakeFleet({ failSpawn: true });
    const pools = new LlamaServerPools(fleet.deps(dataDir));

    expect(await reviveManagedLlamaServerPool([PEER_A, PEER_B], { pools, dataDir })).toBe(false);
    expect(fleet.killed).toEqual([]);
    expect(await readLlamaServerPoolRecords(dataDir)).toEqual([record]);
  });
});
