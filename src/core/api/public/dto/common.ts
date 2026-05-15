/**
 * Shared DTO primitives reused across domain DTOs.
 */

/**
 * Shared mixin for any DTO that addresses a single collection.
 * Resolution priority: collection > project > path.
 */
export interface CollectionIdentifier {
  collection?: string;
  project?: string;
  path?: string;
}
