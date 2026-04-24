import { createHash } from "node:crypto";

import { QdrantClient } from "@qdrant/js-client-rest";

import { QdrantAliasManager } from "./aliases.js";
import type { StartupPhase } from "./embedded/types.js";
import {
  CollectionAlreadyExistsError,
  QdrantOperationError,
  QdrantOptimizationInProgressError,
  QdrantPointNotFoundError,
  QdrantRecoveringError,
  QdrantStartingError,
  QdrantUnavailableError,
} from "./errors.js";

export interface EmbeddedDaemonProbe {
  /** Current startup phase of the embedded daemon, or null if daemon is dead / not an embedded daemon. */
  startupPhase: () => StartupPhase | null;
  pid: number;
  storagePath: string;
}

type QdrantPayload = Record<string, unknown>;

export interface CollectionInfo {
  name: string;
  vectorSize: number;
  pointsCount: number;
  distance: "Cosine" | "Euclid" | "Dot";
  hybridEnabled?: boolean;
  /** Qdrant collection health status. `yellow` indicates background optimization. */
  status: "green" | "yellow" | "red";
  /** Optimizer state string from Qdrant (`"ok"` or `"unknown"` when absent). */
  optimizerStatus: string;
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
  /** Page size for scroll pagination when collecting point IDs by filter. */
  private static readonly SCROLL_PAGE_SIZE = 1000;

  private client: QdrantClient;
  private qdrantUrl: string;
  private readonly apiKey?: string;
  private readonly reconnect?: () => string | null;
  private readonly daemon?: EmbeddedDaemonProbe;
  private _aliases?: QdrantAliasManager;

  constructor(
    url = "http://localhost:6333",
    apiKey?: string,
    reconnect?: () => string | null,
    daemon?: EmbeddedDaemonProbe,
  ) {
    this.qdrantUrl = url;
    this.apiKey = apiKey;
    this.reconnect = reconnect;
    this.daemon = daemon;
    this.client = new QdrantClient({ url, apiKey });
  }

