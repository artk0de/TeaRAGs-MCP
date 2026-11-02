import { describe, expect, it, vi } from "vitest";

import {
  parseLlamaServerInstancesFlag,
  runLlamaServerBench,
  runLlamaServerStart,
  runLlamaServerStatus,
  runLlamaServerStop,
  type LlamaServerPoolsCommandDeps,
} from "../../../src/cli/commands/llama-server-pools.js";

const RECORD = {
  model: "nomic-ai/CodeRankEmbed",
  ggufPath: "/d/models/coderankembed-q8_0.gguf",
  binary: "/d/llama-server",
  instances: [
    { pid: 11, port: 21000, logPath: "/d/a.log" },
    { pid: 12, port: 22000, logPath: "/d/b.log" },
  ],
  args: ["-np", "4"],
  startedAt: "2026-11-02T00:00:00.000Z",
};

function fakeDeps() {
  const lines: string[] = [];
  const pools = {
    start: vi.fn(async () => RECORD),
    stop: vi.fn(async () => {}),
    status: vi.fn(async () => [{ model: RECORD.model, slots: 4, instances: [{ port: 21000, pid: 11, alive: true }] }]),
    endpointsFor: (record: typeof RECORD) => record.instances.map((i) => `http://127.0.0.1:${i.port}`),
  };
  const deps: LlamaServerPoolsCommandDeps = {
    pools,
    out: (line) => lines.push(line),
    embed: async () => {},
    now: () => 0,
  };
  return { deps, pools, lines };
}

describe("llama-server start/stop/status", () => {
  it("start passes the options through and prints the pool's endpoints as one JSON line", async () => {
    const { deps, pools, lines } = fakeDeps();

    await runLlamaServerStart(
      { model: RECORD.model, instances: 2, slots: 4, gpuLayers: 999, flashAttention: true },
      deps,
    );

    expect(pools.start).toHaveBeenCalledWith({
      model: RECORD.model,
      instances: 2,
      slots: 4,
      gpuLayers: 999,
      flashAttention: true,
    });
    expect(JSON.parse(lines.at(-1) ?? "")).toEqual({
      model: RECORD.model,
      endpoints: ["http://127.0.0.1:21000", "http://127.0.0.1:22000"],
      instances: RECORD.instances,
    });
  });

  it("start refuses fewer than 2 instances", async () => {
    const { deps, pools } = fakeDeps();

    await expect(
      runLlamaServerStart({ model: RECORD.model, instances: 1, slots: 4, gpuLayers: 999, flashAttention: true }, deps),
    ).rejects.toThrow(/instances/);
    expect(pools.start).not.toHaveBeenCalled();
  });

  it("stop forwards the model, or stops every pool without one", async () => {
    const { deps, pools } = fakeDeps();

    await runLlamaServerStop({ model: RECORD.model }, deps);
    await runLlamaServerStop({}, deps);

    expect(pools.stop).toHaveBeenNthCalledWith(1, RECORD.model);
    expect(pools.stop).toHaveBeenNthCalledWith(2, undefined);
  });

  it("status prints the pools as JSON", async () => {
    const { deps, lines } = fakeDeps();

    await runLlamaServerStatus(deps);

    expect(JSON.parse(lines.join("\n"))).toEqual([
      { model: RECORD.model, slots: 4, instances: [{ port: 21000, pid: 11, alive: true }] },
    ]);
  });
});

/** Pools whose `start` returns `instances` loopback instances; `embed` takes 4 s / instances on a fake clock. */
function benchDeps() {
  const lines: string[] = [];
  let clock = 0;
  const recordFor = (instances: number) => ({
    ...RECORD,
    instances: Array.from({ length: instances }, (_, i) => ({ pid: 10 + i, port: 21000 + i, logPath: `/d/${i}.log` })),
  });
  const pools = {
    start: vi.fn(async (o: { instances: number }) => recordFor(o.instances)),
    stop: vi.fn(async () => {}),
    status: vi.fn(async () => []),
    endpointsFor: (record: typeof RECORD) => record.instances.map((i) => `http://127.0.0.1:${i.port}`),
  };
  // Throughput per count: 1 → 100, 2 → 185, 3 → 198, 4 → 200 texts/s over the 512-text corpus.
  const secondsFor: Record<number, number> = { 1: 512 / 100, 2: 512 / 185, 3: 512 / 198, 4: 512 / 200 };
  const deps: LlamaServerPoolsCommandDeps = {
    pools,
    out: (line) => lines.push(line),
    embed: async (endpoints, texts) => {
      if (texts.length === 512) clock += (secondsFor[endpoints.length] ?? 1) * 1000;
    },
    now: () => clock,
  };
  return { deps, pools, lines };
}

describe("llama-server bench / start --instances auto", () => {
  it("bench prints texts/s per instance count and the chosen count as one JSON line", async () => {
    const { deps, lines } = benchDeps();

    await runLlamaServerBench(
      { model: RECORD.model, maxInstances: 4, slots: 4, gpuLayers: 999, flashAttention: true },
      deps,
    );

    const printed = JSON.parse(lines.at(-1) ?? "") as {
      model: string;
      results: { instances: number; textsPerSecond: number }[];
      chosenInstances: number;
    };
    expect(printed.model).toBe(RECORD.model);
    expect(printed.results.map((r) => [r.instances, Math.round(r.textsPerSecond)])).toEqual([
      [1, 100],
      [2, 185],
      [3, 198],
      [4, 200],
    ]);
    expect(printed.chosenInstances).toBe(3);
  });

  it("--instances parses auto or a count, and a non-number fails start validation", async () => {
    const { deps, pools } = benchDeps();

    expect(parseLlamaServerInstancesFlag("auto")).toBe("auto");
    expect(parseLlamaServerInstancesFlag("3")).toBe(3);
    await expect(
      runLlamaServerStart(
        {
          model: RECORD.model,
          instances: parseLlamaServerInstancesFlag("many"),
          slots: 4,
          gpuLayers: 999,
          flashAttention: true,
        },
        deps,
      ),
    ).rejects.toThrow(/instances/);
    expect(pools.start).not.toHaveBeenCalled();
  });

  it("start --instances auto benches first, then starts the chosen count", async () => {
    const { deps, pools, lines } = benchDeps();

    await runLlamaServerStart(
      { model: RECORD.model, instances: "auto", maxInstances: 4, slots: 4, gpuLayers: 999, flashAttention: true },
      deps,
    );

    expect(pools.start).toHaveBeenLastCalledWith({
      model: RECORD.model,
      instances: 3,
      slots: 4,
      gpuLayers: 999,
      flashAttention: true,
    });
    const printed = JSON.parse(lines.at(-1) ?? "") as { endpoints: string[]; bench: unknown[] };
    expect(printed.endpoints).toHaveLength(3);
    expect(printed.bench).toHaveLength(4);
  });
});
