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

import { InfraError } from "../errors.js";
import type { QdrantConnection } from "./connection.js";
import { denseVectorOf } from "./dense-vector.js";
import {
  isVectorDimensionRejection,
  QdrantOperationError,
  QdrantOptimizationInProgressError,
  QdrantUnavailableError,
  QdrantVectorDimensionMismatchError,
} from "./errors.js";
import { relativePathExactFilter, relativePathExactGroups } from "./filters/relative-path-exact.js";
import { anyOfOnTextIndexed, exactMatchOnTextIndexed } from "./filters/text-indexed-exact.js";
import { toQdrantPointId } from "./point-id.js";
import type { RelativePathExactGate } from "./relative-path-exact-capability.js";
import type { QdrantUpdateStatus, SparseVector } from "./types.js";
import { foldUpdateStatus } from "./write-barrier.js";

/** Named by the no-op barrier update in `awaitQueuedUpdates`; its filter matches no point, so nothing is deleted. */
const QUEUED_UPDATE_BARRIER_KEY = "__queued_update_barrier__";

export class QdrantPointStore {
  /** Page size for scroll pagination when collecting point IDs by filter. */
  private static readonly SCROLL_PAGE_SIZE = 1000;

  /**
   * `relativePathExact` is the gate the membership methods consult
   * (`./relative-path-exact-capability.ts`); without one every collection is
   * treated as unserved and keeps the exact text+value pairs.
   */
  constructor(
    private readonly connection: QdrantConnection,
    private readonly relativePathExact: RelativePathExactGate = { isServed: async () => false },
  ) {}

