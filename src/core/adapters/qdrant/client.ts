/**
 * `QdrantManager` — the adapter's single entry point onto a Qdrant server.
 *
 * This file is the FACADE only. Every consumer in the codebase holds a
 * `QdrantManager` and calls it directly, so its surface is fixed; the work
 * behind that surface is split across seven collaborators over one shared
 * {@link QdrantConnection}, each owning one reason the adapter has to change:
 *
 * | Collaborator                  | Owns                                              |
 * | ----------------------------- | ------------------------------------------------- |
 * | `QdrantConnection`            | client, reconnect, corrupt-collection quarantine  |
 * | `QdrantCollectionAdmin`       | the collection as an object: create/config/delete |
 * | `QdrantPayloadIndexManager`   | payload FIELD indexes                             |
 * | `QdrantPointStore`            | points + their payloads: write, delete, count     |
 * | `QdrantSearchExecutor`        | ranked retrieval: dense, recommend, groups, RRF   |
 * | `QdrantScroller`              | unranked traversal, in its five payload shapes    |
 * | `QdrantSnapshotStore`         | snapshot create / locate / recover / delete       |
 *
 * The cut is by CONCERN, not by endpoint family: `setPayload` sits with the
 * point writes it shares ID normalization with rather than in a payload module,
 * the optimizer-threshold PATCHes sit with the collection config they read back,
 * and the phase-1 scroll inside a batched delete stays in the point store
 * because it is half of a delete, not a read anyone can request.
 *
 * Types the surface exposes (`CollectionInfo`, `SearchResult`,
 * `EmbeddedDaemonProbe`, `SparseVector`) are declared by the collaborator that
 * owns them and re-exported here, so `import { … } from ".../qdrant/client.js"`
 * keeps working unchanged for every consumer.
 */

import type { QdrantClient } from "@qdrant/js-client-rest";

import type { QdrantAliasManager } from "./aliases.js";
import { QdrantCollectionAdmin, type CollectionInfo } from "./collection-admin.js";
import { QdrantConnection, type EmbeddedDaemonProbe } from "./connection.js";
import { QdrantPayloadIndexManager } from "./payload-index.js";
import { QdrantPointStore } from "./point-store.js";
import { QdrantScroller } from "./scroller.js";
import { QdrantSearchExecutor, type SearchResult } from "./search-executor.js";
import { QdrantSnapshotStore } from "./snapshots.js";
import type { SparseVector } from "./types.js";

export type { CollectionInfo, EmbeddedDaemonProbe, SearchResult, SparseVector };

export class QdrantManager {
  private readonly connection: QdrantConnection;
  private readonly collections: QdrantCollectionAdmin;
  private readonly payloadIndexes: QdrantPayloadIndexManager;
  private readonly points: QdrantPointStore;
  private readonly searcher: QdrantSearchExecutor;
  private readonly scroller: QdrantScroller;
  private readonly snapshots: QdrantSnapshotStore;

  constructor(
    url = "http://localhost:6333",
    apiKey?: string,
    reconnect?: () => Promise<string | null>,
    daemon?: EmbeddedDaemonProbe,
  ) {
    this.connection = new QdrantConnection(url, apiKey, reconnect, daemon);
    this.collections = new QdrantCollectionAdmin(this.connection);
    this.payloadIndexes = new QdrantPayloadIndexManager(this.connection);
    this.points = new QdrantPointStore(this.connection);
    // Bound to THIS method, not to `collections.getCollectionInfo`: the search
    // methods self-called `this.getCollectionInfo` when they lived on this class,
    // so the lookup must stay late-bound through the facade to keep that seam.
    this.searcher = new QdrantSearchExecutor(this.connection, async (name) => this.getCollectionInfo(name));
    this.scroller = new QdrantScroller(this.connection);
    this.snapshots = new QdrantSnapshotStore(this.connection);
  }

  /**
   * The live REST client, kept addressable on the facade because `scroll.ts`
   * reaches through a `QdrantManager` for it and specs swap it for a stub.
   * Both directions go to the connection, which is the single source of truth —
   * a client swapped here is the one every collaborator uses on its next call.
   */
  private get client(): QdrantClient {
    return this.connection.client;
  }

  private set client(next: QdrantClient) {
    this.connection.client = next;
  }

