/**
 * Service points — the points a code collection carries that are not chunks
 * (bd tea-rags-mcp-39xca.12).
 *
 * Two exist: the indexing marker (`INDEXING_METADATA_ID`, created by
 * `storeIndexingMarker` and `EmbeddingModelGuard`) and the schema metadata
 * point (`SchemaMetadataPointStore`). Every path that counts chunks or reads
 * them back — `get_index_status`, `get_index_metrics`, the collection stats,
 * the enrichment recompute and recovery — must leave out the same set, or the
 * numbers disagree by however many service points each path missed. Before
 * this definition existed, status subtracted one and metrics subtracted none.
 *
 * Identified by `_type`, not by point id. Every write that CREATES either point
 * stamps `_type` — both upserts in `storeIndexingMarker`, the guard's create
 * path, `SchemaMetadataPointStore#merge` — and has done so since each id was
 * introduced. Every other write to them is `set_payload`, which cannot create a
 * point. `_type` carries a keyword index (`ENRICHMENT_SCAN_INDEXES`), so
 * excluding by it keeps a filtered count or scroll an index lookup rather than
 * a payload scan.
 *
 * Lives in the Qdrant adapter because the exclusion is Qdrant filter vocabulary
 * (`QdrantMatchCondition`) that `contracts` may not name, and because both
 * consumers of it — `domains/ingest` and `domains/explore` — may import this
 * layer but not each other.
 *
 * A new service point adds its `_type` here, and nowhere else.
 */

import type { SchemaMetadataPayload } from "../../contracts/types/schema-metadata.js";
import type { QdrantMatchCondition } from "./types.js";

const INDEXING_MARKER_TYPE = "indexing_metadata";
const SCHEMA_METADATA_TYPE: SchemaMetadataPayload["_type"] = "schema_metadata";

/** `_type` values that mark a point as a service point. */
export const SERVICE_POINT_TYPES: readonly string[] = [INDEXING_MARKER_TYPE, SCHEMA_METADATA_TYPE];

/** The in-memory form, for points already read back from Qdrant. */
export function isServicePointPayload(payload: Record<string, unknown> | null | undefined): boolean {
  const type = payload?._type;
  return typeof type === "string" && SERVICE_POINT_TYPES.includes(type);
}

/**
 * `must_not` conditions that drop every service point, one per `_type`, so a
 * caller can spread them beside its own exclusions. A fresh array per call.
 */
export function servicePointExclusions(): QdrantMatchCondition[] {
  return SERVICE_POINT_TYPES.map((type) => ({ key: "_type", match: { value: type } }));
}

/** Filter selecting chunk points only — hand it to `countPoints` for a chunk count. */
export function chunkPointsFilter(): { must_not: QdrantMatchCondition[] } {
  return { must_not: servicePointExclusions() };
}