  /** The stored id of `id` — the one mapping every reader shares (`./point-id.ts`). */
  private normalizeId(id: string | number): string | number {
    return toQdrantPointId(id);
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

  /**
   * One point by ID, or `null` — which here means absent OR unreadable: every
   * failure but a lost connection answers `null`, the daemon's starting and
   * recovering windows included. Right for a caller whose "no point" and "could
   * not look" lead to the same move; a caller that writes differently for the
   * two needs {@link getPointOrThrow}.
   */
  async getPoint(
    collectionName: string,
    id: string | number,
  ): Promise<{ id: string | number; payload?: Record<string, unknown> } | null> {
    try {
      return await this.getPointOrThrow(collectionName, id);
    } catch (error: unknown) {
      if (error instanceof QdrantUnavailableError) throw error;
      return null;
    }
  }

  /**
   * One point by ID, where `null` means only that Qdrant answered and the point
   * is not there. Every failure throws an `InfraError`: the connection's typed
   * ones (unavailable / starting / recovering) as they are, anything the client
   * raised — an HTTP 5xx, a request timeout — as a {@link QdrantOperationError}.
   */
  async getPointOrThrow(
    collectionName: string,
    id: string | number,
  ): Promise<{ id: string | number; payload?: Record<string, unknown> } | null> {
    const normalizedId = this.normalizeId(id);
    const points = await this.connection
      .call(async () =>
        this.connection.client.retrieve(collectionName, {
          ids: [normalizedId],
        }),
      )
      .catch((error: unknown) => failPointRead("getPoint", collectionName, error));

    if (points.length === 0) {
      return null;
    }

    return {
      id: points[0].id,
      payload: points[0].payload || undefined,
    };
  }

  /**
   * Points by id with the named payload keys and their DENSE vector (bd
   * tea-rags-mcp-xi2r9, WTO-5): the working tree's dense floor reuses the stored
   * vector of a base point whose content a delta row repeats. A point without a
   * dense vector comes back without `vector`; an id Qdrant does not hold is
   * absent. Every failed read throws an `InfraError`.
   */
  async retrieveDenseVectors(
    collectionName: string,
    ids: readonly (string | number)[],
    payloadInclude: string[],
  ): Promise<{ id: string | number; payload?: Record<string, unknown>; vector?: number[] }[]> {
    if (ids.length === 0) return [];
    const points = await this.connection
      .call(async () =>
        this.connection.client.retrieve(collectionName, {
          ids: ids.map((id) => this.normalizeId(id)),
          with_payload: { include: payloadInclude },
          with_vector: true,
        }),
      )
      .catch((error: unknown) => failPointRead("retrieveDenseVectors", collectionName, error));
    return points.map((point) => {
      const vector = denseVectorOf(point.vector);
      return {
        id: point.id,
        ...(point.payload ? { payload: point.payload } : {}),
        ...(vector ? { vector } : {}),
      };
    });
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
   * Delete every point of many file paths in a few waited requests.
   *
   * On a collection the `relativePathExact` gate serves (bd
   * tea-rags-mcp-ejio7), each request is one keyword MatchAny over up to
   * `RELATIVE_PATHS_PER_KEYWORD_FILTER` paths — index-served at any width. The
   * rest of this docblock is the shape an unserved collection keeps.
   *
   * Uses OR (should) filter to match any of the paths in a group:
   * N files → ceil(N / {@link QdrantPointStore.PATHS_PER_FILTER}) requests.
   *
   * Each branch of the OR is an exact PAIR, not a bare `match.value`: the
   * `relativePath` index is `text`, so a lone value condition is a full
   * collection scan and this filter was N of them inside one request — 33,597 ms
   * for fifty paths on the live self-index (tea-rags-mcp-ivp12).
   *
   * Grouped because one branch per path makes the `should` as wide as the
   * delete set, and ~1000 branches is what returned 500s from embedded Qdrant
   * under concurrent load. This is the L1 fallback — reached exactly when the
   * collection is already struggling — so it is the worst place to send the
   * request that tips it over. Every group waits, since here the delete IS the
   * operation rather than a phase of one.
   *
   * It keeps the grouped shape although the id-collecting scroll of
   * {@link QdrantPointStore.deletePointsByPathsBatched} moved to one pair per
   * request (bd tea-rags-mcp-b4drg): that win was measured on reads only, and
   * a delete-by-filter per path with `wait: true` is a WAL write each — not
   * measured, and not safe to measure against a live collection.
   */
  async deletePointsByPaths(collectionName: string, relativePaths: string[]): Promise<void> {
    if (relativePaths.length === 0) return;
    if (await this.relativePathExact.isServed(collectionName)) {
      for (const group of relativePathExactGroups(relativePaths)) {
        await this.connection.call(async () =>
          this.connection.client.delete(collectionName, { wait: true, filter: relativePathExactFilter(group) }),
        );
      }
      return;
    }
    for (const group of QdrantPointStore.groupPaths(relativePaths)) {
      await this.connection.call(async () =>
        this.connection.client.delete(collectionName, {
          wait: true,
          filter: anyOfOnTextIndexed("relativePath", group),
        }),
      );
    }
  }

  /**
   * PHASE-SEPARATED DELETE: one read pass, parallel writes.
   *
   * Phase 1 (read-only, concurrency 4): on a collection the
   * `relativePathExact` gate serves, one `scroll` per group of up to
   * `RELATIVE_PATHS_PER_KEYWORD_FILTER` paths, a keyword MatchAny (bd
   * tea-rags-mcp-ejio7); otherwise one `scroll` per path, each carrying a
   * single exact text+value pair (bd tea-rags-mcp-b4drg — a wide `should` is
   * ~4x slower). Either way paginated to exhaustion to collect IDs. Pure read —
   * never touches WAL, never competes with upserts, never triggers optimizer
   * repack.
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

    // Phase 1: collect all IDs (read-only).
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

  /**
   * Paths per `should`-of-pairs filter in `deletePointsByPaths` on a collection
   * the `relativePathExact` gate does NOT serve — there it is the only request
   * that addresses a SET of paths in one filter, and the id-collecting scroll
   * sends one pair per request instead (see
   * {@link QdrantPointStore.SCROLL_PATH_CONCURRENCY}). A served collection
   * groups by `RELATIVE_PATHS_PER_KEYWORD_FILTER` and none of the costs below
   * apply to it (bd tea-rags-mcp-ejio7).
   *
   * The shape used to be one MatchAny over the whole set. `relativePath`
   * carries a TEXT index, which serves neither `any` nor `value`, so that
   * single condition was a single FULL COLLECTION SCAN: 706 ms for 50 paths on
   * the live self-index, where the same 50 as text+value pairs cost ~1.35 ms
   * each (tea-rags-mcp-ivp12).
   *
   * The grouped `should` that replaced it is not cheap either. Measured on the
   * taxdome collection (153,598 points) it costs ~6 ms PER BRANCH once it is
   * 200 wide, 3.7 ms per path at 5 branches, ~1 ms for a lone pair: 2716 paths
   * took 22.0-22.6 s in groups of 200 (tea-rags-mcp-b4drg). The earlier claims
   * that a full-scan MatchAny only wins past ~500 paths and that multi-group
   * sets are rare were measured on a 22k-point collection and do not hold at
   * 150k points / thousands of deleted paths.
   *
   * The cap itself still stands: an unbounded `should` is what returned 500s
   * from embedded Qdrant under concurrent load at ~1000 branches, and the
   * fallback is reached exactly when the collection is already struggling.
   * 200 branches (400 conditions) stays inside that.
   */
  private static readonly PATHS_PER_FILTER = 200;

  /**
   * Scroll requests in flight while collecting point ids — one path each on an
   * unserved collection, one keyword group each on a served one.
   *
   * Measured on the taxdome collection (153,598 points, TEXT index on
   * `relativePath`, 2716 paths, 13,928 ids): one pair per request at
   * concurrency 4 took 4.3 s (1.57 ms/path) against 22.0-22.6 s for groups of
   * 200; concurrency 8 gained nothing, and groups of 10 at concurrency 4 took
   * 4.7 s (tea-rags-mcp-b4drg). Reads only — phase 1 never competes with
   * writes. The keyword-group cost is not measured here; it is the reason
   * `relativePathExact` exists (bd tea-rags-mcp-ejio7).
   */
  private static readonly SCROLL_PATH_CONCURRENCY = 4;

  /**
   * The path set as filter-sized groups: a partition, in order, with no empty
   * group — so an empty input yields no request rather than a filter with no
   * condition (which Qdrant matches against every point).
   */
  private static groupPaths(paths: readonly string[]): string[][] {
    const groups: string[][] = [];
    for (let start = 0; start < paths.length; start += QdrantPointStore.PATHS_PER_FILTER) {
      groups.push(paths.slice(start, start + QdrantPointStore.PATHS_PER_FILTER));
    }
    return groups;
  }

  private async collectPointIdsForPaths(collectionName: string, paths: string[]): Promise<(string | number)[]> {
    // A path listed twice would collect its points twice (the old OR-filter
    // matched each point once however often a path was repeated) — both
    // shapes below name each distinct path once.
    const filters = (await this.relativePathExact.isServed(collectionName))
      ? relativePathExactGroups(paths).map((group) => relativePathExactFilter(group))
      : [...new Set(paths)].map((path) => ({ must: exactMatchOnTextIndexed("relativePath", path) }));
    const ids: (string | number)[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < filters.length) {
        const filter = filters[next++];
        ids.push(...(await this.scrollIdsMatching(collectionName, filter)));
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(QdrantPointStore.SCROLL_PATH_CONCURRENCY, filters.length) }, worker),
    );
    return ids;
  }

