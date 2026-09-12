/**
 * Collection name resolution and path validation utilities.
 *
 * Foundation layer — stateless pure functions used by all layers. Request
 * resolution (registry lookup, input-validation errors) is NOT here: it needs
 * the api-layer error classes, so it lives in `api/internal/collection-resolver.ts`.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

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
 * The registry-free half of the path → collection rule: canonicalize, then
 * hash. It is what a path NOTHING has registered resolves to, and therefore
 * the injected default wherever a collaborator is handed the rule as a
 * function but no registry is in reach (bd tea-rags-mcp-dxa9w).
 *
 * Not a second rule, and not a shortcut around the first: a caller that can
 * reach the project registry takes `createPathCollectionResolver(registry)`
 * from `api/internal/collection-resolver.ts` instead, which consults the
 * registry and falls back to exactly this. Hashing a path the registry has
 * re-pointed elsewhere addresses a collection nobody ever wrote.
 */
export async function hashCollectionForPath(path: string): Promise<string> {
  return resolveCollectionName(await validatePath(path));
}
