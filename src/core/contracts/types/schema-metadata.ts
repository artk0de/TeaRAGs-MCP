/**
 * Payload of a collection's schema metadata point — the version stamps of the
 * `schema` and `sparse` migration pipelines (`.claude/rules/migrations.md`).
 *
 * The fields belong to different pipelines but share ONE Qdrant point, and a
 * Qdrant upsert replaces the whole payload of the id it writes. Only
 * `SchemaMetadataPointStore` (`adapters/qdrant/schema-metadata-point.ts`)
 * writes the point; it merges each write onto what is stored, so a writer can
 * never erase a field another pipeline owns (bd tea-rags-mcp-906df).
 */
export interface SchemaMetadataPayload {
  _type: "schema_metadata";
  /** Schema pipeline: highest applied schema migration. */
  schemaVersion: number;
  /** Schema pipeline: payload indexes recorded with that version. */
  indexes: string[];
  /** Sparse pipeline: highest applied BM25 migration. Absent until first stamped. */
  sparseVersion?: number;
  /** ISO timestamp of the last write, whichever pipeline made it. */
  migratedAt: string;
}
