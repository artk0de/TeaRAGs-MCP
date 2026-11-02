// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

import { InfraError } from "../../errors.js";

/** The Ollama model reference is blank, so there is no model to resolve. */
export class OllamaModelReferenceEmptyError extends InfraError {
  constructor() {
    super({
      code: "INFRA_OLLAMA_MODEL_REFERENCE_EMPTY",
      message: "Empty Ollama model reference",
      hint: "Pass a model reference such as nomic-embed-text or namespace/name:tag",
    });
  }
}

/** The Ollama registry answered the manifest request with a non-2xx status. */
export class OllamaRegistryManifestMissingError extends InfraError {
  constructor(reference: string, status: number) {
    super({
      code: "INFRA_OLLAMA_REGISTRY_MANIFEST_MISSING",
      message: `Ollama registry has no manifest for ${reference} (status ${status})`,
      hint: "Check the model reference spelling and tag against the Ollama library; retry if the registry is unavailable",
    });
  }
}

/** The manifest carries no GGUF model layer, so the model cannot feed llama-server. */
export class OllamaRegistryModelLayerMissingError extends InfraError {
  constructor(reference: string, mediaType: string) {
    super({
      code: "INFRA_OLLAMA_REGISTRY_MODEL_LAYER_MISSING",
      message: `Ollama manifest for ${reference} has no ${mediaType} layer`,
      hint: "Pick a model that ships GGUF weights; adapter-only or non-model Ollama entries cannot be used",
    });
  }
}
