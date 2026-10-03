/**
 * WorkingTreeRowCache (WTO unbounded delta) — the in-memory rows of tree
 * files, bounded by the bytes of the rows' content rather than by a file
 * count: a delta has no file cap any more, so a count bound no longer bounds
 * memory. The least recently used entry is evicted first; an entry larger than
 * the whole bound is not held at all.
 */

import { ByteBoundedLru } from "../../../infra/byte-bounded-lru.js";
import type { ScrollChunk } from "../chunk-grouping/types.js";

/** Default bound of one row cache: 64 MB of row content. */
export const WORKING_TREE_ROW_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/** UTF-8 bytes of the content the rows carry — what a row cache is bounded by. */
export function workingTreeRowBytes(rows: readonly ScrollChunk[]): number {
  let bytes = 0;
  for (const row of rows) {
    const { content } = row.payload;
    if (typeof content === "string") bytes += Buffer.byteLength(content, "utf8");
  }
  return bytes;
}

/** A {@link ByteBoundedLru} whose bound defaults to {@link WORKING_TREE_ROW_CACHE_MAX_BYTES}. */
export class WorkingTreeRowCache<V> extends ByteBoundedLru<V> {
  constructor(maxBytes: number = WORKING_TREE_ROW_CACHE_MAX_BYTES) {
    super(maxBytes);
  }
}
