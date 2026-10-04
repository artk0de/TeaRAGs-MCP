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

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

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
  if (trimmed === "") throw new Error("Empty Ollama model reference");
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
    throw new Error(`Ollama registry has no manifest for ${ref} (status ${response.status})`);
  }
  const manifest = (await response.json()) as RegistryManifest;
  const layer = manifest.layers?.find((l) => l.mediaType === MODEL_LAYER_MEDIA_TYPE);
  if (!layer?.digest?.startsWith("sha256:") || typeof layer.size !== "number") {
    throw new Error(`Ollama manifest for ${ref} has no ${MODEL_LAYER_MEDIA_TYPE} layer`);
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

/** Streamed — a GGUF is hundreds of MiB, never read whole into memory. Undefined when absent. */
async function fileSha256(path: string): Promise<string | undefined> {
  const hash = createHash("sha256");
  try {
    for await (const piece of createReadStream(path)) hash.update(piece as Buffer);
  } catch {
    return undefined;
  }
  return hash.digest("hex");
}

/**
 * Download the blob into `destDir/<fileName>`. Bytes stream into
 * `<file>.partial` while hashed; only a matching digest is renamed into place,
 * a mismatch deletes the partial and throws. A present file with the matching
 * digest is returned without touching the network.
 */
export async function downloadVerifiedGguf(
  src: OllamaRegistryGgufSource,
  destDir: string,
  deps: OllamaRegistryDeps,
): Promise<string> {
  const finalPath = join(destDir, src.fileName);
  if ((await fileSha256(finalPath)) === src.sha256) return finalPath;

  await mkdir(destDir, { recursive: true });
  const response = await deps.fetch(src.blobUrl, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Downloading ${src.reference} from ${src.blobUrl} failed (status ${response.status})`);
  }

  const partialPath = `${finalPath}.partial`;
  const hash = createHash("sha256");
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on("data", (piece: Buffer) => hash.update(piece));
  try {
    await pipeline(body, createWriteStream(partialPath));
  } catch (error) {
    await rm(partialPath, { force: true });
    throw error;
  }

  const actual = hash.digest("hex");
  if (actual !== src.sha256) {
    await rm(partialPath, { force: true });
    throw new Error(`sha256 mismatch for ${src.reference}: expected ${src.sha256}, got ${actual}`);
  }
  await rename(partialPath, finalPath);
  return finalPath;
}
