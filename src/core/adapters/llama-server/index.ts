// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/** The llama-server binary: install from the pinned llama.cpp release, and resolve where it lives. */

export { llamaCppInstallRoot, resolveLlamaServerBinary } from "./binary.js";
export { detectLlamaServerBackend } from "./install/gpu-backend.js";
export { downloadLlamaServer, type LlamaServerInstallOptions } from "./install/install.js";
export {
  LLAMA_CPP_BUILD,
  llamaCppAssetsFor,
  type LlamaCppPlatformAssets,
  type LlamaCppReleaseAsset,
  type LlamaServerBackend,
} from "./install/llama-cpp-assets.js";
export { LlamaServerPoolRegistryCorruptedError, LlamaServerPoolStartError } from "./pools/errors.js";
export {
  buildPoolLaunchArgs,
  LlamaServerPools,
  type LlamaServerPoolStartOptions,
  type LlamaServerPoolStatus,
  type LlamaServerPoolsDeps,
} from "./pools/llama-server-pools.js";
export {
  llamaServerPoolsPath,
  readLlamaServerPoolRecords,
  writeLlamaServerPoolRecords,
  type LlamaServerPoolRecord,
} from "./pools/pool-registry.js";
export { productionLlamaServerPoolsDeps } from "./pools/production-deps.js";
export {
  isLoopbackPortFree,
  LLAMA_SERVER_POOL_PORT_MAX,
  LLAMA_SERVER_POOL_PORT_MIN,
  pickFreePorts,
} from "./pools/ports.js";