  // ── Connection ──

  get url(): string {
    return this.connection.url;
  }

  /**
   * True when this manager fronts the embedded Qdrant daemon (a daemon probe was
   * injected at construction). `url` then holds the daemon's ephemeral port,
   * which can change on restart — callers that persist connection intent should
   * record this flag rather than freezing the port. See CollectionEntry.qdrantEmbedded.
   */
  get isEmbedded(): boolean {
    return this.connection.daemon !== undefined;
  }

  get aliases(): QdrantAliasManager {
    return this.connection.aliases;
  }

  /** Lightweight health check — returns true if Qdrant is reachable. */
  async checkHealth(): Promise<boolean> {
    return this.connection.checkHealth();
  }

  /** Reported version of the running server, or `undefined` on ANY failure. */
  async getServerVersion(): Promise<string | undefined> {
    return this.connection.getServerVersion();
  }

  // ── Collection lifecycle + configuration ──

  async createCollection(
    name: string,
    vectorSize: number,
    distance: "Cosine" | "Euclid" | "Dot" = "Cosine",
    enableSparse = false,
    quantizationScalar = false,
    turboQuant = false,
    strictMode?: { maxResidentMemoryPercent?: number; searchMaxBatchsize?: number },
  ): Promise<void> {
    return this.collections.createCollection(
      name,
      vectorSize,
      distance,
      enableSparse,
      quantizationScalar,
      turboQuant,
      strictMode,
    );
  }

  async collectionExists(name: string): Promise<boolean> {
    return this.collections.collectionExists(name);
  }

  async listCollections(): Promise<string[]> {
    return this.collections.listCollections();
  }

  async getCollectionInfo(name: string): Promise<CollectionInfo> {
    return this.collections.getCollectionInfo(name);
  }

  /** Live health status, or "unknown" on ANY failure (never throws). */
  async getCollectionStatus(name: string): Promise<"green" | "yellow" | "red" | "unknown"> {
    return this.collections.getCollectionStatus(name);
  }

  async getQuantizationConfig(name: string): Promise<unknown> {
    return this.collections.getQuantizationConfig(name);
  }

  async getStrictModeConfig(name: string): Promise<unknown> {
    return this.collections.getStrictModeConfig(name);
  }

  async deleteCollection(name: string): Promise<void> {
    return this.collections.deleteCollection(name);
  }

  async updateCollectionSparseConfig(collectionName: string): Promise<void> {
    return this.collections.updateCollectionSparseConfig(collectionName);
  }

  async updateCollectionQuantization(collectionName: string): Promise<void> {
    return this.collections.updateCollectionQuantization(collectionName);
  }

  async updateCollectionStrictMode(
    collectionName: string,
    strictMode: { maxResidentMemoryPercent?: number; searchMaxBatchsize?: number },
  ): Promise<void> {
    return this.collections.updateCollectionStrictMode(collectionName, strictMode);
  }

  /** Pause HNSW indexing and segment vacuum for the duration of a bulk reindex. */
  async pauseOptimizer(collectionName: string): Promise<void> {
    return this.collections.pauseOptimizer(collectionName);
  }

  /** Restore optimizer thresholds, which also triggers the single post-index pass. */
  async resumeOptimizer(
    collectionName: string,
    options: { indexingThreshold?: number; deletedThreshold?: number } = {},
  ): Promise<void> {
    return this.collections.resumeOptimizer(collectionName, options);
  }

  /** On-disk bytes for an EMBEDDED collection; `undefined` for external Qdrant or on any error. */
  async getCollectionDiskBytes(collectionName: string): Promise<number | undefined> {
    return this.collections.getCollectionDiskBytes(collectionName);
  }

  // ── Payload field indexes ──

  async createPayloadIndex(
    collectionName: string,
    fieldName: string,
    fieldSchema: "keyword" | "integer" | "float" | "bool" | "geo" | "datetime" | "text" | "uuid",
  ): Promise<void> {
    return this.payloadIndexes.createPayloadIndex(collectionName, fieldName, fieldSchema);
  }

  async hasPayloadIndex(collectionName: string, fieldName: string): Promise<boolean> {
    return this.payloadIndexes.hasPayloadIndex(collectionName, fieldName);
  }

