import { describe, expect, it } from "vitest";

import { detectLlamaServerBackend } from "../../../../../src/core/adapters/llama-server/install/gpu-backend.js";

const whichOf =
  (...present: string[]) =>
  (cmd: string): boolean =>
    present.includes(cmd);

describe("detectLlamaServerBackend", () => {
  it("darwin-arm64 is always metal, even with other GPU tools on PATH", () => {
    expect(detectLlamaServerBackend("darwin", "arm64", { which: whichOf("vulkaninfo", "nvidia-smi") })).toBe("metal");
  });

  it("probes nvidia-smi before rocminfo before vulkaninfo", () => {
    const all = whichOf("nvidia-smi", "rocminfo", "vulkaninfo");
    expect(detectLlamaServerBackend("linux", "x64", { which: all })).toBe("cuda");
    expect(detectLlamaServerBackend("linux", "x64", { which: whichOf("rocminfo", "vulkaninfo") })).toBe("rocm");
    expect(detectLlamaServerBackend("linux", "x64", { which: whichOf("vulkaninfo") })).toBe("vulkan");
    expect(detectLlamaServerBackend("win32", "x64", { which: all })).toBe("cuda");
  });

  it("falls back to cpu when no GPU tool is found", () => {
    expect(detectLlamaServerBackend("linux", "x64", { which: whichOf() })).toBe("cpu");
    expect(detectLlamaServerBackend("darwin", "x64", { which: whichOf() })).toBe("cpu");
  });

  it("skips a probed backend the platform has no release binary for", () => {
    expect(detectLlamaServerBackend("linux", "arm64", { which: whichOf("rocminfo", "vulkaninfo") })).toBe("vulkan");
    expect(detectLlamaServerBackend("win32", "arm64", { which: whichOf("nvidia-smi", "vulkaninfo") })).toBe("cpu");
  });
});
