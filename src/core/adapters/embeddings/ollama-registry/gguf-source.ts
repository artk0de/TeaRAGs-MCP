// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * GGUF weights straight from the Ollama registry.
 *
 * An Ollama model's `application/vnd.ollama.image.model` layer IS a plain GGUF
 * file, so any model in the Ollama library can feed llama-server without
 * Ollama installed. This module resolves a model reference to that layer's
 * blob URL and digest (manifest read over the registry's Docker v2 API) and
 * downloads it with streaming sha256 verification.
 */

import { downloadVerifiedFile } from "../../native-assets/index.js";
import {
  OllamaModelReferenceEmptyError,
  OllamaRegistryManifestMissingError,
  OllamaRegistryModelLayerMissingError,
} from "./errors.js";

const OLLAMA_REGISTRY = "https://registry.ollama.ai/v2";
const MANIFEST_MEDIA_TYPE = "application/vnd.docker.distribution.manifest.v2+json";
const MODEL_LAYER_MEDIA_TYPE = "application/vnd.ollama.image.model";

export interface OllamaRegistryGgufSource {
  /** The reference as the caller gave it. */
  reference: string;
  blobUrl: string;
  /** Hex digest, without the `sha256:` prefix. */
  sha256: string;
  size: number;
  /** `<name>@<tag>-<first12hex>.gguf` — the digest prefix keeps re-tagged weights apart. */
  fileName: string;
}

export interface OllamaRegistryDeps {
  fetch: typeof fetch;
}

/**
 * `namespace/name:tag`; a bare name is an official library model
 * (`nomic-embed-text` → `library/nomic-embed-text:latest`).
 */
export function parseOllamaModelReference(ref: string): { namespace: string; name: string; tag: string } {
  const trimmed = ref.trim();
  if (trimmed === "") throw new OllamaModelReferenceEmptyError();
  const lastSlash = trimmed.lastIndexOf("/");
  const lastColon = trimmed.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  const path = hasTag ? trimmed.slice(0, lastColon) : trimmed;
  const tag = hasTag ? trimmed.slice(lastColon + 1) : "latest";
  const slash = path.lastIndexOf("/");
  if (slash === -1) return { namespace: "library", name: path, tag };
  return { namespace: path.slice(0, slash), name: path.slice(slash + 1), tag };
}

interface RegistryManifest {
  layers?: { mediaType?: string; digest?: string; size?: number }[];
}

/** Read the manifest and locate the GGUF model layer. */
export async function resolveOllamaRegistryGguf(
  ref: string,
  deps: OllamaRegistryDeps,
): Promise<OllamaRegistryGgufSource> {
  const { namespace, name, tag } = parseOllamaModelReference(ref);
  const repository = `${OLLAMA_REGISTRY}/${namespace}/${name}`;
  const response = await deps.fetch(`${repository}/manifests/${tag}`, {
    headers: { Accept: MANIFEST_MEDIA_TYPE },
  });
  if (!response.ok) {
    throw new OllamaRegistryManifestMissingError(ref, response.status);
  }
  const manifest = (await response.json()) as RegistryManifest;
  const layer = manifest.layers?.find((l) => l.mediaType === MODEL_LAYER_MEDIA_TYPE);
  if (!layer?.digest?.startsWith("sha256:") || typeof layer.size !== "number") {
    throw new OllamaRegistryModelLayerMissingError(ref, MODEL_LAYER_MEDIA_TYPE);
  }
  const sha256 = layer.digest.slice("sha256:".length);
  return {
    reference: ref,
    blobUrl: `${repository}/blobs/${layer.digest}`,
    sha256,
    size: layer.size,
    fileName: `${name}@${tag}-${sha256.slice(0, 12)}.gguf`,
  };
}

/**
 * Download the blob into `destDir/<fileName>` — streamed, sha256-verified and
 * published atomically by `downloadVerifiedFile`. A present file with the
 * matching digest is returned without touching the network.
 */
export async function downloadVerifiedGguf(
  src: OllamaRegistryGgufSource,
  destDir: string,
  deps: OllamaRegistryDeps,
): Promise<string> {
  return downloadVerifiedFile({ url: src.blobUrl, sha256: src.sha256, fileName: src.fileName }, destDir, deps);
}