  /** Idempotent create — true when the index was missing and got created. */
  async ensurePayloadIndex(
    collectionName: string,
    fieldName: string,
    fieldSchema: "keyword" | "integer" | "float" | "bool" | "geo" | "datetime" | "text" | "uuid",
  ): Promise<boolean> {
    return this.payloadIndexes.ensurePayloadIndex(collectionName, fieldName, fieldSchema);
  }

  // ── Points + payloads ──

  async countPoints(collectionName: string, filter?: Record<string, unknown>): Promise<number> {
    return this.points.countPoints(collectionName, filter);
  }

  async getPoint(
    collectionName: string,
    id: string | number,
  ): Promise<{ id: string | number; payload?: Record<string, unknown> } | null> {
    return this.points.getPoint(collectionName, id);
  }

  async addPoints(
    collectionName: string,
    points: {
      id: string | number;
      vector: number[];
      payload?: Record<string, unknown>;
    }[],
  ): Promise<void> {
    return this.points.addPoints(collectionName, points);
  }

  /** Bulk variant of {@link addPoints}: `wait: false` + weak ordering by default. */
  async addPointsOptimized(
    collectionName: string,
    points: {
      id: string | number;
      vector: number[];
      payload?: Record<string, unknown>;
    }[],
    options: {
      wait?: boolean;
      ordering?: "weak" | "medium" | "strong";
    } = {},
  ): Promise<void> {
    return this.points.addPointsOptimized(collectionName, points, options);
  }

  /** Adds points with both dense and sparse vectors for hybrid search. */
  async addPointsWithSparse(
    collectionName: string,
    points: {
      id: string | number;
      vector: number[];
      sparseVector: SparseVector;
      payload?: Record<string, unknown>;
    }[],
  ): Promise<void> {
    return this.points.addPointsWithSparse(collectionName, points);
  }

  /** Bulk variant of {@link addPointsWithSparse}: `wait: false` + weak ordering by default. */
  async addPointsWithSparseOptimized(
    collectionName: string,
    points: {
      id: string | number;
      vector: number[];
      sparseVector: SparseVector;
      payload?: Record<string, unknown>;
    }[],
    options: {
      wait?: boolean;
      ordering?: "weak" | "medium" | "strong";
    } = {},
  ): Promise<void> {
    return this.points.addPointsWithSparseOptimized(collectionName, points, options);
  }

  async deletePoints(collectionName: string, ids: (string | number)[]): Promise<void> {
    return this.points.deletePoints(collectionName, ids);
  }

  async deletePointsByFilter(collectionName: string, filter: Record<string, unknown>): Promise<void> {
    return this.points.deletePointsByFilter(collectionName, filter);
  }

  /** Delete every point of N paths in ONE request, via an OR filter. */
  async deletePointsByPaths(collectionName: string, relativePaths: string[]): Promise<void> {
    return this.points.deletePointsByPaths(collectionName, relativePaths);
  }

  /** Phase-separated delete: one read pass to collect IDs, then parallel ID deletes. */
  async deletePointsByPathsBatched(
    collectionName: string,
    relativePaths: string[],
    options: {
      batchSize: number;
      concurrency: number;
      onProgress?: (deleted: number, total: number) => void;
    },
  ): Promise<{ deletedPaths: number; batchCount: number; durationMs: number }> {
    return this.points.deletePointsByPathsBatched(collectionName, relativePaths, options);
  }

  /** Update payload fields on existing points WITHOUT re-uploading vectors. */
  async setPayload(
    collectionName: string,
    payload: Record<string, unknown>,
    options: {
      points?: (string | number)[];
      filter?: Record<string, unknown>;
      wait?: boolean;
      ordering?: "weak" | "medium" | "strong";
    },
  ): Promise<void> {
    return this.points.setPayload(collectionName, payload, options);
  }

  /** Fold multiple setPayload operations into batched `batchUpdate` requests. */
  async batchSetPayload(
    collectionName: string,
    operations: {
      payload: Record<string, unknown>;
      points: (string | number)[];
      key?: string;
    }[],
    options: {
      wait?: boolean;
      ordering?: "weak" | "medium" | "strong";
    } = {},
  ): Promise<void> {
    return this.points.batchSetPayload(collectionName, operations, options);
  }

