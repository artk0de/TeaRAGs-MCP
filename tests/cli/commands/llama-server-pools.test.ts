import { describe, expect, it, vi } from "vitest";

import {
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
  const deps: LlamaServerPoolsCommandDeps = { pools, out: (line) => lines.push(line) };
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
