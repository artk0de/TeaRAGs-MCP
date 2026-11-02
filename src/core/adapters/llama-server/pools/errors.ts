// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

import { InfraError } from "../../errors.js";

/** A managed llama-server pool could not be brought up; whatever it had spawned is already stopped. */
export class LlamaServerPoolStartError extends InfraError {
  constructor(message: string, hint: string, cause?: Error) {
    super({ code: "INFRA_LLAMA_SERVER_POOL_START_FAILED", message, hint, cause });
  }
}

/** A bench embed request was refused or answered a non-2xx status; the measurement for that count is void. */
export class LlamaServerPoolBenchError extends InfraError {
  constructor(endpoint: string, detail: string, cause?: Error) {
    super({
      code: "INFRA_LLAMA_SERVER_POOL_BENCH_FAILED",
      message: `llama-server pool bench: ${endpoint} failed an embeddings request (${detail})`,
      hint: "Check the instance log under <data dir>/llama-server/logs, then re-run tea-rags llama-server bench",
      cause,
    });
  }
}

/** `pools.json` is unreadable; refusing it beats forgetting which processes are running. */
export class LlamaServerPoolRegistryCorruptedError extends InfraError {
  constructor(path: string, cause?: Error) {
    super({
      code: "INFRA_LLAMA_SERVER_POOL_REGISTRY_CORRUPTED",
      message: `llama-server pool registry ${path} is not valid JSON`,
      hint: `Stop the llama-server processes it listed by hand, then delete ${path}`,
      cause,
    });
  }
}
