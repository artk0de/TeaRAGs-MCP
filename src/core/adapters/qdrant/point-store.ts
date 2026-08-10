/**
 * The points inside a collection: writing them, deleting them, counting them,
 * and mutating their payloads in place.
 *
 * One concern, four shapes of it, and they belong together because they share
 * the two invariants nothing else in the adapter has to honour:
 *
 * - **ID normalization.** Qdrant only accepts UUID or integer point IDs, so
 *   every write and every point-addressed read runs its IDs through
 *   {@link QdrantPointStore.normalizeId} first. An ID normalized on the way in
 *   and not on the way out addresses a different point.
 * - **Write failure classification.** Every upsert path funnels through
 *   {@link failPointWrite} so a vector-width conflict is reported as one, with
 *   the same remedy, no matter which of the four upsert variants hit it.
 *
 * Payload mutation (`setPayload`, `batchSetPayload`, `deletePayloadKeys`) lives
 * here rather than in a store of its own: it is a write against the same points
 * under the same ID normalization, and enrichment writes it immediately after
 * the upsert that created them.
 *
 * Reads that are not addressed by point ID — scrolls and vector search — are
 * `QdrantScroller` and `QdrantSearchExecutor` respectively.
 */

import { createHash } from "node:crypto";

import type { QdrantConnection } from "./connection.js";
import {
  isVectorDimensionRejection,
  QdrantOperationError,
  QdrantOptimizationInProgressError,
  QdrantUnavailableError,
  QdrantVectorDimensionMismatchError,
} from "./errors.js";
import type { SparseVector } from "./types.js";

export class QdrantPointStore {
  /** Page size for scroll pagination when collecting point IDs by filter. */
  private static readonly SCROLL_PAGE_SIZE = 1000;

  constructor(private readonly connection: QdrantConnection) {}

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

  async countPoints(collectionName: string, filter?: Record<string, unknown>): Promise<number> {
    try {
      const result = await this.connection.call(async () =>
        this.connection.client.count(collectionName, { filter, exact: true }),
      );
      return result.count;
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;

      // Probe: is Qdrant still alive (yellow) or genuinely unreachable?
      try {
        const info = await this.connection.call(async () => this.connection.client.getCollection(collectionName));
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

  async getPoint(
    collectionName: string,
    id: string | number,
  ): Promise<{ id: string | number; payload?: Record<string, unknown> } | null> {
    try {
      const normalizedId = this.normalizeId(id);
      const points = await this.connection.call(async () =>
        this.connection.client.retrieve(collectionName, {
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

      await this.connection.call(async () =>
        this.connection.client.upsert(collectionName, {
          wait: true,
          points: normalizedPoints,
        }),
      );
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;
      const errorData = error as { data?: { status?: { error?: string } }; message?: string };
      const errorMessage = errorData?.data?.status?.error || errorData?.message || String(error);
      failPointWrite("addPoints", collectionName, errorMessage, error instanceof Error ? error : undefined);
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

      await this.connection.call(async () =>
        this.connection.client.upsert(collectionName, {
          wait,
          ordering,
          points: normalizedPoints,
        }),
      );
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;
      const errorData = error as { data?: { status?: { error?: string } }; message?: string };
      const errorMessage = errorData?.data?.status?.error || errorData?.message || String(error);
      failPointWrite("addPointsOptimized", collectionName, errorMessage, error instanceof Error ? error : undefined);
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

      await this.connection.call(async () =>
        this.connection.client.upsert(collectionName, {
          wait: true,
          points: normalizedPoints,
        }),
      );
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;
      const errorData = error as { data?: { status?: { error?: string } }; message?: string };
      const errorMessage = errorData?.data?.status?.error || errorData?.message || String(error);
      failPointWrite("addPointsWithSparse", collectionName, errorMessage, error instanceof Error ? error : undefined);
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

      await this.connection.call(async () =>
        this.connection.client.upsert(collectionName, {
          wait,
          ordering,
          points: normalizedPoints,
        }),
      );
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;
      const errorData = error as { data?: { status?: { error?: string } }; message?: string };
      const errorMessage = errorData?.data?.status?.error || errorData?.message || String(error);
      failPointWrite(
        "addPointsWithSparseOptimized",
        collectionName,
        errorMessage,
        error instanceof Error ? error : undefined,
      );
    }
  }

  async deletePoints(collectionName: string, ids: (string | number)[]): Promise<void> {
    // Normalize IDs to ensure string IDs are in UUID format
    const normalizedIds = ids.map((id) => this.normalizeId(id));

    await this.connection.call(async () =>
      this.connection.client.delete(collectionName, {
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
    await this.connection.call(async () =>
      this.connection.client.delete(collectionName, {
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
    await this.connection.call(async () =>
      this.connection.client.delete(collectionName, {
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
   * ingest pipeline starve, client hits 300s AbortError (production incident
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
        await this.connection.call(async () =>
          this.connection.client.delete(collectionName, { wait: true, points: chunk }),
        );
        reportProgress();
      } else {
        if (pendingPromises.length >= concurrency) {
          await pendingPromises.shift();
        }
        pendingPromises.push(
          this.connection
            .call(async () => this.connection.client.delete(collectionName, { wait: false, points: chunk }))
            .then(reportProgress),
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
      const result = await this.connection.call(async () =>
        this.connection.client.scroll(collectionName, {
          limit: QdrantPointStore.SCROLL_PAGE_SIZE,
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

    await this.connection.call(async () =>
      this.connection.client.setPayload(collectionName, {
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

      await this.connection.call(async () =>
        this.connection.client.batchUpdate(collectionName, {
          operations: updateOps,
          wait: isLast ? wait : false,
          ordering,
        }),
      );
    }
  }

  /** Delete payload keys from all points (or filtered subset). */
  async deletePayloadKeys(collectionName: string, keys: string[], filter?: Record<string, unknown>): Promise<void> {
    await this.connection.call(async () =>
      this.connection.client.deletePayload(collectionName, {
        keys,
        filter: filter ?? {},
        wait: true,
      }),
    );
  }
}

/**
 * Fail a point-write, separating a vector-width conflict from generic operation
 * failure. Every write path funnels through here so the width remedy is stated
 * identically no matter which one hit it.
 */
function failPointWrite(operation: string, collectionName: string, errorMessage: string, cause?: Error): never {
  if (isVectorDimensionRejection(errorMessage)) {
    throw new QdrantVectorDimensionMismatchError(operation, collectionName, errorMessage, cause);
  }
  throw new QdrantOperationError(operation, `collection "${collectionName}": ${errorMessage}`, cause);
}
