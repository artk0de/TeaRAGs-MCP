import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { runLlamaServerInstall } from "../../../src/cli/commands/llama-server-install.js";

const downloadLlamaServer = vi.hoisted(() =>
  vi.fn(async () => "/data/llama.cpp/b12032-cuda/llama-b12032/llama-server"),
);

// Only the network-touching installer is faked; backend detection stays real.
vi.mock("../../../src/core/api/index.js", async () => {
  const { detectLlamaServerBackend } = await import("../../../src/core/adapters/llama-server/index.js");
  return { detectLlamaServerBackend, downloadLlamaServer };
});

function depsWith(over: { which?: (cmd: string) => string | null; env?: NodeJS.ProcessEnv } = {}) {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      fetch: vi.fn(),
      run: vi.fn(),
      which: over.which ?? (() => null),
      out: (line: string) => lines.push(line),
      env: over.env ?? {},
      home: "/home/u",
      platform: "linux" as NodeJS.Platform,
      arch: "x64",
    },
  };
}

describe("runLlamaServerInstall", () => {
  beforeEach(() => {
    downloadLlamaServer.mockClear();
  });

  it("auto detects the backend from GPU tools on PATH and prints the installed path last", async () => {
    const { deps, lines } = depsWith({
      which: (cmd) => (cmd === "nvidia-smi" ? "/usr/bin/nvidia-smi" : null),
      env: { TEA_RAGS_DATA_DIR: "/data" },
    });

    await runLlamaServerInstall({}, deps);

    expect(downloadLlamaServer).toHaveBeenCalledWith(
      { dataDir: "/data", platform: "linux", arch: "x64", backend: "cuda" },
      { fetch: deps.fetch, run: deps.run },
    );
    expect(lines.at(-1)).toBe("/data/llama.cpp/b12032-cuda/llama-b12032/llama-server");
  });

  it("an explicit backend skips detection; the data dir defaults to ~/.tea-rags", async () => {
    const which = vi.fn(() => "/usr/bin/nvidia-smi");
    const { deps } = depsWith({ which });

    await runLlamaServerInstall({ backend: "vulkan" }, deps);

    expect(which).not.toHaveBeenCalled();
    expect(downloadLlamaServer).toHaveBeenCalledWith(
      expect.objectContaining({ dataDir: join("/home/u", ".tea-rags"), backend: "vulkan" }),
      expect.anything(),
    );
  });
});