  /** Every point id one membership filter admits, paged to exhaustion. */
  private async scrollIdsMatching(
    collectionName: string,
    filter: Record<string, unknown>,
  ): Promise<(string | number)[]> {
    const ids: (string | number)[] = [];
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
      const nextOffset = result.next_page_offset;
      offset = typeof nextOffset === "string" || typeof nextOffset === "number" ? nextOffset : undefined;
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
  ): Promise<QdrantUpdateStatus> {
    const normalizedPoints = options.points?.map((id) => this.normalizeId(id));

    const result = await this.connection.call(async () =>
      this.connection.client.setPayload(collectionName, {
        payload,
        points: normalizedPoints,
        filter: options.filter,
        wait: options.wait ?? false,
        ordering: options.ordering ?? "weak",
      }),
    );
    // A waited write answered `wait_timeout` is queued, not applied (wjyaf).
    return foldUpdateStatus(result);
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
  ): Promise<QdrantUpdateStatus> {
    if (operations.length === 0) return "completed";

    const { wait = false, ordering = "weak" } = options;
    let status: QdrantUpdateStatus = "completed";

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

      const results = await this.connection.call(async () =>
        this.connection.client.batchUpdate(collectionName, {
          operations: updateOps,
          wait: isLast ? wait : false,
          ordering,
        }),
      );
      status = foldUpdateStatus(results);
    }
    // The last sub-batch carries the caller's `wait`, so its status is the answer
    // a waited write must read: `wait_timeout` = not yet applied (yf4je).
    return status;
  }

  /**
   * Remove payload keys from explicit points, several key sets per request —
   * the per-point counterpart of {@link deletePayloadKeys}, and the delete half
   * of {@link batchSetPayload}: same `batchUpdate` request shape, same 100-op
   * sub-batches, same `wait` / `ordering` defaults. `keys` are full dotted paths
   * (`git.chunk.ageDays`), which Qdrant resolves into nested payload objects.
   */
  async batchDeletePayload(
    collectionName: string,
    operations: { keys: string[]; points: (string | number)[] }[],
    options: {
      wait?: boolean;
      ordering?: "weak" | "medium" | "strong";
    } = {},
  ): Promise<void> {
    if (operations.length === 0) return;

    const { wait = false, ordering = "weak" } = options;
    const BATCH_SIZE = 100;
    for (let i = 0; i < operations.length; i += BATCH_SIZE) {
      const batch = operations.slice(i, i + BATCH_SIZE);
      const isLast = i + BATCH_SIZE >= operations.length;
      const updateOps = batch.map((op) => ({
        delete_payload: { keys: op.keys, points: op.points.map((id) => this.normalizeId(id)) },
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

  /**
   * Resolve once every update submitted to `collectionName` before this call has
   * been applied, i.e. is visible to reads.
   *
   * A `wait: false` update is acknowledged from the WAL and applied later; a
   * count or scroll issued meanwhile does not see it. Updates apply in submission
   * order, so a `wait: true` update is a barrier on all of them. This one is a
   * `delete_payload` whose filter selects no point (`has_id: []`): sequenced like
   * any update, touching nothing, needing no point to exist.
   *
   * Returns Qdrant's status for the barrier. `wait_timeout` means the server's
   * wait ran out first: the queue is NOT drained, however successful the
   * response looks. Repeating the barrier is the caller's decision (bd
   * tea-rags-mcp-yf4je).
   */
  async awaitQueuedUpdates(collectionName: string): Promise<QdrantUpdateStatus> {
    const results = await this.connection.call(async () =>
      this.connection.client.batchUpdate(collectionName, {
        operations: [{ delete_payload: { keys: [QUEUED_UPDATE_BARRIER_KEY], filter: { must: [{ has_id: [] }] } } }],
        wait: true,
      }),
    );
    return foldUpdateStatus(results);
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
 * Fail a point-read that must not pass for absence: a typed infra failure the
 * connection already classified is kept as it is, and anything the client raised
 * becomes a {@link QdrantOperationError} carrying it as `cause`.
 */
function failPointRead(operation: string, collectionName: string, error: unknown): never {
  if (error instanceof InfraError) throw error;
  const errorData = error as { data?: { status?: { error?: string } }; message?: string } | undefined;
  const errorMessage = errorData?.data?.status?.error || errorData?.message || String(error);
  throw new QdrantOperationError(
    operation,
    `collection "${collectionName}": ${errorMessage}`,
    error instanceof Error ? error : undefined,
  );
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
