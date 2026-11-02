// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * Which llama.cpp release asset serves one platform triple
 * (OS × arch × GPU backend). Names follow the release's own scheme; the
 * sha256 of every name comes from the generated manifest, never typed here.
 */

import { ConfigValueInvalidError } from "../../../primitives/errors/index.js";
import { LLAMA_CPP_ASSET_SHA256, LLAMA_CPP_BUILD } from "./llama-cpp-manifest.generated.js";

export { LLAMA_CPP_BUILD } from "./llama-cpp-manifest.generated.js";

/** The llama.cpp GPU build a release asset targets. */
export type LlamaServerBackend = "metal" | "cpu" | "cuda" | "vulkan" | "rocm";

export interface LlamaCppReleaseAsset {
  asset: string;
  /** Lowercase hex. */
  sha256: string;
}

export interface LlamaCppPlatformAssets extends LlamaCppReleaseAsset {
  /** CUDA runtime libraries extracted next to llama-server (cuda backend only). */
  companion?: LlamaCppReleaseAsset;
}

const CUDA_VERSION = "13.4";
const ROCM_VERSION = "10.0";

/** Asset flavour inside `llama-<build>-bin-<flavour>.<ext>`, per `<platform>-<arch>` and backend. */
const ASSET_FLAVOURS: Readonly<Record<string, Partial<Record<LlamaServerBackend, string>>>> = {
  "darwin-arm64": { metal: "macos-arm64", cpu: "macos-arm64" },
  "darwin-x64": { cpu: "macos-x64" },
  "linux-x64": {
    cpu: "ubuntu-x64",
    vulkan: "ubuntu-vulkan-x64",
    cuda: `ubuntu-cuda-${CUDA_VERSION}-x64`,
    rocm: `ubuntu-rocm-${ROCM_VERSION}-x64`,
  },
  "linux-arm64": { cpu: "ubuntu-arm64", vulkan: "ubuntu-vulkan-arm64", cuda: `ubuntu-cuda-${CUDA_VERSION}-arm64` },
  "win32-x64": {
    cpu: "win-cpu-x64",
    vulkan: "win-vulkan-x64",
    cuda: `win-cuda-${CUDA_VERSION}-x64`,
    rocm: `win-rocm-${ROCM_VERSION}-x64`,
  },
  "win32-arm64": { cpu: "win-cpu-arm64" },
};

function pinned(asset: string): LlamaCppReleaseAsset {
  const sha256 = LLAMA_CPP_ASSET_SHA256[asset];
  if (sha256 === undefined) {
    throw new Error(`llama.cpp ${LLAMA_CPP_BUILD} manifest has no sha256 for ${asset} — regenerate the manifest`);
  }
  return { asset, sha256 };
}

/** The cudart archive: Unix names carry the build, the Windows zip does not. */
function cudaCompanionName(platform: NodeJS.Platform, arch: string): string {
  return platform === "win32"
    ? `cudart-llama-bin-win-cuda-${CUDA_VERSION}-${arch}.zip`
    : `cudart-llama-${LLAMA_CPP_BUILD}-bin-ubuntu-cuda-${CUDA_VERSION}-${arch}.tar.gz`;
}

/** True when llama.cpp publishes a binary for this triple. */
export function hasLlamaCppAsset(platform: NodeJS.Platform, arch: string, backend: LlamaServerBackend): boolean {
  return ASSET_FLAVOURS[`${platform}-${arch}`]?.[backend] !== undefined;
}

/** Asset names (+ the cudart companion for cuda) for one platform triple; throws ConfigValueInvalidError on an unmapped triple. */
export function llamaCppAssetsFor(
  platform: NodeJS.Platform,
  arch: string,
  backend: LlamaServerBackend,
): LlamaCppPlatformAssets {
  const triple = `${platform}-${arch}`;
  const flavour = ASSET_FLAVOURS[triple]?.[backend];
  if (flavour === undefined) {
    const supported = Object.entries(ASSET_FLAVOURS)
      .map(([key, backends]) => `${key} (${Object.keys(backends).join("|")})`)
      .join(", ");
    throw new ConfigValueInvalidError("llama-server backend", `${triple} ${backend}`, supported);
  }
  const extension = platform === "win32" ? "zip" : "tar.gz";
  const main = pinned(`llama-${LLAMA_CPP_BUILD}-bin-${flavour}.${extension}`);
  return backend === "cuda" ? { ...main, companion: pinned(cudaCompanionName(platform, arch)) } : main;
}
