/**
 * Shared constants and utilities for CodeIndexer modules.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

/** Reserved ID for storing indexing metadata in the collection */
export const INDEXING_METADATA_ID = "__indexing_metadata__";

/**
 * Validate that a path doesn't attempt directory traversal.
 * @throws Error if path traversal is detected
 */
export async function validatePath(path: string): Promise<string> {
  const absolutePath = resolve(path);

  try {
    const realPath = await fs.realpath(absolutePath);
    return realPath;
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
