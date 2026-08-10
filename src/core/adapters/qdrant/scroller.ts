/**
 * Enumeration rather than ranking: the five ways tea-rags walks points it has
 * not scored — full traversal with vectors, one payload field's distinct values,
 * an ordered window, a filtered page-through, and an exact symbolId set.
 *
 * They are one concern because they share the pagination contract every Qdrant
 * scroll has and no other call does: drive `next_page_offset` in a loop until
 * the server stops handing one back, and decide per call how much of the payload
 * to materialize. That second decision is the reason these are five methods and
 * not one — a recovery traversal reading three scalar keys across tens of
 * thousands of chunks and a migration traversal that needs the vectors have
 * opposite cost profiles, and collapsing them behind one signature would force
 * the expensive shape on both.
 *
 * `QdrantPointStore.deletePointsByPathsBatched` runs a scroll of its own; it
 * stays there because it is phase 1 of a delete, not a read anyone can ask for.
 */

import type { QdrantConnection } from "./connection.js";
import { QdrantOperationError, QdrantUnavailableError } from "./errors.js";

export class QdrantScroller {
  constructor(private readonly connection: QdrantConnection) {}

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
      const result = await this.connection.call(async () =>
        this.connection.client.scroll(collectionName, {
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
      const result = await this.connection.call(async () =>
        this.connection.client.scroll(collectionName, {
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
      const result = await this.connection.call(async () =>
        this.connection.client.scroll(collectionName, {
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
   *
   * `payloadInclude` narrows the returned payload to the listed keys (Qdrant
   * include-selector) — full-collection traversals (enrichment recovery) read
   * three scalar keys per point; materializing `content` for tens of thousands
   * of chunks would cost hundreds of MB for nothing.
   */
  async scrollFiltered(
    collectionName: string,
    filter: Record<string, unknown>,
    limit: number,
    pageSize?: number,
    payloadInclude?: string[],
  ): Promise<{ id: string | number; payload: Record<string, unknown> }[]> {
    const results: { id: string | number; payload: Record<string, unknown> }[] = [];
    const effectivePageSize = pageSize ? Math.min(pageSize, limit) : Math.min(limit, 200);
    let offset: string | number | undefined = undefined;

    do {
      const result = await this.connection.call(async () =>
        this.connection.client.scroll(collectionName, {
          limit: effectivePageSize,
          with_payload: payloadInclude ? { include: payloadInclude } : true,
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

  /**
   * Fetch chunk payloads for an exact set of symbolIds in one scroll, using a
   * `should` (OR) filter of exact-match conditions. Used by trace_path to
   * hydrate each path step with its relativePath / line range / git+codegraph
   * signals. Empty input short-circuits to [] (no query). Result order is not
   * guaranteed — callers index by `payload.symbolId`.
   */
  async scrollBySymbolIds(
    collectionName: string,
    symbolIds: string[],
    limit = 1024,
  ): Promise<{ id: string | number; payload: Record<string, unknown> }[]> {
    if (symbolIds.length === 0) return [];
    const filter = {
      should: symbolIds.map((id) => ({ key: "symbolId", match: { value: id } })),
    };
    return this.scrollFiltered(collectionName, filter, limit);
  }
}
