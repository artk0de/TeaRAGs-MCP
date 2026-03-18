/**
 * Collection name resolution and path validation utilities.
 *
 * Foundation layer — stateless pure functions used by all layers.
 * Moved from ingest/collection.ts to fix layer violations.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

import { CollectionNotProvidedError } from "../api/errors.js";

/**
 * Validate path — resolves to realpath if exists, absolute path otherwise.
 */
export async function validatePath(path: string): Promise<string> {
  const absolutePath = resolve(path);
  try {
    return await fs.realpath(absolutePath);
  } catch {
    return absolutePath;
  }
}

/**
 * Generate deterministic collection name from codebase path.
 */
export function resolveCollectionName(path: string): string {
  const absolutePath = resolve(path);
  const hash = createHash("md5").update(absolutePath).digest("hex");
  return `code_${hash.substring(0, 8)}`;
}

/**
 * Resolve collection name from either explicit name or path.
 *
 * Callers must validate that at least one of collection/path is provided
 * before calling this function (throw CollectionNotProvidedError from api/errors).
 */
export function resolveCollection(collection?: string, path?: string): { collectionName: string; path?: string } {
  if (!collection && !path) {
    throw new CollectionNotProvidedError();
  }
  const collectionName = collection || resolveCollectionName(path as string);
  return { collectionName, path };
}
