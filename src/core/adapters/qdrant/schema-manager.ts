/**
 * Schema Migration for Qdrant Collections
 *
 * Handles automatic migration of collection schema (payload indexes, etc.)
 * when new versions are deployed.
 *
 * Schema versions:
 * - v1-v3: No payload indexes (implicit)
 * - v4: Added keyword index on `relativePath` for faster filter-based deletes
 * - v5: Added text index on `relativePath` for glob pre-filter
 * - v6: Added keyword indexes on `language`, `fileExtension`, `chunkType`
 * - v7: Enable sparse vectors on non-hybrid collections (when enableHybrid=true)
 * - v8: Added text index on `symbolId` for partial match filtering
 */

import type { QdrantManager } from "../qdrant/client.js";

/** Reserved ID for storing schema metadata in the collection */
const SCHEMA_METADATA_ID = "__schema_metadata__";

/**
 * Qdrant payload field-schema type accepted by `createPayloadIndex`.
 */
type IndexSchema = "keyword" | "integer" | "float" | "bool" | "datetime";

/**
 * Codegraph filterable payload paths that need a Qdrant field index so the
 * typed filter params (`minFanIn`, `isHub`, …) actually match at query time.
 *
 * The codegraph payload is nested: `EnrichmentApplier` writes signals via
 * `batchSetPayload` with `key: "codegraph.symbols.{file,chunk}"`, and each leaf
 * is a BARE name (`fanIn`, `isHub`, …) — buildFileSignals/buildChunkSignals
 * write them without a `codegraph.{level}.` prefix (tea-rags-mcp-k6xu). Qdrant
 * treats dotted keys as nested-path navigation, so on disk the value lives at
 * `codegraph -> symbols -> {file|chunk} -> X`. The addressable field path is
 * therefore `codegraph.symbols.{level}.X` — a single prefix.
 *
 * These strings MUST stay byte-identical to the `key:` values emitted by
 * `codegraphFilters` (src/core/domains/trajectory/codegraph/symbols/filters.ts)
 * — the index path and the filter path must match exactly or Qdrant never uses
 * the index and the filter returns zero results (bd tea-rags-mcp-6yb8 +
 * tea-rags-mcp-k6xu). The adapter layer cannot import the domain descriptors
 * (domain-boundaries rule), so the list is mirrored here; keep both in lockstep
 * when adding a signal OR changing the inner-key shape.
 */
const CODEGRAPH_FILTER_INDEXES: readonly { readonly path: string; readonly schema: IndexSchema }[] = [
  { path: "codegraph.symbols.file.fanIn", schema: "integer" },
  { path: "codegraph.symbols.file.fanOut", schema: "integer" },
  { path: "codegraph.symbols.file.connectionCount", schema: "integer" },
  { path: "codegraph.symbols.file.transitiveImpact", schema: "integer" },
  { path: "codegraph.symbols.file.instability", schema: "float" },
  { path: "codegraph.symbols.file.isHub", schema: "bool" },
  { path: "codegraph.symbols.file.isLeaf", schema: "bool" },
  { path: "codegraph.symbols.chunk.fanIn", schema: "integer" },
  { path: "codegraph.symbols.chunk.fanOut", schema: "integer" },
  { path: "codegraph.symbols.chunk.pageRank", schema: "float" },
];

/**
 * Payload paths the ENRICHMENT RUN filters on to do its own bookkeeping — not
 * a query-time surface, which is why they are easy to miss.
 *
 * Two filters, both built per provider key and level:
 *
 *  - `EnrichmentRecovery#buildUnenrichedFilter` — `is_empty(<p>.<lvl>.enrichedAt)
 *    AND is_empty(<p>.<lvl>.skippedAs)`, the two terminal states of the settle
 *    decision, plus the `_type` exclusions. Runs twice per provider per run
 *    (once per level) behind the terminal markers.
 *  - `EnrichmentCoordinator#scrollStoredChunks` — the recompute's chunk-set
 *    read, sharing the same `_type` exclusions.
 *
 * Qdrant evaluates an UNINDEXED condition by fetching the payload of every
 * candidate point, so an unindexed field here does not fail — it silently turns
 * each of those filters into a full scan. Measured on taxdome (116,013 points,
 * green, idle) before/after creating these:
 *
 *  - recompute scroll, 39,202 TS chunks over 197 pages: 6,324 ms → 716 ms
 *    (all of it the two `_type` conditions)
 *  - `codegraph.symbols` file-level unenriched scan: 3,274 ms → 6 ms
 *  - `codegraph.symbols` chunk-level unenriched scan: 3,450 ms → 3 ms
 *  - `git` file-level unenriched scan: 2,403 ms → 5 ms
 *
 * Mirrored here rather than derived, for the same reason as
 * {@link CODEGRAPH_FILTER_INDEXES}: the adapter layer cannot import the
 * enrichment domain. `schema-v14-enrichment-scan-indexes` applies the identical
 * list to collections that already exist;
 * `tests/…/schema-v14-enrichment-scan-indexes.test.ts` pins the list against
 * the filter the domain actually builds, so a new provider key or level cannot
 * drift away unnoticed.
 */
