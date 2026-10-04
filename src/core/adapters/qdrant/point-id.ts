/**
 * The id a point is stored under (bd tea-rags-mcp-xi2r9).
 *
 * Qdrant accepts only UUIDs and unsigned integers as point ids, while ingest
 * names a chunk `chunk_<hex>` (`generateChunkId`). `QdrantPointStore` maps
 * every id on the way in, and a reader that hands out ids for rows it built
 * itself — the working-tree overlay's delta rows — must map them the SAME way:
 * otherwise the id it returns addresses no point, and `find_similar` answered
 * such an id with a 400 Bad Request instead of a not-found. One function, so
 * the write path and every reader cannot disagree on the mapping.
 *
 * A UUID and a number pass through unchanged, which makes the mapping
 * idempotent: an id that already went through it is never mapped twice.
 */

import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A deterministic UUID-shaped id for `id`: sha256-derived for any non-UUID string. */
export function toQdrantPointId(id: string | number): string | number {
  if (typeof id === "number" || UUID.test(id)) return id;
  const hash = createHash("sha256").update(id).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
