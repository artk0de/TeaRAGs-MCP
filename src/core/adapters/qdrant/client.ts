import { createHash } from "node:crypto";

import { QdrantClient } from "@qdrant/js-client-rest";

import { QdrantAliasManager } from "./aliases.js";
import { CollectionAlreadyExistsError, QdrantOperationError, QdrantUnavailableError } from "./errors.js";

type QdrantPayload = Record<string, unknown>;

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
  payload?: QdrantPayload;
}

export interface SparseVector {
  indices: number[];
  values: number[];
}

export class QdrantManager {
  private readonly client: QdrantClient;
  private readonly qdrantUrl: string;
  private _aliases?: QdrantAliasManager;

  constructor(url = "http://localhost:6333", apiKey?: string) {
    this.qdrantUrl = url;
    this.client = new QdrantClient({ url, apiKey });
  }

  get url(): string {
    return this.qdrantUrl;
  }

  get aliases(): QdrantAliasManager {
    return (this._aliases ??= new QdrantAliasManager(this.client));
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
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
    enableSparse = false,
    quantizationScalar = false,
  ): Promise<void> {
    type DistanceType = "Cosine" | "Euclid" | "Dot" | "Manhattan";
    type VectorConfig =
      | {
          size: number;
          distance: DistanceType;
        }
      | {
          dense: {
            size: number;
            distance: DistanceType;
          };
        };

    interface CollectionConfig {
      vectors: VectorConfig;
      sparse_vectors?: {
        text: {
          modifier: "idf" | "none";
        };
      };
      quantization_config?: {
        scalar: {
          type: "int8";
          always_ram: boolean;
        };
      };
    }

    const config: CollectionConfig = enableSparse
      ? {
          vectors: {
            dense: {
              size: vectorSize,
              distance,
            },
          },
          sparse_vectors: {
            text: {
              modifier: "idf",
            },
          },
        }
      : {
          vectors: {
            size: vectorSize,
            distance,
          },
        };

    if (quantizationScalar) {
      config.quantization_config = {
        scalar: { type: "int8", always_ram: true },
      };
    }

    try {
      await this.client.createCollection(name, config);
    } catch (error: unknown) {
      if (isConflictError(error)) {
        throw new CollectionAlreadyExistsError(name, error instanceof Error ? error : undefined);
      }
      throw error;
    }
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
  async hasPayloadIndex(collectionName: string, fieldName: string): Promise<boolean> {
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
    } catch (error: unknown) {
      // Qdrant client throws with status property for HTTP errors (404 = not found)
      const { status } = error as { status?: number };
      if (status === 404 || status === 400) return false;
      // Connection errors (ECONNREFUSED, fetch failed, network errors) → typed error
      throw new QdrantUnavailableError(this.qdrantUrl, error instanceof Error ? error : undefined);
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
        const denseConfig = vectorConfig.dense as { size: unknown; distance: unknown };
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
    points: {
      id: string | number;
      vector: number[];
      payload?: Record<string, unknown>;
    }[],
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
    } catch (error: unknown) {
      const errorData = error as { data?: { status?: { error?: string } }; message?: string };
      const errorMessage = errorData?.data?.status?.error || errorData?.message || String(error);
      throw new QdrantOperationError(
        "addPoints",
        `collection "${collectionName}": ${errorMessage}`,
        error instanceof Error ? error : undefined,
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
    } catch (error: unknown) {
      const errorData = error as { data?: { status?: { error?: string } }; message?: string };
      const errorMessage = errorData?.data?.status?.error || errorData?.message || String(error);
      throw new QdrantOperationError(
        "addPointsOptimized",
        `collection "${collectionName}": ${errorMessage}`,
        error instanceof Error ? error : undefined,
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
  async enableIndexing(collectionName: string, threshold = 20000): Promise<void> {
    await this.client.updateCollection(collectionName, {
      optimizers_config: {
        indexing_threshold: threshold,
      },
    });
  }

  async search(
    collectionName: string,
    vector: number[],
    limit = 5,
    filter?: Record<string, unknown>,
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
      with_payload: true, // Explicitly request payloads
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
  ): Promise<{ id: string | number; payload?: Record<string, unknown> } | null> {
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

  /**
   * Query using Qdrant's universal query() API with recommend sub-query.
   * Used by find_similar to find chunks similar to given IDs or vectors.
   */
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
    const collectionInfo = await this.getCollectionInfo(collectionName);

    const recommend: Record<string, unknown> = {
      positive: options.positive,
    };
    if (options.negative?.length) recommend.negative = options.negative;
    if (options.strategy) recommend.strategy = options.strategy;

    const queryParams: Record<string, unknown> = {
      query: { recommend },
      limit: options.limit,
      with_payload: true,
      with_vector: false,
    };

    if (options.offset !== undefined) queryParams.offset = options.offset;
    if (options.filter) queryParams.filter = options.filter;
    if (collectionInfo.hybridEnabled) queryParams.using = "dense";

    const response = await this.client.query(collectionName, queryParams as Parameters<QdrantClient["query"]>[1]);

    return (response.points ?? []).map((point) => ({
      id: point.id,
      score: point.score,
      payload: (point.payload as Record<string, unknown>) || undefined,
    }));
  }

  /**
   * Query using Qdrant's queryGroups() API — server-side grouping.
   * Groups results by a payload field (e.g. "relativePath") and returns
   * the top hit per group. Used for file-level dedup (one best chunk per file).
   */
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
    const collectionInfo = await this.getCollectionInfo(collectionName);

    const params: Record<string, unknown> = {
      query: vector,
      group_by: options.groupBy,
      group_size: options.groupSize ?? 1,
      limit: options.limit,
      with_payload: true,
      with_vector: false,
    };

    if (options.filter) params.filter = options.filter;
    if (collectionInfo.hybridEnabled) params.using = "dense";

    const response = await this.client.queryGroups(
      collectionName,
      params as Parameters<QdrantClient["queryGroups"]>[1],
    );

    // Flatten groups: take first hit from each group
    const results: SearchResult[] = [];
    for (const group of response.groups ?? []) {
      const hit = group.hits?.[0];
      if (hit) {
        results.push({
          id: hit.id,
          score: hit.score ?? 0,
          payload: (hit.payload as Record<string, unknown>) || undefined,
        });
      }
    }
    return results;
  }

  async deletePoints(collectionName: string, ids: (string | number)[]): Promise<void> {
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
  async deletePointsByFilter(collectionName: string, filter: Record<string, unknown>): Promise<void> {
    await this.client.delete(collectionName, {
      wait: true,
      filter,
    });
  }

  /**
   * OPTIMIZED: Batch delete points for multiple file paths in a single request.
   * Uses OR (should) filter to match any of the specified paths.
   *
   * Before: N files → N HTTP requests (even with Promise.all)
   * After: N files → 1 HTTP request with combined filter
   */
  async deletePointsByPaths(collectionName: string, relativePaths: string[]): Promise<void> {
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
      batchSize: number;
      concurrency: number;
      onProgress?: (deleted: number, total: number) => void;
    },
  ): Promise<{ deletedPaths: number; batchCount: number; durationMs: number }> {
    const startTime = Date.now();

    if (relativePaths.length === 0) {
      return { deletedPaths: 0, batchCount: 0, durationMs: 0 };
    }

    const { batchSize, concurrency, onProgress } = options;

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
      const deletePromise = this.client
        .delete(collectionName, {
          wait: isLastBatch, // Only wait for final batch
          filter: {
            should: batch.map((path) => ({
              key: "relativePath",
              match: { value: path },
            })),
          },
        })
        .then(() => {
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
    payload: Record<string, unknown>,
    options: {
      points?: (string | number)[];
      filter?: Record<string, unknown>;
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
   * Performs hybrid search combining semantic vector search with sparse vector (keyword) search.
   * Runs both searches in parallel, normalizes scores via min-max, and blends with semanticWeight.
   */
  async hybridSearch(
    collectionName: string,
    denseVector: number[],
    sparseVector: SparseVector,
    fetchLimit: number,
    filter?: Record<string, unknown>,
    semanticWeight = 0.7,
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

    const sparseWeight = 1 - semanticWeight;

    try {
      // Run dense and sparse searches in parallel
      const [denseResults, sparseResults] = await Promise.all([
        this.client.search(collectionName, {
          vector: { name: "dense", vector: denseVector },
          limit: fetchLimit,
          filter: qdrantFilter,
          with_payload: true,
        }),
        this.client.search(collectionName, {
          vector: { name: "text", vector: sparseVector },
          limit: fetchLimit,
          filter: qdrantFilter,
          with_payload: true,
        }),
      ]);

      // Min-max normalize scores per source
      const normDense = minMaxNorm(denseResults.map((r) => r.score));
      const normSparse = minMaxNorm(sparseResults.map((r) => r.score));

      // Build score maps: id -> normalized score
      const denseScores = new Map<string, number>();
      for (let i = 0; i < denseResults.length; i++) {
        denseScores.set(String(denseResults[i].id), normDense[i]);
      }
      const sparseScores = new Map<string, number>();
      for (let i = 0; i < sparseResults.length; i++) {
        sparseScores.set(String(sparseResults[i].id), normSparse[i]);
      }

      // Merge: union of all IDs, weighted combination
      const allIds = new Map<string, true>();
      denseScores.forEach((_, id) => allIds.set(id, true));
      sparseScores.forEach((_, id) => allIds.set(id, true));
      const merged: SearchResult[] = [];

      allIds.forEach((_, id) => {
        const ds = denseScores.get(id) ?? 0;
        const ss = sparseScores.get(id) ?? 0;
        const score = semanticWeight * ds + sparseWeight * ss;

        // Get payload from whichever source has it
        const point = denseResults.find((r) => String(r.id) === id) ?? sparseResults.find((r) => String(r.id) === id);

        if (point) {
          merged.push({
            id: point.id,
            score,
            payload: (point.payload as Record<string, unknown> | null | undefined) ?? undefined,
          });
        }
      });

      // Sort by fused score descending
      merged.sort((a, b) => b.score - a.score);
      return merged;
    } catch (error: unknown) {
      const errorData = error as { data?: { status?: { error?: string } }; message?: string };
      const errorMessage = errorData?.data?.status?.error || errorData?.message || String(error);
      throw new QdrantOperationError(
        "hybridSearch",
        `collection "${collectionName}": ${errorMessage}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Adds points with both dense and sparse vectors for hybrid search
   */
  async addPointsWithSparse(
    collectionName: string,
    points: {
      id: string | number;
      vector: number[];
      sparseVector: SparseVector;
      payload?: Record<string, unknown>;
    }[],
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
    } catch (error: unknown) {
      const errorData = error as { data?: { status?: { error?: string } }; message?: string };
      const errorMessage = errorData?.data?.status?.error || errorData?.message || String(error);
      throw new QdrantOperationError(
        "addPointsWithSparse",
        `collection "${collectionName}": ${errorMessage}`,
        error instanceof Error ? error : undefined,
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
    } catch (error: unknown) {
      const errorData = error as { data?: { status?: { error?: string } }; message?: string };
      const errorMessage = errorData?.data?.status?.error || errorData?.message || String(error);
      throw new QdrantOperationError(
        "addPointsWithSparseOptimized",
        `collection "${collectionName}": ${errorMessage}`,
        error instanceof Error ? error : undefined,
      );
    }
  }
  /**
   * Adds sparse vector configuration (IDF-modified "text" sparse vector) to an existing collection.
   * Used when migrating a legacy dense-only collection to hybrid search.
   */
  async updateCollectionSparseConfig(collectionName: string): Promise<void> {
    await this.client.updateCollection(collectionName, {
      sparse_vectors: { text: { modifier: "idf" } },
    });
  }

  /**
   * Async generator that scrolls all points in a collection with both payload and vectors.
   * Yields batches of points. Points missing payload or vector are skipped.
   */
  async *scrollWithVectors(
    collectionName: string,
    batchSize = 100,
  ): AsyncGenerator<{ id: string | number; payload: Record<string, unknown>; vector: unknown }[]> {
    let offset: string | number | null = null;

    do {
      const result = await this.client.scroll(collectionName, {
        limit: batchSize,
        offset: offset ?? undefined,
        with_payload: true,
        with_vector: true,
      });

      const batch = result.points
        .filter((p) => p.payload && p.vector)
        .map((p) => ({
          id: p.id,
          payload: p.payload as Record<string, unknown>,
          vector: p.vector,
        }));

      if (batch.length > 0) yield batch;
      const next = result.next_page_offset;
      offset = typeof next === "string" || typeof next === "number" ? next : null;
    } while (offset !== null);
  }

  /**
   * Scroll all unique values of a payload field. Lightweight — selective payload only.
   * Used by glob pre-filter to resolve patterns against indexed paths.
   */
  async scrollFieldValues(collectionName: string, fieldName: string): Promise<string[]> {
    const values = new Set<string>();
    let offset: string | number | undefined;

    do {
      const result = await this.client.scroll(collectionName, {
        limit: 1000,
        offset,
        with_payload: { include: [fieldName] },
        with_vector: false,
      });

      for (const point of result.points) {
        const val = point.payload?.[fieldName];
        if (typeof val === "string") values.add(val);
      }

      const next = result.next_page_offset;
      offset = typeof next === "string" || typeof next === "number" ? next : undefined;
    } while (offset !== undefined);

    return [...values];
  }

  /**
   * Scroll points ordered by a payload field. Returns points with IDs and payloads.
   * Requires Qdrant 1.8+. The field should have a payload index for performance.
   */
  async scrollOrdered(
    collectionName: string,
    orderBy: { key: string; direction: "asc" | "desc" },
    limit: number,
    filter?: Record<string, unknown>,
  ): Promise<{ id: string | number; payload: Record<string, unknown> }[]> {
    try {
      const result = await this.client.scroll(collectionName, {
        limit,
        with_payload: true,
        with_vector: false,
        order_by: orderBy,
        ...(filter ? { filter } : {}),
      });

      return result.points
        .filter(
          (p): p is { id: string | number; payload: Record<string, unknown> } =>
            p.payload !== null && p.payload !== undefined,
        )
        .map((p) => ({ id: p.id, payload: p.payload }));
    } catch (error: unknown) {
      const errorData = error as { data?: { status?: { error?: string } }; message?: string };
      const errorMessage = errorData?.data?.status?.error || errorData?.message || String(error);
      throw new QdrantOperationError(
        "scrollOrdered",
        `"${collectionName}" order_by=${JSON.stringify(orderBy)}: ${errorMessage}`,
        error instanceof Error ? error : undefined,
      );
    }
  }
}

/** Detect Qdrant 409 Conflict (collection already exists). */
function isConflictError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("conflict") || msg.includes("already exists")) return true;
  }
  if (typeof error === "object" && error !== null && "status" in error) {
    return (error as { status: number }).status === 409;
  }
  return false;
}

/** Min-max normalize an array of scores to [0, 1]. */
function minMaxNorm(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;
  if (range === 0) return scores.map(() => 1);
  return scores.map((s) => (s - min) / range);
}
