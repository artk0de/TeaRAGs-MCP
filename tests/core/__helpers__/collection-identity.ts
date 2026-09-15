/**
 * Fixture names for the collection-identity brands (bd tea-rags-mcp-39xca.1).
 *
 * Production mints `PhysicalCollectionName` / `CollectionAlias` only in
 * `src/core/infra/collection-name.ts`, and lint rejects the cast everywhere
 * else. Tests need literal names without a Qdrant to resolve them against, so
 * this is the ONE test-side place that brands a string — fixtures call these
 * instead of casting.
 */

import type { CollectionAlias, PhysicalCollectionName } from "../../../src/core/contracts/types/collection-identity.js";

/** A literal fixture string treated as a concrete (non-alias) collection. */
export function fixturePhysicalCollectionName(name: string): PhysicalCollectionName {
  return name as PhysicalCollectionName;
}

/** A literal fixture string treated as a project's logical collection name. */
export function fixtureCollectionAlias(name: string): CollectionAlias {
  return name as CollectionAlias;
}
