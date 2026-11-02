// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/** Which llama.cpp GPU build this machine can run, judged by the vendor tools on PATH. */

import { hasLlamaCppAsset, type LlamaServerBackend } from "./llama-cpp-assets.js";

export type { LlamaServerBackend } from "./llama-cpp-assets.js";

/** Probe order: the vendor tool that proves the backend's driver stack is installed. */
const GPU_PROBES: readonly (readonly [tool: string, backend: LlamaServerBackend])[] = [
  ["nvidia-smi", "cuda"],
  ["rocminfo", "rocm"],
  ["vulkaninfo", "vulkan"],
];

/**
 * darwin-arm64 → metal; else probe nvidia-smi → cuda, rocminfo → rocm,
 * vulkaninfo → vulkan; nothing → cpu. A backend the platform has no release
 * binary for is skipped, so the answer always installs.
 */
export function detectLlamaServerBackend(
  platform: NodeJS.Platform,
  arch: string,
  deps: { which: (cmd: string) => boolean },
): LlamaServerBackend {
  if (platform === "darwin" && arch === "arm64") return "metal";
  for (const [tool, backend] of GPU_PROBES) {
    if (hasLlamaCppAsset(platform, arch, backend) && deps.which(tool)) return backend;
  }
  return "cpu";
}