  /** Delete payload keys from all points (or filtered subset). */
  async deletePayloadKeys(collectionName: string, keys: string[], filter?: Record<string, unknown>): Promise<void> {
    return this.points.deletePayloadKeys(collectionName, keys, filter);
  }

  // ── Ranked retrieval ──

  async search(
    collectionName: string,
    vector: number[],
    limit = 5,
    filter?: Record<string, unknown>,
  ): Promise<SearchResult[]> {
    return this.searcher.search(collectionName, vector, limit, filter);
  }

  /** Universal query() with a recommend sub-query — backs find_similar. */
  async query(
    collectionName: string,
    options: {
      positive: (string | number | number[])[];
      negative?: (string | number | number[])[];
      strategy?: "best_score" | "average_vector" | "sum_scores";
      limit: number;
      offset?: number;
      filter?: Record<string, unknown>;
    },
  ): Promise<{ id: string | number; score: number; payload?: Record<string, unknown> }[]> {
    return this.searcher.query(collectionName, options);
  }

  /** Server-side grouping by a payload field (file-level dedup). */
  async queryGroups(
    collectionName: string,
    vector: number[],
    options: {
      groupBy: string;
      groupSize?: number;
      limit: number;
      filter?: Record<string, unknown>;
    },
  ): Promise<SearchResult[]> {
    return this.searcher.queryGroups(collectionName, vector, options);
  }

  /** Dense + sparse retrieval fused server-side by RRF, optionally weighted. */
  async hybridSearch(
    collectionName: string,
    denseVector: number[],
    sparseVector: SparseVector,
    fetchLimit: number,
    filter?: Record<string, unknown>,
    semanticWeight?: number,
  ): Promise<SearchResult[]> {
    return this.searcher.hybridSearch(collectionName, denseVector, sparseVector, fetchLimit, filter, semanticWeight);
  }

  // ── Traversal ──

  /** Scroll every point with payload AND vectors, yielding batches. */
  scrollWithVectors(
    collectionName: string,
    batchSize = 100,
  ): AsyncGenerator<{ id: string | number; payload: Record<string, unknown>; vector: unknown }[]> {
    return this.scroller.scrollWithVectors(collectionName, batchSize);
  }

  /** Distinct values of one payload field across the collection. */
  async scrollFieldValues(collectionName: string, fieldName: string): Promise<string[]> {
    return this.scroller.scrollFieldValues(collectionName, fieldName);
  }

  /** Scroll ordered by a payload field (Qdrant 1.8+; index the field). */
  async scrollOrdered(
    collectionName: string,
    orderBy: { key: string; direction: "asc" | "desc" },
    limit: number,
    filter?: Record<string, unknown>,
  ): Promise<{ id: string | number; payload: Record<string, unknown> }[]> {
    return this.scroller.scrollOrdered(collectionName, orderBy, limit, filter);
  }

  /** Paginated filtered scroll, hard-capped at `limit`, optionally payload-narrowed. */
  async scrollFiltered(
    collectionName: string,
    filter: Record<string, unknown>,
    limit: number,
    pageSize?: number,
    payloadInclude?: string[],
  ): Promise<{ id: string | number; payload: Record<string, unknown> }[]> {
    return this.scroller.scrollFiltered(collectionName, filter, limit, pageSize, payloadInclude);
  }

  /** Hydrate an exact set of symbolIds in one scroll — backs trace_path. */
  async scrollBySymbolIds(
    collectionName: string,
    symbolIds: string[],
    limit = 1024,
  ): Promise<{ id: string | number; payload: Record<string, unknown> }[]> {
    return this.scroller.scrollBySymbolIds(collectionName, symbolIds, limit);
  }

  // ── Snapshots ──

  async createSnapshot(name: string): Promise<string> {
    return this.snapshots.createSnapshot(name);
  }

  snapshotDownloadUrl(collection: string, snapshotName: string): string {
    return this.snapshots.snapshotDownloadUrl(collection, snapshotName);
  }

  async recoverFromSnapshot(targetCollection: string, location: string): Promise<void> {
    return this.snapshots.recoverFromSnapshot(targetCollection, location);
  }

  async deleteSnapshot(collection: string, snapshotName: string): Promise<void> {
    return this.snapshots.deleteSnapshot(collection, snapshotName);
  }
}