export const ENRICHMENT_SCAN_INDEXES: readonly { readonly path: string; readonly schema: IndexSchema }[] = [
  { path: "_type", schema: "keyword" },
  { path: "git.file.enrichedAt", schema: "datetime" },
  { path: "git.file.skippedAs", schema: "keyword" },
  { path: "git.chunk.enrichedAt", schema: "datetime" },
  { path: "git.chunk.skippedAs", schema: "keyword" },
  { path: "codegraph.symbols.file.enrichedAt", schema: "datetime" },
  { path: "codegraph.symbols.file.skippedAs", schema: "keyword" },
  { path: "codegraph.symbols.chunk.enrichedAt", schema: "datetime" },
  { path: "codegraph.symbols.chunk.skippedAs", schema: "keyword" },
];

/**
 * Schema metadata stored in collection
 */
interface SchemaMetadata {
  _type: "schema_metadata";
  schemaVersion: number;
  migratedAt: string;
  indexes: string[];
  sparseVersion?: number;
}

/**
 * SchemaManager - Handles collection schema versioning and migrations
 */
export class SchemaManager {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly schemaVersion: number,
    private readonly sparseVersion = 0,
  ) {}

  /**
   * Store schema metadata in collection
   */
  private async storeSchemaMetadata(collectionName: string, version: number, indexes: string[]): Promise<void> {
    try {
      // Get collection info to create appropriate zero vector
      const info = await this.qdrant.getCollectionInfo(collectionName);
      const zeroVector: number[] = new Array<number>(info.vectorSize).fill(0);

      const payload: SchemaMetadata = {
        _type: "schema_metadata",
        schemaVersion: version,
        sparseVersion: this.sparseVersion,
        migratedAt: new Date().toISOString(),
        indexes,
      };

      if (info.hybridEnabled) {
        await this.qdrant.addPointsWithSparse(collectionName, [
          {
            id: SCHEMA_METADATA_ID,
            vector: zeroVector,
            sparseVector: { indices: [], values: [] },
            payload: payload as unknown as Record<string, unknown>,
          },
        ]);
      } else {
        await this.qdrant.addPoints(collectionName, [
          {
            id: SCHEMA_METADATA_ID,
            vector: zeroVector,
            payload: payload as unknown as Record<string, unknown>,
          },
        ]);
      }
    } catch (error) {
      // Non-fatal: log but don't fail
      console.error("Failed to store schema metadata:", error);
    }
  }

  /**
   * Initialize schema for a new collection
   * Creates all required indexes upfront
   */
  async initializeSchema(collectionName: string): Promise<void> {
    const indexes: string[] = [];

    // Create relativePath keyword index for fast filter-based operations
    await this.qdrant.createPayloadIndex(collectionName, "relativePath", "keyword");
    indexes.push("relativePath");

    // Create relativePath text index for glob pre-filter (was missing for new collections)
    await this.qdrant.createPayloadIndex(collectionName, "relativePath", "text");

    // Create keyword indexes on frequently filtered fields
    for (const field of ["language", "fileExtension", "chunkType"] as const) {
      await this.qdrant.createPayloadIndex(collectionName, field, "keyword");
      indexes.push(field);
    }

    // Create text index on symbolId for partial match filtering
    await this.qdrant.createPayloadIndex(collectionName, "symbolId", "text");

    // Create indexes on codegraph filterable paths so typed filter params
    // (minFanIn/isHub/...) match at query time. The nested paths mirror the
    // keys emitted by codegraphFilters — see CODEGRAPH_FILTER_INDEXES.
    for (const { path, schema } of CODEGRAPH_FILTER_INDEXES) {
      await this.qdrant.createPayloadIndex(collectionName, path, schema);
      indexes.push(path);
    }

    // Create indexes the enrichment run's own scans filter on. A new collection
    // is stamped at the LATEST schema version below, so schema-v12/v14 are
    // filtered out as already-applied and never run against it — without this
    // loop a force-rebuilt collection carries none of them for its whole life.
    // That is what happened to taxdome's `_v13`: schemaVersion 13, zero
    // enrichedAt indexes, every unenriched scan a full payload scan.
    for (const { path, schema } of ENRICHMENT_SCAN_INDEXES) {
      await this.qdrant.createPayloadIndex(collectionName, path, schema);
      indexes.push(path);
    }

    // Store schema metadata
    await this.storeSchemaMetadata(collectionName, this.schemaVersion, indexes);
  }
}
