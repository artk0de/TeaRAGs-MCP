import { createHash } from "node:crypto";
import { QdrantClient } from "@qdrant/js-client-rest";

export interface CollectionInfo {
  name: string;
  vectorSize: number;
  pointsCount: number;
  distance: "Cosine" | "Euclid" | "Dot";
  hybridEnabled?: boolean;
}

export interface SearchResult {
  id: string | number;
  score: number;
  payload?: Record<string, any>;
}

export interface SparseVector {
  indices: number[];
  values: number[];
}

export class QdrantManager {
  private client: QdrantClient;

  constructor(url: string = "http://localhost:6333", apiKey?: string) {
    this.client = new QdrantClient({ url, apiKey });
  }

  /**
   * Converts a string ID to UUID format if it's not already a UUID.
   * Qdrant requires string IDs to be in UUID format.
   */
  private normalizeId(id: string | number): string | number {
    if (typeof id === "number") {
      return id;
    }

    // Check if already a valid UUID (8-4-4-4-12 format)
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(id)) {
      return id;
    }

    // Convert arbitrary string to deterministic UUID v5-like format
    const hash = createHash("sha256").update(id).digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  }

  async createCollection(
    name: string,
    vectorSize: number,
    distance: "Cosine" | "Euclid" | "Dot" = "Cosine",
    enableSparse: boolean = false,
  ): Promise<void> {
    const config: any = {};

    // When hybrid search is enabled, use named vectors
    if (enableSparse) {
      config.vectors = {
        dense: {
          size: vectorSize,
          distance,
        },
      };
      config.sparse_vectors = {
        text: {
          modifier: "idf",
        },
      };
    } else {
      // Standard unnamed vector configuration
      config.vectors = {
        size: vectorSize,
        distance,
      };
    }

    await this.client.createCollection(name, config);
  }

  /**
   * Create a payload index on a field for faster filtering.
   * Supported schemas: "keyword", "integer", "float", "bool", "geo", "datetime", "text", "uuid"
   *
   * IMPORTANT: Indexes should be created immediately after collection setup.
   * Creating them on large existing collections may be slow and block updates.
   */
  async createPayloadIndex(
    collectionName: string,
    fieldName: string,
    fieldSchema: "keyword" | "integer" | "float" | "bool" | "geo" | "datetime" | "text" | "uuid",
  ): Promise<void> {
    await this.client.createPayloadIndex(collectionName, {
      field_name: fieldName,
      field_schema: fieldSchema,
      wait: true,
    });
  }

  /**
   * Check if a payload index exists on a field.
   */
  async hasPayloadIndex(
    collectionName: string,
    fieldName: string,
  ): Promise<boolean> {
    try {
      const info = await this.client.getCollection(collectionName);
      const indexes = info.payload_schema || {};
      return fieldName in indexes;
    } catch {
      return false;
    }
  }

  /**
   * Ensure a payload index exists, creating it if missing.
   * Returns true if index was created, false if already existed.
   */
  async ensurePayloadIndex(
    collectionName: string,
    fieldName: string,
    fieldSchema: "keyword" | "integer" | "float" | "bool" | "geo" | "datetime" | "text" | "uuid",
  ): Promise<boolean> {
    const exists = await this.hasPayloadIndex(collectionName, fieldName);
    if (exists) {
      return false;
    }
    await this.createPayloadIndex(collectionName, fieldName, fieldSchema);
    return true;
  }

  async collectionExists(name: string): Promise<boolean> {
    try {
      await this.client.getCollection(name);
      return true;
    } catch {
      return false;
    }
  }

  async listCollections(): Promise<string[]> {
    const response = await this.client.getCollections();
    return response.collections.map((c) => c.name);
  }

  async getCollectionInfo(name: string): Promise<CollectionInfo> {
    const info = await this.client.getCollection(name);
    const vectorConfig = info.config.params.vectors;

    // Handle both named and unnamed vector configurations
    let size = 0;
    let distance: "Cosine" | "Euclid" | "Dot" = "Cosine";
    let hybridEnabled = false;

    // Check if sparse vectors are configured
    if (info.config.params.sparse_vectors) {
      hybridEnabled = true;
    }

    if (typeof vectorConfig === "object" && vectorConfig !== null) {
      // Check for unnamed vector config (has 'size' directly)
      if ("size" in vectorConfig) {
        size = typeof vectorConfig.size === "number" ? vectorConfig.size : 0;
        distance = vectorConfig.distance as "Cosine" | "Euclid" | "Dot";
      } else if ("dense" in vectorConfig) {
        // Named vector config for hybrid search
        const denseConfig = vectorConfig.dense as any;
        size = typeof denseConfig.size === "number" ? denseConfig.size : 0;
        distance = denseConfig.distance as "Cosine" | "Euclid" | "Dot";
      }
    }

    return {
      name,
      vectorSize: size,
      pointsCount: info.points_count || 0,
      distance,
      hybridEnabled,
    };
  }

  async deleteCollection(name: string): Promise<void> {
    await this.client.deleteCollection(name);
  }

  async addPoints(
    collectionName: string,
    points: Array<{
      id: string | number;
      vector: number[];
      payload?: Record<string, any>;
    }>,
  ): Promise<void> {
    // Guard against empty arrays - Qdrant throws "Empty update request"
    if (points.length === 0) {
      return;
    }

    try {
      // Normalize all IDs to ensure string IDs are in UUID format
      const normalizedPoints = points.map((point) => ({
        ...point,
        id: this.normalizeId(point.id),
      }));

      await this.client.upsert(collectionName, {
        wait: true,
        points: normalizedPoints,
      });
    } catch (error: any) {
      const errorMessage =
        error?.data?.status?.error || error?.message || String(error);
      throw new Error(
        `Failed to add points to collection "${collectionName}": ${errorMessage}`,
      );
    }
  }

  /**
   * Optimized addPoints for bulk uploads.
   * Uses wait=false for faster throughput (fire-and-forget).
   * Use ordering="weak" for maximum performance.
   *
   * @param waitForResult - If true, waits for server confirmation (slower but safer)
   * @param ordering - "weak" (fastest, may reorder) or "medium" (consistent)
   */
  async addPointsOptimized(
    collectionName: string,
    points: Array<{
      id: string | number;
      vector: number[];
      payload?: Record<string, any>;
    }>,
    options: {
      wait?: boolean;
      ordering?: "weak" | "medium" | "strong";
    } = {},
  ): Promise<void> {
    // Guard against empty arrays - Qdrant throws "Empty update request"
    if (points.length === 0) {
      return;
    }

    const { wait = false, ordering = "weak" } = options;

    try {
      const normalizedPoints = points.map((point) => ({
        ...point,
        id: this.normalizeId(point.id),
      }));

      await this.client.upsert(collectionName, {
        wait,
        ordering,
        points: normalizedPoints,
      });
    } catch (error: any) {
      const errorMessage =
        error?.data?.status?.error || error?.message || String(error);
      throw new Error(
        `Failed to add points (optimized) to collection "${collectionName}": ${errorMessage}`,
      );
    }
  }

  /**
   * Disable indexing for bulk upload performance.
   * Call enableIndexing() after upload completes.
   */
  async disableIndexing(collectionName: string): Promise<void> {
    await this.client.updateCollection(collectionName, {
      optimizers_config: {
        indexing_threshold: 0,
      },
    });
  }

  /**
   * Re-enable indexing after bulk upload.
   * @param threshold - Default 20000 (Qdrant default)
   */
  async enableIndexing(
    collectionName: string,
    threshold: number = 20000,
  ): Promise<void> {
    await this.client.updateCollection(collectionName, {
      optimizers_config: {
        indexing_threshold: threshold,
      },
    });
  }

  async search(
    collectionName: string,
    vector: number[],
    limit: number = 5,
    filter?: Record<string, any>,
  ): Promise<SearchResult[]> {
    // Convert simple key-value filter to Qdrant filter format
    // Accepts either:
    // 1. Simple format: {"category": "database"}
    // 2. Qdrant format: {must: [{key: "category", match: {value: "database"}}]}
    let qdrantFilter;
    if (filter && Object.keys(filter).length > 0) {
      // Check if already in Qdrant format (has must/should/must_not keys)
      if (filter.must || filter.should || filter.must_not) {
        qdrantFilter = filter;
      } else {
        // Convert simple key-value format to Qdrant format
        qdrantFilter = {
          must: Object.entries(filter).map(([key, value]) => ({
            key,
            match: { value },
          })),
        };
      }
    }

    // Check if collection uses named vectors (hybrid mode)
    const collectionInfo = await this.getCollectionInfo(collectionName);

    const results = await this.client.search(collectionName, {
      vector: collectionInfo.hybridEnabled ? { name: "dense", vector } : vector,
      limit,
      filter: qdrantFilter,
      with_payload: true,  // Explicitly request payloads
    });

    return results.map((result) => ({
      id: result.id,
      score: result.score,
      payload: result.payload || undefined,
    }));
  }

  async getPoint(
    collectionName: string,
    id: string | number,
  ): Promise<{ id: string | number; payload?: Record<string, any> } | null> {
    try {
      const normalizedId = this.normalizeId(id);
      const points = await this.client.retrieve(collectionName, {
        ids: [normalizedId],
      });

      if (points.length === 0) {
        return null;
      }

      return {
        id: points[0].id,
        payload: points[0].payload || undefined,
      };
    } catch {
      return null;
    }
  }

  async deletePoints(
    collectionName: string,
    ids: (string | number)[],
  ): Promise<void> {
    // Normalize IDs to ensure string IDs are in UUID format
    const normalizedIds = ids.map((id) => this.normalizeId(id));

    await this.client.delete(collectionName, {
      wait: true,
      points: normalizedIds,
    });
  }

  /**
   * Deletes points matching a filter condition.
   * Useful for deleting all chunks associated with a specific file path.
   */
  async deletePointsByFilter(
    collectionName: string,
    filter: Record<string, any>,
  ): Promise<void> {
    await this.client.delete(collectionName, {
      wait: true,
      filter: filter,
    });
  }

  /**
   * OPTIMIZED: Batch delete points for multiple file paths in a single request.
   * Uses OR (should) filter to match any of the specified paths.
   *
   * Before: N files → N HTTP requests (even with Promise.all)
   * After: N files → 1 HTTP request with combined filter
   */
  async deletePointsByPaths(
    collectionName: string,
    relativePaths: string[],
  ): Promise<void> {
    if (relativePaths.length === 0) return;

    // Single request with OR filter (should = any match)
    await this.client.delete(collectionName, {
      wait: true,
      filter: {
        should: relativePaths.map((path) => ({
          key: "relativePath",
          match: { value: path },
        })),
      },
    });
  }

  /**
   * PIPELINED BATCH DELETE: Delete points with batching and parallelism.
   *
   * Strategy:
   * - Split paths into batches (default: 500 paths per batch with payload index)
   * - Run batches with concurrency limit (default: 8 concurrent requests)
   * - Use wait=false for intermediate batches (fire-and-forget)
   * - Use wait=true for final batch (consistency guarantee)
   *
   * IMPORTANT: For best performance, ensure `relativePath` field has a
   * keyword payload index. Without index, filter-based deletes scan all points.
   *
   * This approach significantly speeds up deletion of large file sets
   * while maintaining eventual consistency.
   *
   * @param collectionName - Collection to delete from
   * @param relativePaths - Array of file paths to delete
   * @param options - Configuration options
   */
  async deletePointsByPathsBatched(
    collectionName: string,
    relativePaths: string[],
    options: {
      batchSize?: number;
      concurrency?: number;
      onProgress?: (deleted: number, total: number) => void;
    } = {},
  ): Promise<{ deletedPaths: number; batchCount: number; durationMs: number }> {
    const startTime = Date.now();

    if (relativePaths.length === 0) {
      return { deletedPaths: 0, batchCount: 0, durationMs: 0 };
    }

    // Default: 500 paths per batch, 8 concurrent (optimized for indexed relativePath)
    // QDRANT_DELETE_* are canonical names, DELETE_* are deprecated but still supported
    const {
      batchSize = parseInt(process.env.QDRANT_DELETE_BATCH_SIZE || process.env.DELETE_BATCH_SIZE || "500", 10),
      concurrency = parseInt(process.env.QDRANT_DELETE_CONCURRENCY || process.env.DELETE_CONCURRENCY || "8", 10),
      onProgress,
    } = options;

    // Split into batches
    const batches: string[][] = [];
    for (let i = 0; i < relativePaths.length; i += batchSize) {
      batches.push(relativePaths.slice(i, i + batchSize));
    }

    let deletedCount = 0;

    // Process batches with concurrency limit using pipelining
    // Track pending promises to limit concurrency
    const pendingPromises: Promise<void>[] = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const isLastBatch = i === batches.length - 1;

      // Wait for oldest promise if at concurrency limit
      if (pendingPromises.length >= concurrency) {
        await pendingPromises.shift();
      }

      // Create delete promise
      const deletePromise = this.client.delete(collectionName, {
        wait: isLastBatch, // Only wait for final batch
        filter: {
          should: batch.map((path) => ({
            key: "relativePath",
            match: { value: path },
          })),
        },
      }).then(() => {
        deletedCount += batch.length;
        onProgress?.(deletedCount, relativePaths.length);
      });

      if (!isLastBatch) {
        pendingPromises.push(deletePromise);
      } else {
        // Wait for final batch
        await deletePromise;
      }
    }

    // Wait for any remaining pending promises
    await Promise.all(pendingPromises);

    return {
      deletedPaths: relativePaths.length,
      batchCount: batches.length,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Update payload fields on existing points WITHOUT re-uploading vectors.
   * Used by Phase 2 git enrichment to add git metadata after embedding.
   *
   * @param collectionName - Collection to update
   * @param payload - Key-value pairs to SET (merges with existing payload)
   * @param options - Target points by IDs or filter, plus ordering/wait
   */
  async setPayload(
    collectionName: string,
    payload: Record<string, any>,
    options: {
      points?: (string | number)[];
      filter?: Record<string, any>;
      wait?: boolean;
      ordering?: "weak" | "medium" | "strong";
    },
  ): Promise<void> {
    const normalizedPoints = options.points?.map((id) => this.normalizeId(id));

    await this.client.setPayload(collectionName, {
      payload,
      points: normalizedPoints,
      filter: options.filter,
      wait: options.wait ?? false,
      ordering: options.ordering ?? "weak",
    });
  }

  /**
   * Batch multiple setPayload operations into a single HTTP request.
   * Uses Qdrant's batchUpdate API with set_payload operations.
   */
  async batchSetPayload(
    collectionName: string,
    operations: Array<{
      payload: Record<string, any>;
      points: (string | number)[];
      key?: string;
    }>,
    options: {
      wait?: boolean;
      ordering?: "weak" | "medium" | "strong";
    } = {},
  ): Promise<void> {
    if (operations.length === 0) return;

    const { wait = false, ordering = "weak" } = options;

    // Split into sub-batches of 100 operations to avoid oversized requests
    const BATCH_SIZE = 100;
    for (let i = 0; i < operations.length; i += BATCH_SIZE) {
      const batch = operations.slice(i, i + BATCH_SIZE);
      const isLast = i + BATCH_SIZE >= operations.length;

      const updateOps = batch.map((op) => ({
        set_payload: {
          payload: op.payload,
          points: op.points.map((id) => this.normalizeId(id)),
          ...(op.key ? { key: op.key } : {}),
        },
      }));

      await this.client.batchUpdate(collectionName, {
        operations: updateOps,
        wait: isLast ? wait : false,
        ordering,
      });
    }
  }

  /**
   * Performs hybrid search combining semantic vector search with sparse vector (keyword) search
   * using Reciprocal Rank Fusion (RRF) to combine results
   */
  async hybridSearch(
    collectionName: string,
    denseVector: number[],
    sparseVector: SparseVector,
    limit: number = 5,
    filter?: Record<string, any>,
    _semanticWeight: number = 0.7,
  ): Promise<SearchResult[]> {
    // Convert simple key-value filter to Qdrant filter format
    let qdrantFilter;
    if (filter && Object.keys(filter).length > 0) {
      if (filter.must || filter.should || filter.must_not) {
        qdrantFilter = filter;
      } else {
        qdrantFilter = {
          must: Object.entries(filter).map(([key, value]) => ({
            key,
            match: { value },
          })),
        };
      }
    }

    // Calculate prefetch limits based on weights
    // We fetch more results than needed to ensure good fusion results
    const prefetchLimit = Math.max(20, limit * 4);

    try {
      const results = await this.client.query(collectionName, {
        prefetch: [
          {
            query: denseVector,
            using: "dense",
            limit: prefetchLimit,
            filter: qdrantFilter,
          },
          {
            query: sparseVector,
            using: "text",
            limit: prefetchLimit,
            filter: qdrantFilter,
          },
        ],
        query: {
          fusion: "rrf",
        },
        limit: limit,
        with_payload: true,
      });

      return results.points.map((result: any) => ({
        id: result.id,
        score: result.score,
        payload: result.payload || undefined,
      }));
    } catch (error: any) {
      const errorMessage =
        error?.data?.status?.error || error?.message || String(error);
      throw new Error(
        `Hybrid search failed on collection "${collectionName}": ${errorMessage}`,
      );
    }
  }

  /**
   * Adds points with both dense and sparse vectors for hybrid search
   */
  async addPointsWithSparse(
    collectionName: string,
    points: Array<{
      id: string | number;
      vector: number[];
      sparseVector: SparseVector;
      payload?: Record<string, any>;
    }>,
  ): Promise<void> {
    // Guard against empty arrays - Qdrant throws "Empty update request"
    if (points.length === 0) {
      return;
    }

    try {
      // Normalize all IDs to ensure string IDs are in UUID format
      const normalizedPoints = points.map((point) => ({
        id: this.normalizeId(point.id),
        vector: {
          dense: point.vector,
          text: point.sparseVector,
        },
        payload: point.payload,
      }));

      await this.client.upsert(collectionName, {
        wait: true,
        points: normalizedPoints,
      });
    } catch (error: any) {
      const errorMessage =
        error?.data?.status?.error || error?.message || String(error);
      throw new Error(
        `Failed to add points with sparse vectors to collection "${collectionName}": ${errorMessage}`,
      );
    }
  }

  /**
   * Optimized addPointsWithSparse for bulk uploads.
   * Uses wait=false for faster throughput (fire-and-forget).
   * Use ordering="weak" for maximum performance.
   *
   * @param options.wait - If true, waits for server confirmation (slower but safer)
   * @param options.ordering - "weak" (fastest, may reorder) or "medium" (consistent)
   */
  async addPointsWithSparseOptimized(
    collectionName: string,
    points: Array<{
      id: string | number;
      vector: number[];
      sparseVector: SparseVector;
      payload?: Record<string, any>;
    }>,
    options: {
      wait?: boolean;
      ordering?: "weak" | "medium" | "strong";
    } = {},
  ): Promise<void> {
    // Guard against empty arrays - Qdrant throws "Empty update request"
    if (points.length === 0) {
      return;
    }

    const { wait = false, ordering = "weak" } = options;

    try {
      const normalizedPoints = points.map((point) => ({
        id: this.normalizeId(point.id),
        vector: {
          dense: point.vector,
          text: point.sparseVector,
        },
        payload: point.payload,
      }));

      await this.client.upsert(collectionName, {
        wait,
        ordering,
        points: normalizedPoints,
      });
    } catch (error: any) {
      const errorMessage =
        error?.data?.status?.error || error?.message || String(error);
      throw new Error(
        `Failed to add points with sparse vectors (optimized) to collection "${collectionName}": ${errorMessage}`,
      );
    }
  }
}
