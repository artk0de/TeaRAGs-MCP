// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

import { InfraError } from "../../errors.js";

/** A managed llama-server pool could not be brought up; whatever it had spawned is already stopped. */
export class LlamaServerPoolStartError extends InfraError {
  constructor(message: string, hint: string, cause?: Error) {
    super({ code: "INFRA_LLAMA_SERVER_POOL_START_FAILED", message, hint, cause });
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
