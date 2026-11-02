// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

import { InfraError } from "../../errors.js";

/** The extracted llama.cpp archive holds no llama-server binary; nothing was installed. */
export class LlamaServerBinaryMissingError extends InfraError {
  constructor(build: string, installDir: string) {
    super({
      code: "INFRA_LLAMA_SERVER_BINARY_MISSING",
      message: `llama.cpp ${build} archive extracted to ${installDir} holds no llama-server binary`,
      hint: "Re-run the command to download the archive again; a repeated failure means the release asset layout changed, report it",
    });
  }
}
