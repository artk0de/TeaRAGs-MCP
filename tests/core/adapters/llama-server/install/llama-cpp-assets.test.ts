import { describe, expect, it } from "vitest";

import type { LlamaServerBackend } from "../../../../../src/core/adapters/llama-server/install/gpu-backend.js";
import {
  LLAMA_CPP_BUILD,
  llamaCppAssetsFor,
} from "../../../../../src/core/adapters/llama-server/install/llama-cpp-assets.js";
import { ConfigValueInvalidError } from "../../../../../src/core/primitives/errors/index.js";

const SUPPORTED: [NodeJS.Platform, string, LlamaServerBackend, string][] = [
  ["darwin", "arm64", "metal", "macos-arm64"],
  ["darwin", "x64", "cpu", "macos-x64"],
  ["linux", "x64", "cpu", "ubuntu-x64"],
  ["linux", "arm64", "cpu", "ubuntu-arm64"],
  ["linux", "x64", "vulkan", "ubuntu-vulkan-x64"],
  ["linux", "arm64", "vulkan", "ubuntu-vulkan-arm64"],
  ["linux", "x64", "cuda", "ubuntu-cuda-13.4-x64"],
  ["linux", "arm64", "cuda", "ubuntu-cuda-13.4-arm64"],
  ["linux", "x64", "rocm", "ubuntu-rocm-10.0-x64"],
  ["win32", "x64", "cpu", "win-cpu-x64"],
  ["win32", "arm64", "cpu", "win-cpu-arm64"],
  ["win32", "x64", "vulkan", "win-vulkan-x64"],
  ["win32", "x64", "cuda", "win-cuda-13.4-x64"],
  ["win32", "x64", "rocm", "win-rocm-10.0-x64"],
];

describe("llamaCppAssetsFor", () => {
  it.each(SUPPORTED)(
    "%s-%s %s maps to a pinned asset carrying the platform token",
    (platform, arch, backend, token) => {
      const assets = llamaCppAssetsFor(platform, arch, backend);

      expect(assets.asset).toContain(`-bin-${token}.`);
      expect(assets.asset).toContain(LLAMA_CPP_BUILD);
      expect(assets.sha256).toMatch(/^[0-9a-f]{64}$/);
    },
  );

  it("pins the b12032 build", () => {
    expect(LLAMA_CPP_BUILD).toBe("b12032");
  });

  it("cuda triples carry the cudart companion of the same CUDA version and arch", () => {
    expect(llamaCppAssetsFor("linux", "x64", "cuda").companion?.asset).toBe(
      "cudart-llama-b12032-bin-ubuntu-cuda-13.4-x64.tar.gz",
    );
    expect(llamaCppAssetsFor("linux", "arm64", "cuda").companion?.asset).toBe(
      "cudart-llama-b12032-bin-ubuntu-cuda-13.4-arm64.tar.gz",
    );
    const win = llamaCppAssetsFor("win32", "x64", "cuda");
    expect(win.companion?.asset).toBe("cudart-llama-bin-win-cuda-13.4-x64.zip");
    expect(win.companion?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("non-cuda triples carry no companion", () => {
    expect(llamaCppAssetsFor("linux", "x64", "vulkan").companion).toBeUndefined();
    expect(llamaCppAssetsFor("darwin", "arm64", "metal").companion).toBeUndefined();
  });

  it.each<[NodeJS.Platform, string, LlamaServerBackend]>([
    ["win32", "arm64", "cuda"],
    ["win32", "arm64", "vulkan"],
    ["darwin", "x64", "metal"],
    ["linux", "arm64", "rocm"],
    ["linux", "x64", "metal"],
    ["freebsd", "x64", "cpu"],
    ["linux", "ia32", "cpu"],
  ])("%s-%s %s is unmapped and throws ConfigValueInvalidError", (platform, arch, backend) => {
    expect(() => llamaCppAssetsFor(platform, arch, backend)).toThrow(ConfigValueInvalidError);
  });
});
