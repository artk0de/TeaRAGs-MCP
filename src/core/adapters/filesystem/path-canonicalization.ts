/**
 * Path canonicalization against the local disk — the I/O half of the
 * path → collection rule.
 *
 * Adapter layer (`adapters/filesystem/`): `realpath` asks the local filesystem,
 * so it cannot sit with the pure identity rule in
 * `primitives/ids/collection-identity.ts`, which this module composes with.
 */

import { promises as fs, realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { CollectionAlias } from "../../contracts/types/collection-identity.js";
import { resolveCollectionName } from "../../primitives/ids/index.js";

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
 * {@link validatePath}'s synchronous twin — same rule, same fallback. Kept as a
 * separate function rather than having the async one delegate, so the hot async
 * callers keep a non-blocking realpath.
 *
 * Exists for `resolveCollection`, which is synchronous because it sits on the
 * serving query path and must canonicalize before it compares a spelling
 * against the registry (bd tea-rags-mcp-dxa9w). The two MUST stay identical:
 * a difference here is a path that resolves to one collection when written and
 * another when read.
 */
export function validatePathSync(path: string): string {
  const absolutePath = resolve(path);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
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
export async function hashCollectionForPath(path: string): Promise<CollectionAlias> {
  return resolveCollectionName(await validatePath(path));
}
