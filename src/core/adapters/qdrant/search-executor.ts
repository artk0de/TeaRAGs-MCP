/**
 * Vector retrieval: every path that asks Qdrant to RANK points rather than
 * enumerate them — dense search, recommend-style similarity, server-side
 * grouping, and dense+sparse RRF fusion.
 *
 * What makes these one concern rather than four endpoints is that they share
 * the two things a ranked query has to get right and a scroll never faces:
 *
 * - **The dense/named-vector fork.** A hybrid-enabled collection stores its
 *   dense vector under the name `dense`, so every dense leg has to be addressed
 *   differently depending on the collection's layout. That is why each method
 *   here reads {@link CollectionInfo.hybridEnabled} first.
 * - **Quantization rescore.** {@link QUANTIZATION_SEARCH_PARAMS} must ride on
 *   every dense leg or TurboQuant silently costs 2–3 pp of recall. Sparse legs
 *   are not quantized and deliberately do not carry it.
 *
 * Filter normalization (accepting either the simple key/value shape or a real
 * Qdrant filter) is duplicated between `search` and `hybridSearch` exactly as it
 * was in the original class — it is preserved verbatim here rather than unified,
 * because the two accept subtly different nullability and this split is meant to
 * be behaviour-neutral.
 */

import type { QdrantClient } from "@qdrant/js-client-rest";

import { InvalidQueryError } from "../../domains/explore/errors.js";
import type { CollectionInfo } from "./collection-admin.js";
import type { QdrantConnection } from "./connection.js";
import { QdrantOperationError, QdrantPointNotFoundError, QdrantUnavailableError } from "./errors.js";
import type { SparseVector } from "./types.js";

type QdrantPayload = Record<string, unknown>;

/**
 * How the executor learns a collection's vector layout. Injected as a function
 * rather than taken as a `QdrantCollectionAdmin` for two reasons: the executor
 * needs exactly one fact (`hybridEnabled`), and the facade binds this to its own
 * `getCollectionInfo`, so the lookup stays late-bound through `QdrantManager` —
 * the same dispatch the methods had when they lived on that class.
 */
export type CollectionInfoLookup = (collectionName: string) => Promise<CollectionInfo>;

export interface SearchResult {
  id: string | number;
  score: number;
  payload?: QdrantPayload;
}

/**
 * Search-time quantization params applied to every dense/quantized query so
 * TurboQuant candidates are re-scored on the stored float vectors. Without
 * rescore, 8x quantization drops recall ~2–3 pp; oversampling widens the
 * quantized candidate pool before the float-vector rescore. Sparse legs are not
 * quantized, so this is injected only on dense paths.
 */
const QUANTIZATION_SEARCH_PARAMS = {
  quantization: { rescore: true, oversampling: 2.0 },
} as const;

export class QdrantSearchExecutor {
  constructor(
    private readonly connection: QdrantConnection,
    private readonly lookupCollectionInfo: CollectionInfoLookup,
  ) {}

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
    const collectionInfo = await this.lookupCollectionInfo(collectionName);

    const results = await this.connection.call(async () =>
      this.connection.client.search(collectionName, {
        vector: collectionInfo.hybridEnabled ? { name: "dense", vector } : vector,
        limit,
        filter: qdrantFilter,
        with_payload: true, // Explicitly request payloads
        params: QUANTIZATION_SEARCH_PARAMS,
      }),
    );

    return results.map((result) => ({
      id: result.id,
      score: result.score,
      payload: result.payload || undefined,
    }));
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
    const collectionInfo = await this.lookupCollectionInfo(collectionName);

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
    queryParams.params = QUANTIZATION_SEARCH_PARAMS;

    let response;
    try {
      response = await this.connection.call(async () =>
        this.connection.client.query(collectionName, queryParams as Parameters<QdrantClient["query"]>[1]),
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
    const collectionInfo = await this.lookupCollectionInfo(collectionName);

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
    params.params = QUANTIZATION_SEARCH_PARAMS;

    const response = await this.connection.call(async () =>
      this.connection.client.queryGroups(collectionName, params as Parameters<QdrantClient["queryGroups"]>[1]),
    );

    // Flatten groups in group order, keeping every hit the server returned.
    // group_size is forwarded to Qdrant, so dropping all but the first hit
    // would make the parameter a no-op for callers above (tea-rags-mcp-zrma).
    const results: SearchResult[] = [];
    for (const group of response.groups ?? []) {
      for (const hit of group.hits ?? []) {
        results.push({
          id: hit.id,
          score: hit.score ?? 0,
          payload: (hit.payload as Record<string, unknown>) || undefined,
        });
      }
    }
    return results;
  }

  /**
   * Performs hybrid search combining dense and sparse retrieval using Qdrant's
   * server-side RRF (Reciprocal Rank Fusion) via the Query API. Issues a single
   * request with two prefetches.
   *
   * @param semanticWeight Optional weight for the dense sub-query in weighted RRF.
   *                       If omitted, plain RRF (equal weights, Qdrant default k)
   *                       is used. If provided, must be in [0, 1]; the sparse
   *                       weight is implicitly (1 - semanticWeight).
   */
  async hybridSearch(
    collectionName: string,
    denseVector: number[],
    sparseVector: SparseVector,
    fetchLimit: number,
    filter?: Record<string, unknown>,
    semanticWeight?: number,
  ): Promise<SearchResult[]> {
    if (semanticWeight !== undefined) {
      if (!Number.isFinite(semanticWeight) || semanticWeight < 0 || semanticWeight > 1) {
        throw new InvalidQueryError("semanticWeight must be a finite number in [0, 1]");
      }
    }

    let qdrantFilter: Record<string, unknown> | undefined;
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

    const fusionQuery =
      semanticWeight === undefined
        ? { fusion: "rrf" as const }
        : { rrf: { weights: [semanticWeight, 1 - semanticWeight] } };

    try {
      const response = await this.connection.call(async () =>
        this.connection.client.query(collectionName, {
          prefetch: [
            {
              query: denseVector,
              using: "dense",
              limit: fetchLimit,
              filter: qdrantFilter,
              params: QUANTIZATION_SEARCH_PARAMS,
            },
            { query: sparseVector, using: "text", limit: fetchLimit, filter: qdrantFilter },
          ],
          query: fusionQuery,
          limit: fetchLimit,
          filter: qdrantFilter,
          with_payload: true,
        } as Parameters<QdrantClient["query"]>[1]),
      );

      return (response.points ?? []).map((point) => ({
        id: point.id,
        score: point.score ?? 0,
        payload: (point.payload as Record<string, unknown> | null | undefined) ?? undefined,
      }));
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
}
