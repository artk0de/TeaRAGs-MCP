/**
 * SchemaMetadataPointStore — the one reader-writer of a collection's schema
 * metadata point (bd tea-rags-mcp-906df).
 *
 * `schemaVersion` + `indexes` (schema pipeline) and `sparseVersion` (sparse
 * pipeline) live on one Qdrant point. Three collaborators used to write it,
 * each rebuilding the payload from the fields it knew, and a Qdrant upsert
 * REPLACES the payload of the id it writes — so a schema migration erased the
 * sparse stamp and the next sync paid for a full BM25 rebuild
 * (bd tea-rags-mcp-vy26b). Every write now goes through a per-field setter
 * that merges onto the stored payload.
 *
 * Read-modify-write over the upsert, not a nested `set_payload`: `set_payload`
 * cannot create a point, and the first stamp on a fresh collection has to — the
 * point also needs a zero vector sized to the collection. The read and the
 * upsert are not atomic; that is safe because the pipelines stamping this point
 * run sequentially inside one migration sweep (`runMigrations`), and a
 * collection's creation stamp lands before any sweep can see it.
 *
 * A failed read aborts the write rather than falling back to "no point":
 * merging onto nothing is exactly the blind overwrite this class exists to rule
 * out. Callers decide whether a failed stamp is fatal; all current ones log it.
 *
 * `tests/core/domains/maintenance/migration/schema-metadata-writers.test.ts`
 * pins that every writer preserves the fields it does not own and that no other
 * source file names the point id.
 */

import type { SchemaMetadataPayload } from "../../contracts/types/schema-metadata.js";
import type { QdrantManager } from "./client.js";

/** Reserved point id — named nowhere else in `src/`. */
const SCHEMA_METADATA_POINT_ID = "__schema_metadata__";

/** The version fields a setter may own; `_type` and `migratedAt` are the store's. */
type SchemaMetadataVersionFields = Partial<Pick<SchemaMetadataPayload, "schemaVersion" | "indexes" | "sparseVersion">>;

export class SchemaMetadataPointStore {
  constructor(private readonly qdrant: QdrantManager) {}

  /**
   * The stored payload, or null when the collection has no metadata point.
   * A failed read propagates — "unreadable" and "absent" mean different things
   * to a caller that is about to write.
   */
  async read(collection: string): Promise<SchemaMetadataPayload | null> {
    const point = await this.qdrant.getPoint(collection, SCHEMA_METADATA_POINT_ID);
    if (point?.payload?._type !== "schema_metadata") return null;
    return point.payload as unknown as SchemaMetadataPayload;
  }

  /** Schema pipeline: a migration landed. Owns `schemaVersion` and `indexes`. */
  async setSchemaVersion(collection: string, schemaVersion: number, indexes: string[]): Promise<void> {
    await this.merge(collection, { schemaVersion, indexes });
  }

  /** Sparse pipeline: a BM25 migration landed. Owns `sparseVersion`. */
  async setSparseVersion(collection: string, sparseVersion: number): Promise<void> {
    await this.merge(collection, { sparseVersion });
  }

  /**
   * Collection creation: stamps the latest schema AND sparse versions in one
   * write, because a fresh collection already carries both layers at head.
   */
  async setCreationVersions(
    collection: string,
    versions: { schemaVersion: number; sparseVersion: number; indexes: string[] },
  ): Promise<void> {
    await this.merge(collection, versions);
  }

  private async merge(collection: string, owned: SchemaMetadataVersionFields): Promise<void> {
    const stored = await this.read(collection);
    const info = await this.qdrant.getCollectionInfo(collection);
    const payload: SchemaMetadataPayload = {
      // Defaults only for a point that does not exist yet.
      schemaVersion: 0,
      indexes: [],
      ...stored,
      ...owned,
      _type: "schema_metadata",
      migratedAt: new Date().toISOString(),
    };
    const point = {
      id: SCHEMA_METADATA_POINT_ID,
      vector: new Array<number>(info.vectorSize).fill(0),
      payload: payload as unknown as Record<string, unknown>,
    };

    if (info.hybridEnabled) {
      await this.qdrant.addPointsWithSparse(collection, [{ ...point, sparseVector: { indices: [], values: [] } }]);
    } else {
      await this.qdrant.addPoints(collection, [point]);
    }
  }
}
