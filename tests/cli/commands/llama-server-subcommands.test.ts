import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import yargs from "yargs";

import { productionLlamaServerInstallDeps, whichOnPath } from "../../../src/cli/commands/llama-server-install.js";
import { productionLlamaServerPoolsCommandDeps } from "../../../src/cli/commands/llama-server-pools.js";
import { llamaServerCommand } from "../../../src/cli/commands/llama-server.js";

const poolsMock = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(async () => undefined),
  status: vi.fn(async () => [{ model: "m", instances: [] }]),
  endpointsFor: vi.fn(),
}));
const downloadLlamaServer = vi.hoisted(() => vi.fn(async () => "/data/llama.cpp/b1-metal/llama-server"));
const embedSpy = vi.hoisted(() => vi.fn());

vi.mock("../../../src/core/api/index.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    downloadLlamaServer,
    detectLlamaServerBackend: () => "cpu",
    LlamaServerPools: vi.fn(function () {
      return poolsMock;
    }),
    productionLlamaServerPoolsDeps: vi.fn(() => ({})),
    createLlamaServerPoolBenchEmbed: vi.fn((o: unknown) => {
      embedSpy(o);
      return async () => undefined;
    }),
  };
});

let written: string[];

beforeEach(() => {
  written = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function run(...argv: string[]): Promise<void> {
  await yargs(argv).command(llamaServerCommand).fail(false).parseAsync();
}

describe("llama-server pool subcommands wired through yargs", () => {
  it("status prints the recorded pools as JSON", async () => {
    await run("llama-server", "status");
    expect(JSON.parse(written.join(""))).toEqual([{ model: "m", instances: [] }]);
  });

  it("stop forwards --model to the pools and reports it", async () => {
    await run("llama-server", "stop", "--model", "nomic-ai/CodeRankEmbed");
    expect(poolsMock.stop).toHaveBeenCalledWith("nomic-ai/CodeRankEmbed");
    expect(written.join("")).toContain("stopped nomic-ai/CodeRankEmbed");
  });

  it("stop without --model stops every pool", async () => {
    await run("llama-server", "stop");
    expect(poolsMock.stop).toHaveBeenCalledWith(undefined);
    expect(written.join("")).toContain("every pool");
  });

  it("install downloads the pinned build and prints its path last", async () => {
    await run("llama-server", "install", "--backend", "cpu");
    expect(downloadLlamaServer).toHaveBeenCalledWith(
      expect.objectContaining({ backend: "cpu" }),
      expect.objectContaining({ fetch: expect.any(Function), run: expect.any(Function) }),
    );
    const lines = written.join("").trim().split("\n");
    expect(lines.at(-1)).toBe("/data/llama.cpp/b1-metal/llama-server");
  });

  it("start rejects a pool of fewer than two instances before touching the pools", async () => {
    await expect(
      run("llama-server", "start", "--model", "nomic-ai/CodeRankEmbed", "--instances", "1"),
    ).rejects.toThrow();
    expect(poolsMock.start).not.toHaveBeenCalled();
  });

  it("bench rejects --max-instances below 2", async () => {
    await expect(
      run("llama-server", "bench", "--model", "nomic-ai/CodeRankEmbed", "--max-instances", "1"),
    ).rejects.toThrow(/max-instances/);
  });
});

describe("production deps factories", () => {
  it("install deps expose the live process environment and a PATH lookup", () => {
    const deps = productionLlamaServerInstallDeps();
    expect(deps.platform).toBe(process.platform);
    expect(deps.arch).toBe(process.arch);
    expect(deps.env).toBe(process.env);
    deps.out("hello");
    expect(written.join("")).toBe("hello\n");
    expect(deps.which("node")).toBe(whichOnPath("node"));
    expect(whichOnPath("definitely-not-a-binary-xyz")).toBeNull();
  });

  it("install deps run executes a real command and rejects on a failing one", async () => {
    const deps = productionLlamaServerInstallDeps();
    await expect(deps.run(process.execPath, ["-e", "0"])).resolves.toBeUndefined();
    await expect(deps.run(process.execPath, ["-e", "process.exit(3)"])).rejects.toThrow();
  });

  it("pool command deps print lines to stdout and size the bench embed by slots", () => {
    const deps = productionLlamaServerPoolsCommandDeps({ slots: 7 });
    deps.out("x");
    expect(written.join("")).toBe("x\n");
    expect(embedSpy).toHaveBeenCalledWith(expect.objectContaining({ slots: 7 }));
    expect(typeof deps.now()).toBe("number");
    expect(deps.pools).toBe(poolsMock);
  });
});
