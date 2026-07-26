/**
 * Cross-layer well-known identifiers.
 *
 * Payload-level constants every layer agrees on. They live in `contracts`
 * because `infra`, `adapters`, the domain modules and `api` all address the
 * same stored points by them — a constant owned by one domain would force the
 * others to import upward or sideways to name a point they legitimately read.
 */

/** Point id of the per-collection indexing-metadata marker. */
export const INDEXING_METADATA_ID = "__indexing_metadata__";
