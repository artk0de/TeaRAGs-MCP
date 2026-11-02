import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildPoolLaunchArgs,
  LlamaServerPools,
  type LlamaServerPoolsDeps,
} from "../../../../../src/core/adapters/llama-server/pools/llama-server-pools.js";
import { readLlamaServerPoolRecords } from "../../../../../src/core/adapters/llama-server/pools/pool-registry.js";

const CODERANK = "nomic-ai/CodeRankEmbed";
const CODERANK_FILE = "coderankembed-q8_0.gguf";
const BINARY = "/fake/llama-server";

/**
 * A fake llama-server fleet: `spawn` starts a "process" listening on the
 * `--port` it receives, and `fetch` answers `/health` and `/props` for the
 * ports of live processes only. Nothing binds a socket or forks.
 */
function fakeFleet(o: { servedFile?: (args: string[]) => string; neverHealthy?: boolean } = {}) {
  let nextPid = 500;
  const live = new Map<number, { port: number; args: string[] }>();
  const spawned: { binary: string; args: string[]; logPath: string; pid: number }[] = [];
  const killed: number[] = [];
  let clock = 0;
  const deps = (dataDir: string): LlamaServerPoolsDeps => ({
    dataDir,
    resolveBinary: () => BINARY,
    spawn: (binary, args, logPath) => {
      const pid = nextPid++;
      const port = Number(args[args.indexOf("--port") + 1]);
      live.set(pid, { port, args });
      spawned.push({ binary, args, logPath, pid });
      return { pid };
    },
    fetch: async (input) => {
      const url = new URL(String(input));
      const proc = [...live.values()].find((p) => p.port === Number(url.port));
      if (proc === undefined) throw new TypeError("fetch failed: ECONNREFUSED");
      if (url.pathname === "/health") {
        return o.neverHealthy === true
          ? new Response(JSON.stringify({ error: "loading" }), { status: 503 })
          : new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      if (url.pathname === "/props") {
        const modelPath = o.servedFile?.(proc.args) ?? proc.args[proc.args.indexOf("-m") + 1];
        return new Response(JSON.stringify({ model_path: modelPath }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
    kill: (pid) => {
      killed.push(pid);
      live.delete(pid);
    },
    isAlive: (pid) => live.has(pid),
    isPortFree: async (port) => ![...live.values()].some((p) => p.port === port),
    random: Math.random,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  return { deps, live, spawned, killed };
}

describe("buildPoolLaunchArgs", () => {
  it("sizes the context as slots × window and the batches as one window, on loopback", () => {
    expect(
      buildPoolLaunchArgs({
        ggufPath: "/m/coderankembed-q8_0.gguf",
        window: 2048,
        slots: 4,
        gpuLayers: 999,
        flashAttention: true,
      }),
    ).toEqual([
      "-m",
      "/m/coderankembed-q8_0.gguf",
      "--embedding",
      "--host",
      "127.0.0.1",
      "-ngl",
      "999",
      "-fa",
      "on",
      "-np",
      "4",
      "-c",
      "8192",
      "-b",
      "2048",
      "-ub",
      "2048",
    ]);
  });

  it("turns flash attention off on request", () => {
    const args = buildPoolLaunchArgs({
      ggufPath: "/m.gguf",
      window: 8192,
      slots: 2,
      gpuLayers: 0,
      flashAttention: false,
    });

    expect(args.slice(args.indexOf("-fa"), args.indexOf("-fa") + 2)).toEqual(["-fa", "off"]);
    expect(args.slice(args.indexOf("-c"), args.indexOf("-c") + 2)).toEqual(["-c", "16384"]);
  });
});

describe("LlamaServerPools", () => {
  let dataDir: string;
  let ggufPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "llama-pools-"));
    mkdirSync(join(dataDir, "models"), { recursive: true });
    ggufPath = join(dataDir, "models", CODERANK_FILE);
    writeFileSync(ggufPath, "gguf");
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const START = { model: CODERANK, instances: 2, slots: 4, gpuLayers: 999, flashAttention: true };

  it("starts N detached instances on distinct loopback ports, all healthy, and records the pool", async () => {
    const fleet = fakeFleet();
    const pools = new LlamaServerPools(fleet.deps(dataDir));

    const record = await pools.start(START);

    expect(record.model).toBe(CODERANK);
    expect(record.ggufPath).toBe(ggufPath);
    expect(record.binary).toBe(BINARY);
    expect(record.instances).toHaveLength(2);
    expect(new Set(record.instances.map((i) => i.port)).size).toBe(2);
    expect(record.args).toEqual(
      buildPoolLaunchArgs({ ggufPath, window: 2048, slots: 4, gpuLayers: 999, flashAttention: true }),
    );
    expect(record.args).not.toContain("--port");
    for (const [index, instance] of record.instances.entries()) {
      expect(fleet.spawned[index].args).toEqual([...record.args, "--port", String(instance.port)]);
      expect(fleet.spawned[index].logPath).toBe(instance.logPath);
      expect(instance.logPath.startsWith(join(dataDir, "llama-server"))).toBe(true);
      const health = await fleet.deps(dataDir).fetch(`http://127.0.0.1:${instance.port}/health`);
      expect(health.status).toBe(200);
    }
    expect(pools.endpointsFor(record)).toEqual(record.instances.map((i) => `http://127.0.0.1:${i.port}`));
    expect(await readLlamaServerPoolRecords(dataDir)).toEqual([record]);
  });

  it("stops what it spawned and throws when /props reports another model", async () => {
    const fleet = fakeFleet({ servedFile: () => "/elsewhere/jina-embeddings-v2-base-code-q8_0.gguf" });
    const pools = new LlamaServerPools(fleet.deps(dataDir));

    await expect(pools.start(START)).rejects.toThrow(/jina-embeddings-v2-base-code-q8_0\.gguf/);

    expect(fleet.killed.sort()).toEqual(fleet.spawned.map((s) => s.pid).sort());
    expect(fleet.live.size).toBe(0);
    expect(await readLlamaServerPoolRecords(dataDir)).toEqual([]);
  });

  it("stops what it spawned when an instance never turns healthy", async () => {
    const fleet = fakeFleet({ neverHealthy: true });
    const pools = new LlamaServerPools({ ...fleet.deps(dataDir), healthTimeoutMs: 1000 });

    await expect(pools.start(START)).rejects.toThrow(/health/);

    expect(fleet.live.size).toBe(0);
    expect(await readLlamaServerPoolRecords(dataDir)).toEqual([]);
  });

  it("refuses a model whose GGUF has not been fetched, before spawning", async () => {
    rmSync(ggufPath);
    const fleet = fakeFleet();
    const pools = new LlamaServerPools(fleet.deps(dataDir));

    await expect(pools.start(START)).rejects.toThrow(/fetch-model nomic-ai\/CodeRankEmbed/);
    expect(fleet.spawned).toEqual([]);
  });

  it("refuses to start without a llama-server binary", async () => {
    const fleet = fakeFleet();
    const pools = new LlamaServerPools({ ...fleet.deps(dataDir), resolveBinary: () => null });

    await expect(pools.start(START)).rejects.toThrow(/llama-server install/);
    expect(fleet.spawned).toEqual([]);
  });

  it("restarts on the requested ports when given", async () => {
    const fleet = fakeFleet();
    const pools = new LlamaServerPools(fleet.deps(dataDir));

    const record = await pools.start({ ...START, ports: [23456, 24567] });

    expect(record.instances.map((i) => i.port)).toEqual([23456, 24567]);
  });

  it("stop kills every instance and removes the record", async () => {
    const fleet = fakeFleet();
    const pools = new LlamaServerPools(fleet.deps(dataDir));
    const record = await pools.start(START);

    await pools.stop(CODERANK);

    expect(fleet.killed.sort()).toEqual(record.instances.map((i) => i.pid).sort());
    expect(await readLlamaServerPoolRecords(dataDir)).toEqual([]);
  });

  it("status marks a dead pid alive: false", async () => {
    const fleet = fakeFleet();
    const pools = new LlamaServerPools(fleet.deps(dataDir));
    const record = await pools.start(START);
    fleet.live.delete(record.instances[0].pid);

    expect(await pools.status()).toEqual([
      {
        model: CODERANK,
        slots: 4,
        instances: [
          { port: record.instances[0].port, pid: record.instances[0].pid, alive: false },
          { port: record.instances[1].port, pid: record.instances[1].pid, alive: true },
        ],
      },
    ]);
  });

  it("starting a model that already has a pool replaces it", async () => {
    const fleet = fakeFleet();
    const pools = new LlamaServerPools(fleet.deps(dataDir));
    const first = await pools.start(START);

    const second = await pools.start(START);

    expect(fleet.killed.sort()).toEqual(first.instances.map((i) => i.pid).sort());
    expect(await readLlamaServerPoolRecords(dataDir)).toEqual([second]);
  });
});