  /**
   * Guard all Qdrant client calls through a single entry point.
   * Catches connection errors (fetch failed, ECONNREFUSED) and converts
   * them to a typed error. Business errors (404, 409) pass through.
   *
   * For embedded mode: on connection error, tries to reconnect to a daemon
   * that may have restarted on a different port, then retries once.
   *
   * If the daemon is known-alive (embedded mode, pid still running) but the
   * HTTP port is not listening — the daemon is recovering shards. We throw
   * QdrantStartingError so callers can distinguish "not ready yet, retry"
   * from "really unreachable, fix your config".
   */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      if (isConnectionError(error) && this.tryReconnect()) {
        return await fn();
      }
      if (isConnectionError(error)) {
        const cause = error instanceof Error ? error : undefined;
        const phase = this.daemon?.startupPhase();
        if (phase === "starting") {
          throw new QdrantStartingError(
            this.qdrantUrl,
            { pid: this.daemon?.pid, storagePath: this.daemon?.storagePath },
            cause,
          );
        }
        if (phase === "recovering") {
          throw new QdrantRecoveringError(
            this.qdrantUrl,
            { pid: this.daemon?.pid, storagePath: this.daemon?.storagePath },
            cause,
          );
        }
        throw new QdrantUnavailableError(this.qdrantUrl, cause);
      }
      throw error;
    }
  }

  /**
   * Attempt to reconnect to embedded daemon on a new port.
   * Returns true if URL was updated and retry is warranted.
   */
  private tryReconnect(): boolean {
    if (!this.reconnect) return false;
    const newUrl = this.reconnect();
    if (!newUrl) return false;
    this.qdrantUrl = newUrl;
    this.client = new QdrantClient({ url: newUrl, apiKey: this.apiKey });
    this._aliases = undefined;
    return true;
  }

  get url(): string {
    return this.qdrantUrl;
  }

  get aliases(): QdrantAliasManager {
    return (this._aliases ??= new QdrantAliasManager(this.client));
  }

  /** Lightweight health check — returns true if Qdrant is reachable. */
  async checkHealth(): Promise<boolean> {
    try {
      await this.call(async () => this.client.getCollections());
      return true;
    } catch {
      return false;
    }
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
      await this.call(async () => this.client.createCollection(name, config));
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;
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
    await this.call(async () =>
      this.client.createPayloadIndex(collectionName, {
        field_name: fieldName,
        field_schema: fieldSchema,
        wait: true,
      }),
    );
  }

  /**
   * Check if a payload index exists on a field.
   */
  async hasPayloadIndex(collectionName: string, fieldName: string): Promise<boolean> {
    try {
      const info = await this.call(async () => this.client.getCollection(collectionName));
      const indexes = info.payload_schema || {};
      return fieldName in indexes;
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;
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
      await this.call(async () => this.client.getCollection(name));
      return true;
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;
      // Qdrant client throws with status property for HTTP errors (404 = not found)
      const { status } = error as { status?: number };
      if (status === 404 || status === 400) return false;
      throw error;
    }
  }

  async listCollections(): Promise<string[]> {
    const response = await this.call(async () => this.client.getCollections());
    return response.collections.map((c) => c.name);
  }

  async getCollectionInfo(name: string): Promise<CollectionInfo> {
    const info = await this.call(async () => this.client.getCollection(name));
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
      status: (info.status ?? "green") as "green" | "yellow" | "red",
      optimizerStatus: typeof info.optimizer_status === "string" ? info.optimizer_status : "unknown",
    };
  }

  async deleteCollection(name: string): Promise<void> {
    await this.call(async () => this.client.deleteCollection(name));
  }

  async countPoints(collectionName: string, filter?: Record<string, unknown>): Promise<number> {
    try {
      const result = await this.call(async () => this.client.count(collectionName, { filter, exact: true }));
      return result.count;
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;

      // Probe: is Qdrant still alive (yellow) or genuinely unreachable?
      try {
        const info = await this.call(async () => this.client.getCollection(collectionName));
        if (info.status === "yellow") {
          throw new QdrantOptimizationInProgressError(collectionName, error instanceof Error ? error : undefined);
        }
      } catch (probeError) {
        if (probeError instanceof QdrantOptimizationInProgressError) throw probeError;
        // probe failed too → fall through to generic QdrantOperationError below
      }

      const errorData = error as { data?: { status?: { error?: string } }; message?: string };
      const errorMessage = errorData?.data?.status?.error || errorData?.message || String(error);
      throw new QdrantOperationError(
        "countPoints",
        `collection "${collectionName}": ${errorMessage}`,
        error instanceof Error ? error : undefined,
      );
    }
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

      await this.call(async () =>
        this.client.upsert(collectionName, {
          wait: true,
          points: normalizedPoints,
        }),
      );
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;
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

      await this.call(async () =>
        this.client.upsert(collectionName, {
          wait,
          ordering,
          points: normalizedPoints,
        }),
      );
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;
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
   * Pause both HNSW indexing and segment vacuum during a large-delta reindex.
   *
   * After a bulk delete on embedded Qdrant the optimizer repacks segments
   * (triggered by `deleted_threshold`, default 0.2 = ≥20% tombstones). On
   * multi-thousand-file deletes this holds WAL busy for several minutes and
   * starves concurrent upsert HTTP requests until they hit the 300s client
   * timeout (taxdome incident 2026-04-24T16-34).
   *
   * Setting `deleted_threshold: 0.99` prevents vacuum from firing mid-reindex.
   * Setting `indexing_threshold: 0` pauses HNSW rebuilds. Both resume via
   * {@link resumeOptimizer}, which also triggers a one-shot optimization pass
   * when thresholds revert.
   */
  async pauseOptimizer(collectionName: string): Promise<void> {
    await this.call(async () =>
      this.client.updateCollection(collectionName, {
        optimizers_config: {
          indexing_threshold: 0,
          deleted_threshold: 0.99,
        },
      }),
    );
  }

  /**
   * Resume optimizer after reindex: restore thresholds to their productive
   * defaults. Reverting `deleted_threshold` naturally triggers one optimizer
   * pass to repack any tombstones accumulated during the paused interval.
   *
   * @param options.indexingThreshold - HNSW indexing threshold (Qdrant default: 20000)
   * @param options.deletedThreshold - Vacuum trigger ratio (Qdrant default: 0.2)
   */
  async resumeOptimizer(
    collectionName: string,
    options: { indexingThreshold?: number; deletedThreshold?: number } = {},
  ): Promise<void> {
    const { indexingThreshold = 20000, deletedThreshold = 0.2 } = options;
    await this.call(async () =>
      this.client.updateCollection(collectionName, {
        optimizers_config: {
          indexing_threshold: indexingThreshold,
          deleted_threshold: deletedThreshold,
        },
      }),
    );
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
    let qdrantFilter: Record<string, unknown> | null | undefined;
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

    const results = await this.call(async () =>
      this.client.search(collectionName, {
        vector: collectionInfo.hybridEnabled ? { name: "dense", vector } : vector,
        limit,
        filter: qdrantFilter,
        with_payload: true, // Explicitly request payloads
      }),
    );

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
      const points = await this.call(async () =>
        this.client.retrieve(collectionName, {
          ids: [normalizedId],
        }),
      );

      if (points.length === 0) {
        return null;
      }

      return {
        id: points[0].id,
        payload: points[0].payload || undefined,
      };
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;
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

    let response;
    try {
      response = await this.call(async () =>
        this.client.query(collectionName, queryParams as Parameters<QdrantClient["query"]>[1]),
      );
    } catch (error: unknown) {
      if (error instanceof Error && "status" in error && (error as { status: number }).status === 404) {
        const ids = options.positive.filter((p): p is string => typeof p === "string");
        throw new QdrantPointNotFoundError(ids[0] ?? "unknown", collectionName, error);
      }
      throw error;
    }

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

    const response = await this.call(async () =>
      this.client.queryGroups(collectionName, params as Parameters<QdrantClient["queryGroups"]>[1]),
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

    await this.call(async () =>
      this.client.delete(collectionName, {
        wait: true,
        points: normalizedIds,
      }),
    );
  }

  /**
   * Deletes points matching a filter condition.
   * Useful for deleting all chunks associated with a specific file path.
   */
  async deletePointsByFilter(collectionName: string, filter: Record<string, unknown>): Promise<void> {
    await this.call(async () =>
      this.client.delete(collectionName, {
        wait: true,
        filter,
      }),
    );
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
    await this.call(async () =>
      this.client.delete(collectionName, {
        wait: true,
        filter: {
          should: relativePaths.map((path) => ({
            key: "relativePath",
            match: { value: path },
          })),
        },
      }),
    );
  }

  /**
   * PHASE-SEPARATED DELETE: one read pass, parallel writes.
   *
   * Phase 1 (sequential, read-only): a single `scroll` over MatchAny(all paths)
   * paginates through every matching point to collect IDs. Pure read — never
   * touches WAL, never competes with upserts, never triggers optimizer repack.
   *
   * Phase 2 (parallel writes): collected IDs are split into chunks of
   * `batchSize` and deleted via `client.delete({points})` with up to
   * `concurrency` parallel calls. Point-ID deletion bypasses the filter engine
   * entirely and completes in versioned-storage time.
   *
   * Why phase separation? Interleaving scroll+delete per batch under
   * `concurrency: 4` saturates embedded Qdrant WAL — upserts from the parallel
   * ingest pipeline starve, client hits 300s AbortError (taxdome incident
   * 2026-04-24T16-15). Collecting IDs first, then writing, keeps reads and
   * writes from stepping on each other.
   *
   * Only the final delete call uses `wait: true` — it acts as the barrier for
   * the whole operation.
   *
   * @param collectionName - Collection to delete from
   * @param relativePaths - Array of file paths to delete
   * @param options - batchSize = IDs per delete call; concurrency = parallel deletes
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

    // Phase 1: collect all IDs in one sequential scroll (read-only).
    const ids = await this.collectPointIdsForPaths(collectionName, relativePaths);

    if (ids.length === 0) {
      onProgress?.(relativePaths.length, relativePaths.length);
      return { deletedPaths: relativePaths.length, batchCount: 0, durationMs: Date.now() - startTime };
    }

    // Phase 2: parallel delete-by-IDs with concurrency cap.
    const chunks: (string | number)[][] = [];
    for (let i = 0; i < ids.length; i += batchSize) {
      chunks.push(ids.slice(i, i + batchSize));
    }

    let chunksCompleted = 0;
    const reportProgress = (): void => {
      chunksCompleted++;
      onProgress?.(Math.floor((chunksCompleted / chunks.length) * relativePaths.length), relativePaths.length);
    };

    const pendingPromises: Promise<void>[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isLastChunk = i === chunks.length - 1;

      if (isLastChunk) {
        await Promise.all(pendingPromises);
        await this.call(async () => this.client.delete(collectionName, { wait: true, points: chunk }));
        reportProgress();
      } else {
        if (pendingPromises.length >= concurrency) {
          await pendingPromises.shift();
        }
        pendingPromises.push(
          this.call(async () => this.client.delete(collectionName, { wait: false, points: chunk })).then(
            reportProgress,
          ),
        );
      }
    }

    return {
      deletedPaths: relativePaths.length,
      batchCount: chunks.length,
      durationMs: Date.now() - startTime,
    };
  }

  private async collectPointIdsForPaths(collectionName: string, paths: string[]): Promise<(string | number)[]> {
    const ids: (string | number)[] = [];
    // MatchAny (Qdrant 1.9+) — single set-membership condition instead of an
    // N-way OR. Keeps filter-engine cost O(1) per point regardless of batch
    // size (a 1000-item `should` triggers 500 Internal Server Error on
    // embedded under concurrent load).
    const filter = {
      must: [{ key: "relativePath", match: { any: paths } }],
    };
    let offset: string | number | undefined = undefined;
    do {
      const result = await this.call(async () =>
        this.client.scroll(collectionName, {
          limit: QdrantManager.SCROLL_PAGE_SIZE,
          with_payload: false,
          with_vector: false,
          filter,
          ...(offset !== undefined ? { offset } : {}),
        }),
      );
      for (const point of result.points) {
        ids.push(point.id);
      }
      const next = result.next_page_offset;
      offset = typeof next === "string" || typeof next === "number" ? next : undefined;
    } while (offset !== undefined);
    return ids;
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

    await this.call(async () =>
      this.client.setPayload(collectionName, {
        payload,
        points: normalizedPoints,
        filter: options.filter,
        wait: options.wait ?? false,
        ordering: options.ordering ?? "weak",
      }),
    );
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

      await this.call(async () =>
        this.client.batchUpdate(collectionName, {
          operations: updateOps,
          wait: isLast ? wait : false,
          ordering,
        }),
      );
    }
  }

  /** Delete payload keys from all points (or filtered subset). */
  async deletePayloadKeys(collectionName: string, keys: string[], filter?: Record<string, unknown>): Promise<void> {
    await this.call(async () =>
      this.client.deletePayload(collectionName, {
        keys,
        filter: filter ?? {},
        wait: true,
      }),
    );
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
    let qdrantFilter: Record<string, unknown> | null | undefined;
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
        this.call(async () =>
          this.client.search(collectionName, {
            vector: { name: "dense", vector: denseVector },
            limit: fetchLimit,
            filter: qdrantFilter,
            with_payload: true,
          }),
        ),
        this.call(async () =>
          this.client.search(collectionName, {
            vector: { name: "text", vector: sparseVector },
            limit: fetchLimit,
            filter: qdrantFilter,
            with_payload: true,
          }),
        ),
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
      if (error instanceof QdrantUnavailableError) throw error;
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

      await this.call(async () =>
        this.client.upsert(collectionName, {
          wait: true,
          points: normalizedPoints,
        }),
      );
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;
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

      await this.call(async () =>
        this.client.upsert(collectionName, {
          wait,
          ordering,
          points: normalizedPoints,
        }),
      );
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;
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
    await this.call(async () =>
      this.client.updateCollection(collectionName, {
        sparse_vectors: { text: { modifier: "idf" } },
      }),
    );
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
      const result = await this.call(async () =>
        this.client.scroll(collectionName, {
          limit: batchSize,
          offset: offset ?? undefined,
          with_payload: true,
          with_vector: true,
        }),
      );

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
      const result = await this.call(async () =>
        this.client.scroll(collectionName, {
          limit: 1000,
          offset,
          with_payload: { include: [fieldName] },
          with_vector: false,
        }),
      );

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
      const result = await this.call(async () =>
        this.client.scroll(collectionName, {
          limit,
          with_payload: true,
          with_vector: false,
          order_by: orderBy,
          ...(filter ? { filter } : {}),
        }),
      );

      return result.points
        .filter(
          (p): p is { id: string | number; payload: Record<string, unknown> } =>
            p.payload !== null && p.payload !== undefined,
        )
        .map((p) => ({ id: p.id, payload: p.payload }));
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;
      const errorData = error as { data?: { status?: { error?: string } }; message?: string };
      const errorMessage = errorData?.data?.status?.error || errorData?.message || String(error);
      throw new QdrantOperationError(
        "scrollOrdered",
        `"${collectionName}" order_by=${JSON.stringify(orderBy)}: ${errorMessage}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Scroll points matching a filter. Returns points with IDs and full payloads.
   * No ordering — results come in Qdrant internal order.
   * Paginates automatically. Hard cap at `limit` total results to prevent runaway pagination.
   */
  async scrollFiltered(
    collectionName: string,
    filter: Record<string, unknown>,
    limit: number,
    pageSize?: number,
  ): Promise<{ id: string | number; payload: Record<string, unknown> }[]> {
    const results: { id: string | number; payload: Record<string, unknown> }[] = [];
    const effectivePageSize = pageSize ? Math.min(pageSize, limit) : Math.min(limit, 200);
    let offset: string | number | undefined = undefined;

    do {
      const result = await this.call(async () =>
        this.client.scroll(collectionName, {
          limit: effectivePageSize,
          with_payload: true,
          with_vector: false,
          filter,
          ...(offset !== undefined ? { offset } : {}),
        }),
      );

      for (const point of result.points) {
        if (point.payload !== null && point.payload !== undefined) {
          results.push({
            id: point.id,
            payload: point.payload as Record<string, unknown>,
          });
        }
      }

      if (results.length >= limit) break;

      const next = result.next_page_offset;
      offset = typeof next === "string" || typeof next === "number" ? next : undefined;
    } while (offset !== undefined);

    return results;
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

/**
 * Detect network/connection errors vs Qdrant business errors.
 * Business errors (404, 400, 409) have an HTTP status — these are NOT connection errors.
 * Connection errors: fetch failed, ECONNREFUSED, ENOTFOUND, socket hang up, etc.
 */
function isConnectionError(error: unknown): boolean {
  // Qdrant client attaches `status` for HTTP errors — not a connection error
  if (typeof error === "object" && error !== null && "status" in error) {
    const { status } = error as { status: number };
    if (typeof status === "number" && status > 0) return false;
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("fetch failed") ||
      msg.includes("econnrefused") ||
      msg.includes("enotfound") ||
      msg.includes("socket hang up") ||
      msg.includes("network error") ||
      msg.includes("failed to fetch") ||
      msg.includes("econnreset") ||
      msg.includes("etimedout")
    );
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
