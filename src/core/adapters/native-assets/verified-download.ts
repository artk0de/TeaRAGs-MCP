// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * One sha256-verified download, published atomically: bytes stream into
 * `<file>.partial` while hashed, and only a matching digest is renamed into
 * place. Shared by every installer that fetches a native binary or model
 * weights.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { NativeAssetDownloadError, NativeAssetIntegrityError } from "./errors.js";

export interface VerifiedFileSource {
  url: string;
  /** Lowercase hex. */
  sha256: string;
  fileName: string;
}

export interface NativeAssetDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Streamed — an asset can be hundreds of MiB, never read whole into memory. Undefined when absent. */
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
 * Download `src.url` into `destDir/<fileName>`. A failed request or transfer
 * throws {@link NativeAssetDownloadError}; a mismatch deletes the partial and
 * throws {@link NativeAssetIntegrityError}. A present file with the matching
 * digest is returned without touching the network.
 */
export async function downloadVerifiedFile(
  src: VerifiedFileSource,
  destDir: string,
  deps: NativeAssetDeps,
): Promise<string> {
  const finalPath = join(destDir, src.fileName);
  if ((await fileSha256(finalPath)) === src.sha256) return finalPath;

  await mkdir(destDir, { recursive: true });
  let response: Response;
  try {
    response = await deps.fetch(src.url, { redirect: "follow" });
  } catch (error) {
    throw new NativeAssetDownloadError(src.url, "request failed", error as Error);
  }
  if (!response.ok || !response.body) {
    throw new NativeAssetDownloadError(src.url, `status ${response.status}`);
  }

  const partialPath = `${finalPath}.partial`;
  const hash = createHash("sha256");
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on("data", (piece: Buffer) => hash.update(piece));
  try {
    await pipeline(body, createWriteStream(partialPath));
  } catch (error) {
    await rm(partialPath, { force: true });
    throw new NativeAssetDownloadError(src.url, "transfer interrupted", error as Error);
  }

  const actual = hash.digest("hex");
  if (actual !== src.sha256) {
    await rm(partialPath, { force: true });
    throw new NativeAssetIntegrityError({ fileName: src.fileName, url: src.url, expected: src.sha256, actual });
  }
  await rename(partialPath, finalPath);
  return finalPath;
}
