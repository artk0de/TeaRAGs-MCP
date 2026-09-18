/**
 * Schema Migration for Qdrant Collections
 *
 * Handles automatic migration of collection schema (payload indexes, etc.)
 * when new versions are deployed.
 *
 * Schema versions:
 * - v1-v3: No payload indexes (implicit)
 * - v4: Added keyword index on `relativePath` for faster filter-based deletes
 *   (replaced by the v5 text index on the same key — see TEXT_INDEXED_KEYS)
 * - v5: Added text index on `relativePath` for glob pre-filter
 * - v6: Added keyword indexes on `language`, `fileExtension`, `chunkType`
 * - v7: Enable sparse vectors on non-hybrid collections (when enableHybrid=true)
 * - v8: Added text index on `symbolId` for partial match filtering
 */

import type { QdrantManager } from "../qdrant/client.js";
import { TEXT_INDEXED_KEYS } from "./filters/text-indexed-exact.js";
import { SchemaMetadataPointStore } from "./schema-metadata-point.js";

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
 *
 * `schema-v15-codegraph-filter-indexes` applies the identical list to
 * collections that already exist — this loop only reaches collections created
 * after it was added, and every index has to exist on both paths (pinned by
 * `tests/core/adapters/qdrant/schema-manager-migrations-parity.test.ts`).
 */
export const CODEGRAPH_FILTER_INDEXES: readonly { readonly path: string; readonly schema: IndexSchema }[] = [
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

/** Payload keys filtered by exact value, each carrying a `keyword` index (schema v6). */
export const KEYWORD_FILTER_INDEX_KEYS = ["language", "fileExtension", "chunkType"] as const;

/**
 * Every payload field {@link SchemaManager.initializeSchema} indexes — and,
 * by the initializeSchema ⟺ migrations parity, every field a schema migration
 * ensures on an existing collection.
 *
 * `schema-v16-drop-undeclared-payload-indexes` treats these as declared no
 * matter what the trajectories declare: they are the schema pipeline's own
 * indexes, several of them on keys no payload signal descriptor names
 * (`_type`, the `enrichedAt` / `skippedAs` bookkeeping fields). Pinned against
 * initializeSchema by `tests/core/adapters/qdrant/schema-manager.test.ts`.
 */
export const SCHEMA_MANAGED_PAYLOAD_INDEX_KEYS: readonly string[] = [
  ...TEXT_INDEXED_KEYS,
  ...KEYWORD_FILTER_INDEX_KEYS,
  ...CODEGRAPH_FILTER_INDEXES.map(({ path }) => path),
  ...ENRICHMENT_SCAN_INDEXES.map(({ path }) => path),
];

/**
 * SchemaManager - Handles collection schema versioning and migrations
 */
export class SchemaManager {
  private readonly metadataPoint: SchemaMetadataPointStore;

  constructor(
    private readonly qdrant: QdrantManager,
    private readonly schemaVersion: number,
    private readonly sparseVersion = 0,
  ) {
    this.metadataPoint = new SchemaMetadataPointStore(qdrant);
  }

  /**
   * Stamp the creation versions onto the collection's schema metadata point.
   */
  private async storeSchemaMetadata(collectionName: string, version: number, indexes: string[]): Promise<void> {
    try {
      await this.metadataPoint.setCreationVersions(collectionName, {
        schemaVersion: version,
        sparseVersion: this.sparseVersion,
        indexes,
      });
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

    // `relativePath` (glob pre-filter), `symbolId` and `parentSymbolId`
    // (partial match) are TEXT-indexed. Qdrant keeps ONE index per key, so the
    // keyword index this loop used to create on `relativePath` first was
    // replaced by the text index a line later — dead, while leaving the belief
    // that `match.value` was served. It is not: exact matching on any of these
    // keys rides the text index as a text+value PAIR through
    // `exactMatchOnTextIndexed`, which is why the key list lives beside that
    // matcher rather than here (tea-rags-mcp-ivp12).
    //
    // `parentSymbolId` is also created by schema-v11 on collections that predate
    // the rename; a fresh collection never runs that migration, so this loop is
    // the only path that gives it to one.
    for (const key of TEXT_INDEXED_KEYS) {
      await this.qdrant.createPayloadIndex(collectionName, key, "text");
      indexes.push(key);
    }

    // Create keyword indexes on frequently filtered fields
    for (const field of KEYWORD_FILTER_INDEX_KEYS) {
      await this.qdrant.createPayloadIndex(collectionName, field, "keyword");
      indexes.push(field);
    }

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
